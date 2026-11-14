import type { DataSource, RegionRow } from './dataSource';

type Series = 'long' | 'detail';
type RType = 'country' | 'gfed';
type Col = 'name' | 'v' | 'med' | 'ratio' | 'pct' | 'sig';

interface Row {
  id: string;
  name: string;
  v: number;
  lo: number;
  hi: number;
  med: number;
  ratio: number; // NaN when the usual value is 0
  pct: number; // share of the other years below this one, 0-100
  sig: -1 | 0 | 1; // interval below / around / above the usual value
}

const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ORIGIN = ['measured by Aqua MODIS', 'converted from VIIRS to Aqua-equivalent', 'VIIRS 375 m at S-NPP level'];
const SERIES_START: Record<Series, string> = { long: '2003-01', detail: '2013-01' };
const SIG = ['Below usual', 'Within usual', 'Above usual'];
const fmt = (v: number) => Math.round(v).toLocaleString('en');
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface TablePanelOptions {
  data: DataSource;
  /** A row was chosen: show that region on the globe with its calendar. */
  onPick: (type: RType, id: string, name: string) => void;
}

/**
 * Table view: the harmonized series by country or GFED region for the month on the time slider, against the
 * same month in the other years (median, ratio, rank), with the 90% interval to tell real changes from noise.
 */
