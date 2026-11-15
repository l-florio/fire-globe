import { mountAppBar } from './appBar';
import { applyI18n, t, type Key } from './i18n';
import './tablePage.css';
import './aboutPage.css';

// About page: notes, credits, clarifications and licences. No Cesium, no data loading.
mountAppBar({ current: 'about' });
applyI18n();
document.title = t('about.title');

const link = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
const p = (k: Key) => `<p>${t(k)}</p>`;
const ul = (items: string[]) => `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
const keys = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => t(`${prefix}${i + 1}` as Key));

const SOURCES: [string, string, Key][] = [
  ['NASA FIRMS', 'https://firms.modaps.eosdis.nasa.gov/', 'about.src.firms'],
  ['NASA GIBS', 'https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api', 'about.src.gibs'],
  ['Esri', 'https://www.esri.com/', 'about.src.esri'],
  ['OpenStreetMap contributors', 'https://www.openstreetmap.org/copyright', 'about.src.osm'],
  ['Natural Earth', 'https://www.naturalearthdata.com/', 'about.src.ne'],
];
const LIBS: [string, string, string, string][] = [
  ['CesiumJS', '1.147.0', 'Apache-2.0', 'https://cesium.com/platform/cesiumjs/'],
  ['DuckDB-WASM', '1.32.0', 'MIT', 'https://duckdb.org/'],
  ['Tabulator', '6.7.1', 'MIT', 'https://tabulator.info/'],
  ['Chart.js', '4.6.1', 'MIT', 'https://www.chartjs.org/'],
  ['CodeMirror 6', '', 'MIT', 'https://codemirror.net/'],
  ['html-to-image', '1.11.13', 'MIT', 'https://github.com/bubkoo/html-to-image'],
  ['Vite', '', 'MIT', 'https://vite.dev/'],
];

document.getElementById('about-main')!.innerHTML = `
  <h1>${t('about.h1')}</h1>
  <section><h2>${t('about.what.h')}</h2>${p('about.what.p1')}${p('about.what.p2')}</section>
  <section><h2>${t('about.start.h')}</h2><ol>${keys('about.start.', 6).map((s) => `<li>${s}</li>`).join('')}</ol></section>
  <section><h2>${t('about.src.h')}</h2>
    ${ul([
      ...SOURCES.map(([name, href, k]) => `${link(href, name)}: ${t(k)}`),
      t('about.src.gfed'),
      t('about.src.gfed5'),
    ])}
    ${p('about.src.note')}
  </section>
  <section><h2>${t('about.method.h')}</h2>${ul(keys('about.m.', 7))}</section>
  <section><h2>${t('about.val.h')}</h2>${p('about.val.intro')}${ul(keys('about.v.', 5))}
    <h3>${t('about.lim.h')}</h3>${ul(keys('about.l.', 4))}
  </section>
  <section><h2>${t('about.lic.h')}</h2>${p('about.lic.project')}
    <p>${t('about.lic.libs')}</p>
    ${ul(LIBS.map(([name, v, lic, href]) => `${link(href, name)}${v ? ` ${v}` : ''} (${lic})`))}
    ${p('about.lic.insp')}
  </section>
  <section><h2>${t('about.ai.h')}</h2>${p('about.ai.p')}</section>`;
