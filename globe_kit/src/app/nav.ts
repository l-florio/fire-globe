/**
 * Navigation between the two pages of the build: the globe (index.html) and the data table (table.html).
 * Links are relative to the site base (the site lives under a sub-path on GitHub Pages) and carry ?lang= when set.
 */
const GLOBE_HASH = 'fireglobe.globeHash';

function pageUrl(page: 'index.html' | 'table.html', hash: string): string {
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

/** Table page -> globe page in the state it was left. */
export const openGlobe = () => location.assign(pageUrl('index.html', storedGlobeHash()));

/** Table page -> globe page with the calendar open on a region (GFED code) or country (name). */
export function openRegionOnGlobe(type: 'country' | 'gfed', id: string, name: string) {
  const hash = type === 'gfed' ? `cal=1&area=region:g:${id}` : `cal=1&q=${encodeURIComponent(name)}`;
  location.assign(pageUrl('index.html', hash));
}