export function createTablePanel(o: TablePanelOptions) {
  const el = document.createElement('section');
  el.className = 'panel tablepanel';
  el.hidden = true;
  el.innerHTML = `
    <header class="tb-head">
      <h2 class="tb-title">Fire activity by region</h2>
      <div class="tb-ctrl">
        <select data-c="series" aria-label="Series">
          <option value="long">Long-term, Aqua-equivalent (2003+)</option>
          <option value="detail">Detail, VIIRS 375 m (2013+)</option>
        </select>
        <select data-c="type" aria-label="Regions">
          <option value="country">Countries</option>
          <option value="gfed">GFED regions</option>
        </select>
        <input data-c="filter" type="search" placeholder="Filter by name" aria-label="Filter by name" />
        <button type="button" data-a="csv">CSV</button>
      </div>
    </header>
    <p class="note tb-note"></p>
    <div class="tb-wrap">
      <table>
        <thead><tr>
          <th data-k="name" class="tb-name">Region</th>
          <th data-k="v" title="Harmonized monthly fire detections">Detections</th>
          <th class="tb-int" title="90% interval of the harmonized value">90% interval</th>
          <th data-k="med" title="Median of the same month in the other years">Usual</th>
          <th data-k="ratio" title="This month divided by the usual value">vs usual</th>
          <th data-k="pct" class="tb-pct" title="Share of the other years with fewer detections in this month">Rank</th>
          <th data-k="sig" title="Above or below usual when the 90% interval excludes the usual value">Signal</th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <p class="note">Click a row to see that region on the globe with its fire calendar. Harmonized series only: raw per-sensor values are on the globe.</p>`;
  document.body.appendChild(el);

  const $ = <T extends HTMLElement>(s: string) => el.querySelector(s) as T;
  const seriesSel = $<HTMLSelectElement>('[data-c=series]');
  const typeSel = $<HTMLSelectElement>('[data-c=type]');
  const filterIn = $<HTMLInputElement>('[data-c=filter]');
  const tbody = $<HTMLTableSectionElement>('tbody');
  const noteEl = $<HTMLParagraphElement>('.tb-note');
  const titleEl = $<HTMLHeadingElement>('.tb-title');

  let month = ''; // YYYY-MM
  let rows: Row[] = [];
  let sortKey: Col = 'v';
  let sortDesc = true;
  let req = 0;
  let gfedNames: Record<string, string> = {};
  fetch(`${import.meta.env.BASE_URL}regions_gfed.json`)
    .then((r) => (r.ok ? r.json() : undefined))
    .then((j: { regions: { code: string; name: string }[] } | undefined) => {
      gfedNames = Object.fromEntries((j?.regions ?? []).map((g) => [g.code, g.name]));
      if (typeSel.value === 'gfed') render();
    })
    .catch(() => undefined);
  // Per calendar month, the rows of every year: re-used when only the year changes.
  const cache = new Map<string, Promise<RegionRow[]>>();

  function compute(all: RegionRow[]): { rows: Row[]; origin: number | undefined } {
    const years = [...new Set(all.map((r) => r[1]))].sort();
    const byId = new Map<string, Map<string, RegionRow>>();
    for (const r of all) {
      if (!byId.has(r[0])) byId.set(r[0], new Map());
      byId.get(r[0])!.set(r[1], r);
    }
    const origins = new Map<number, number>();
    const out: Row[] = [];
    for (const [id, m] of byId) {
      const cur = m.get(month);
      if (cur) origins.set(cur[5], (origins.get(cur[5]) ?? 0) + 1);
      // A region without a row in a month had no detections then.
      const v = cur?.[2] ?? 0;
      const others = years.filter((y) => y !== month).map((y) => m.get(y)?.[2] ?? 0).sort((a, b) => a - b);
      const k = others.length;
      const med = k ? (k % 2 ? others[(k - 1) / 2] : (others[k / 2 - 1] + others[k / 2]) / 2) : 0;
      const below = others.filter((x) => x < v).length + 0.5 * others.filter((x) => x === v).length;
      const lo = cur?.[3] ?? 0;
      const hi = cur?.[4] ?? 0;
      out.push({
        id,
        name: id,
        v,
        lo,
        hi,
        med,
        ratio: med > 0 ? v / med : NaN,
        pct: k ? (100 * below) / k : NaN,
        sig: !cur ? (med > 0 ? -1 : 0) : lo > med ? 1 : hi < med ? -1 : 0,
      });
    }
    const origin = [...origins.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return { rows: out, origin };
  }

  async function load() {
    if (!month || el.hidden) return;
    const series = seriesSel.value as Series;
    const type = typeSel.value as RType;
    const my = ++req;
    if (month < SERIES_START[series]) {
      rows = [];
      noteEl.textContent = `The ${series === 'long' ? 'long-term' : 'detail'} series starts in ${SERIES_START[series]}: move the time slider to a later month.`;
      return render();
    }
    noteEl.textContent = 'Loading...';
    const key = `${series}/${type}/${month.slice(5, 7)}`;
    if (!cache.has(key)) cache.set(key, o.data.regions(series, type, Number(month.slice(5, 7))));
    try {
      const all = await cache.get(key)!;
      if (my !== req) return;
      const c = compute(all);
      rows = c.rows;
      const have = all.some((r) => r[1] === month);
      const yrs = new Set(all.map((r) => r[1])).size;
      noteEl.textContent = !have
        ? `No harmonized data for ${month} yet.`
        : `${series === 'long' ? 'Aqua-equivalent' : 'VIIRS S-NPP-level'} detections per month, ${c.origin !== undefined ? ORIGIN[c.origin] : ''}. ` +
          `"Usual" is the median of ${MON[Number(month.slice(5, 7)) - 1]} in the other ${yrs - 1} years. ` +
          `${series === 'long' ? 'The 90% interval is the uncertainty of the conversion.' : 'The 90% interval is the spread between VIIRS satellites.'}`;
      render();
    } catch (err) {
      cache.delete(key);
      noteEl.textContent = `Could not load the table: ${(err as Error).message}`;
    }
  }

  function nameOf(r: Row) {
    return typeSel.value === 'gfed' ? `${gfedNames[r.id] ?? r.id} (${r.id})` : r.id;
  }

  function sorted(): Row[] {
    const f = filterIn.value.trim().toLowerCase();
    const list = rows.map((r) => ({ ...r, name: nameOf(r) })).filter((r) => !f || r.name.toLowerCase().includes(f));
    const val = (r: Row) => (sortKey === 'name' ? r.name : r[sortKey]);
    return list.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (typeof x === 'string') return sortDesc ? (y as string).localeCompare(x) : x.localeCompare(y as string);
      // NaN (no usual value) always last
      if (Number.isNaN(x)) return 1;
      if (Number.isNaN(y as number)) return -1;
      return sortDesc ? (y as number) - x : x - (y as number);
    });
  }

  function render() {
    const [y, m] = month.split('-');
    titleEl.textContent = month ? `Fire activity by region, ${MON[Number(m) - 1]} ${y}` : 'Fire activity by region';
    for (const th of el.querySelectorAll<HTMLTableCellElement>('th[data-k]')) {
      const on = th.dataset.k === sortKey;
      th.setAttribute('aria-sort', on ? (sortDesc ? 'descending' : 'ascending') : 'none');
    }
    const list = sorted();
    tbody.innerHTML = list
      .map(
        (r) => `<tr data-id="${esc(r.id)}" tabindex="0">
          <td class="tb-name">${esc(r.name)}</td>
          <td>${fmt(r.v)}</td>
          <td class="tb-int">${r.hi > 0 ? `${fmt(r.lo)} - ${fmt(r.hi)}` : '-'}</td>
          <td>${fmt(r.med)}</td>
          <td>${Number.isNaN(r.ratio) ? '-' : `${r.ratio >= 10 ? r.ratio.toFixed(0) : r.ratio.toFixed(1)}x`}</td>
          <td class="tb-pct">${Number.isNaN(r.pct) ? '-' : `${Math.round(r.pct)}%`}</td>
          <td class="sig${r.sig}">${SIG[r.sig + 1]}</td>
        </tr>`,
      )
      .join('');
  }

  function csv() {
    const head = 'region,month,series,detections,lo90,hi90,usual_median_other_years,ratio_to_usual,percentile_vs_other_years,signal';
    const lines = sorted().map((r) =>
      [`"${r.name.replace(/"/g, '""')}"`, month, seriesSel.value, r.v.toFixed(2), r.lo.toFixed(2), r.hi.toFixed(2), r.med.toFixed(2),
        Number.isNaN(r.ratio) ? '' : r.ratio.toFixed(3), Number.isNaN(r.pct) ? '' : r.pct.toFixed(1), SIG[r.sig + 1]].join(','),
    );
    const meta = `# harmonized MODIS/VIIRS fire detections by ${typeSel.value === 'gfed' ? 'GFED region' : 'country'}; source: NASA FIRMS, Fire Globe`;
    const blob = new Blob([[meta, head, ...lines].join('\n') + '\n'], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fire_regions_${seriesSel.value}_${typeSel.value}_${month}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  el.querySelector('thead')!.addEventListener('click', (e) => {
    const k = (e.target as HTMLElement).closest<HTMLTableCellElement>('th')?.dataset.k as Col | undefined;
    if (!k) return;
    sortDesc = k === sortKey ? !sortDesc : k !== 'name';
    sortKey = k;
    render();
  });
  const pick = (tr: HTMLTableRowElement | null) => {
    const r = rows.find((x) => x.id === tr?.dataset.id);
    if (r) o.onPick(typeSel.value as RType, r.id, typeSel.value === 'gfed' ? gfedNames[r.id] ?? r.id : r.id);
  };
  tbody.addEventListener('click', (e) => pick((e.target as HTMLElement).closest('tr')));
  tbody.addEventListener('keydown', (e) => e.key === 'Enter' && pick((e.target as HTMLElement).closest('tr')));
  seriesSel.onchange = () => void load();
  typeSel.onchange = () => void load();
  filterIn.oninput = render;
  $<HTMLButtonElement>('[data-a=csv]').onclick = csv;

  return {
    get visible() {
      return !el.hidden;
    },
    show(on: boolean) {
      el.hidden = !on;
      if (on) void load();
    },
    /** Follow the time slider (YYYY-MM or YYYY-MM-DD). */
    select(key: string) {
      const m = key.slice(0, 7);
      if (m === month) return;
      month = m;
      void load();
    },
  };
}
