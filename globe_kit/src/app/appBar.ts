import { LANG_GROUPS, LANG_NAMES, lang, langShort, setLang, t, type Lang } from './i18n';
import { mountA11yMenu } from './a11yMenu';
import { aboutHref, climatologyPageHref, globeHref, openClimatology, openGlobe, openTable, tableHref } from './nav';
import './appBar.css';

export type AppPage = 'globe' | 'table' | 'climatology' | 'about';

export interface AppBarOptions {
  current: AppPage;
  /** Called before leaving the current page through the bar (the globe stores its state here). */
  beforeLeave?: () => void;
  /** Period (YYYY-MM or YYYY-MM-DD) handed to the table and climatology pages, when the current page has one. */
  timeKey?: () => string;
}


/**
 * The one top bar of every page: view tabs (left), logo (centre), About link, accessibility slot and language
 * select (right). Inserted as the first element of <body>; the page content starts below it (--bar-h).
 */
export function mountAppBar(o: AppBarOptions): HTMLElement {
  const bar = document.createElement('header');
  bar.id = 'app-bar';
  // timeKey may point at a slider that does not exist yet when the bar is mounted.
  const timeKey = () => {
    try {
      return o.timeKey?.() ?? '';
    } catch {
      return '';
    }
  };
  const climHash = () => {
    const k = timeKey();
    return /^\d{4}-\d{2}(-\d{2})?$/.test(k) ? `t=${k}` : '';
  };
  const tabs: { id: Exclude<AppPage, 'about'>; label: string; title?: string; go: () => void; href: () => string }[] = [
    { id: 'globe', label: t('view.globe'), go: openGlobe, href: globeHref },
    {
      id: 'table',
      label: t('view.table'),
      title: t('view.table.title'),
      go: () => openTable(timeKey()),
      href: () => tableHref(timeKey()),
    },
    {
      id: 'climatology',
      label: t('view.climatology'),
      title: t('view.climatology.title'),
      go: () => openClimatology(climHash()),
      href: () => climatologyPageHref(climHash()),
    },
  ];
  // Icons stand in for the labels on narrow screens (the label stays as the accessible name).
  const ICONS: Record<string, string> = {
    globe: '<circle cx="8" cy="8" r="6.5"/><ellipse cx="8" cy="8" rx="2.8" ry="6.5"/><path d="M1.5 8h13"/>',
    table: '<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M1.5 6.2h13M1.5 9.8h13M6 2.5v11"/>',
    climatology: '<path d="M1.5 13.5h13"/><path d="M2 10.5c2-1 3-5 5-5s3 3 4.5 2.5S13.5 4 14 3.5"/>',
  };
  const tabHtml = tabs
    .map(
      (x) =>
        `<a id="tab-${x.id}" href="${x.href()}"${o.current === x.id ? ' aria-current="page"' : ''}${x.title ? ` title="${x.title}"` : ` title="${x.label}"`}><svg class="vt-ico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4">${ICONS[x.id]}</svg><span class="vt-txt">${x.label}</span></a>`,
    )
    .join('');
  const logo = `${import.meta.env.BASE_URL}logo.svg`;
  bar.innerHTML =
    `<nav class="ab-left" aria-label="${t('bar.nav.aria')}"><div id="view-tabs">${tabHtml}</div></nav>` +
    `<a class="ab-logo" id="app-logo" href="${globeHref()}"><img src="${logo}" alt="Fire Globe" width="59" height="32" /></a>` +
    `<div class="ab-right"><a class="ab-about" id="about-link" href="${aboutHref()}" title="${t('bar.about.title')}"${o.current === 'about' ? ' aria-current="page"' : ''}>${t('bar.about')}</a>` +
    `<span id="a11y-slot" class="ab-slot"></span>` +
    `<select id="lang" class="lang-sel" aria-label="${t('lang.label')}" title="${t('lang.label')}">${(Object.entries(LANG_GROUPS) as [keyof typeof LANG_GROUPS, readonly Lang[]][]).map(([g, ls]) => `<optgroup label="${t(`lang.group.${g}`)}">${ls.map((l) => `<option value="${l}" title="${LANG_NAMES[l]}">${langShort(l)}</option>`).join('')}</optgroup>`).join('')}</select></div>`;
  document.body.prepend(bar);
  mountA11yMenu(bar.querySelector<HTMLElement>('#a11y-slot')!);

  // Views are real links (open in a new tab works); a plain click keeps the state hand-over of the app.
  for (const x of tabs) {
    const a = bar.querySelector<HTMLAnchorElement>(`#tab-${x.id}`)!;
    const refresh = () => (a.href = x.href()); // the period and the globe state change while the page is in use
    for (const ev of ['pointerenter', 'focus', 'contextmenu'] as const) a.addEventListener(ev, refresh);
    a.addEventListener('click', (e) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) {
        if (e.button === 0) o.beforeLeave?.();
        return;
      }
      e.preventDefault();
      if (o.current === x.id) return;
      o.beforeLeave?.();
      x.go();
    });
  }
  const logoEl = bar.querySelector<HTMLAnchorElement>('#app-logo')!;
  logoEl.addEventListener('click', (e) => {
    if (o.current === 'globe') e.preventDefault(); // already there: keep the view as it is
    else o.beforeLeave?.();
  });
  bar.querySelector<HTMLAnchorElement>('#about-link')!.addEventListener('click', () => {
    if (o.current !== 'about') o.beforeLeave?.();
  });
  const sel = bar.querySelector<HTMLSelectElement>('#lang')!;
  sel.value = lang;
  sel.onchange = () => setLang(sel.value as Lang);
  // Compact when closed (EN, IT, ...), language names while the list is open.
  const label = (long: boolean) => {
    for (const op of sel.options) op.textContent = long ? LANG_NAMES[op.value as Lang] : langShort(op.value as Lang);
  };
  sel.addEventListener('mousedown', () => label(true));
  sel.addEventListener('touchstart', () => label(true), { passive: true });
  sel.addEventListener('blur', () => label(false));
  sel.addEventListener('change', () => label(false));
  return bar;
}
