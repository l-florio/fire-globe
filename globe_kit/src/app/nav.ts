/**
 * Navigation between the pages of the build: the globe (index.html), the data table (table.html) and the climatology (climatology.html).
 * Links are relative to the site base (the site lives under a sub-path on GitHub Pages) and carry ?lang= when set.
 */
const GLOBE_HASH = 'fireglobe.globeHash';

type Page = 'index.html' | 'table.html' | 'climatology.html';

function pageUrl(page: Page, hash: string): string {
  const url = new URL(`${import.meta.env.BASE_URL}${page}`, location.href);
  const lang = new URLSearchParams(location.search).get('lang');
  if (lang) url.searchParams.set('lang', lang);
  url.hash = hash;
  return url.href;
}

/** Remember the globe's state (its URL hash) so that "Globe" in the table page returns to it. */
export function storeGlobeHash(hash: string) {
  try {
    sessionStorage.setItem(GLOBE_HASH, hash);
  } catch {
    /* storage blocked: the globe then opens in its default state */
  }
}

function storedGlobeHash(): string {
  try {
    return sessionStorage.getItem(GLOBE_HASH) ?? '';
  } catch {
    return '';
  }
}

/** Globe page -> table page, carrying the period (YYYY-MM or YYYY-MM-DD) of the time slider. */
export const openTable = (timeKey: string) => location.assign(pageUrl('table.html', `t=${timeKey}`));

/** Any page -> climatology page; `hash` e.g. `area=region:c:EU&t=2026-11-01` (see climatologyPage.ts). */
export const openClimatology = (hash = '') => location.assign(pageUrl('climatology.html', hash));

/** Link to the climatology page for an area spec (`region:c:EU`, `region:g:EURO`, `country:<English name>`). */
export const climatologyHref = (area: string) => pageUrl('climatology.html', `area=${area}`);

/** Table / climatology page -> globe page in the state it was left. */
export const openGlobe = () => location.assign(pageUrl('index.html', storedGlobeHash()));

/** Table page -> globe page with the calendar open on a region (GFED code) or country (name). */
export function openRegionOnGlobe(type: 'country' | 'gfed', id: string, name: string) {
  const hash = type === 'gfed' ? `cal=1&area=region:g:${id}` : `cal=1&q=${encodeURIComponent(name)}`;
  location.assign(pageUrl('index.html', hash));
}
