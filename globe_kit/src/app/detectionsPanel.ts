import * as Cesium from 'cesium';
import type { DetectionRecord } from './detail';
import { fmtFixed, fmtInt, t, tn } from './i18n';

const TEXT = {
  title: t('det.title'),
  close: t('det.close'),
  csv: t('det.csv'),
  empty: t('det.empty'),
  shown: (n: number, total: number) => (n < total ? t('det.strongestOf', { n: fmtInt(n), total: fmtInt(total) }) : tn('det.count', total)),
  hint: t('det.hint'),
  cols: [t('det.col.date'), t('det.col.utc'), t('det.col.sat'), t('det.col.frp'), t('det.col.conf'), t('det.col.pass'), t('det.col.pos')],
  day: t('det.day'),
  night: t('det.night'),
  conf: { low: t('det.conf.low'), nominal: t('det.conf.nominal'), high: t('det.conf.high') },
};

export interface DetectionsPanelOptions {
  viewer: Cesium.Viewer;
  list: (limit?: number) => { rows: DetectionRecord[]; total: number };
  highlight: (r: DetectionRecord | undefined) => void;
}

const hhmm = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60) % 60).padStart(2, '0')}`;

/** Popup listing the single detections loaded for the current view, linked to the globe by hover and click. */
export function createDetectionsPanel(o: DetectionsPanelOptions) {
  const el = document.createElement('aside');
  el.className = 'panel calpanel detpanel';
  el.hidden = true;
  el.setAttribute('aria-label', TEXT.title);
  el.innerHTML = `
    <header class="cal-head"><h2>${TEXT.title}</h2>
      <span class="det-actions"><button type="button" data-a="csv">${TEXT.csv}</button>
      <button type="button" class="cal-x" aria-label="${TEXT.close}">&times;</button></span></header>
    <p class="note det-count"></p>
    <div class="det-wrap"><table><thead><tr>${TEXT.cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody></tbody></table></div>
    <p class="note">${TEXT.hint}</p>`;
  document.body.appendChild(el);
  const tbody = el.querySelector('tbody')!;
  const countEl = el.querySelector<HTMLParagraphElement>('.det-count')!;
  let rows: DetectionRecord[] = [];

  function refresh() {
    if (el.hidden) return;
    const r = o.list();
    rows = r.rows;
    countEl.textContent = r.total ? TEXT.shown(rows.length, r.total) : TEXT.empty;
    tbody.innerHTML = rows
      .map(
        (d, i) => `<tr data-i="${i}" tabindex="0">
          <td>${d.date}</td><td>${hhmm(d.hourUtc)}</td><td>${d.satellite}</td><td>${fmtFixed(d.frp, 1)}</td>
          <td>${TEXT.conf[d.confidence]}</td><td>${d.night ? TEXT.night : TEXT.day}</td><td>${d.lat.toFixed(3)}, ${d.lon.toFixed(3)}</td></tr>`,
      )
      .join('');
  }

  const rowOf = (e: Event) => rows[Number((e.target as HTMLElement).closest('tr')?.dataset.i ?? -1)];
  tbody.addEventListener('mouseover', (e) => o.highlight(rowOf(e)));
  tbody.addEventListener('focusin', (e) => o.highlight(rowOf(e)));
  tbody.addEventListener('mouseleave', () => o.highlight(undefined));
  const fly = (r: DetectionRecord | undefined) => {
    if (!r) return;
    o.highlight(r);
    o.viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 25_000), duration: 1.2 });
  };
  tbody.addEventListener('click', (e) => fly(rowOf(e)));
  tbody.addEventListener('keydown', (e) => e.key === 'Enter' && fly(rowOf(e)));
  el.querySelector<HTMLButtonElement>('.cal-x')!.onclick = () => panel.toggle(false);
  el.querySelector<HTMLButtonElement>('[data-a=csv]')!.onclick = () => {
    const full = o.list(Infinity); // every loaded detection after the filters, not only the listed ones
    const head = 'acq_date,acq_time_utc,satellite,frp_mw,confidence,daynight,latitude,longitude';
    const lines = full.rows.map((d) =>
      [d.date, hhmm(d.hourUtc).replace(':', ''), d.satellite, d.frp.toFixed(2), d.confidence, d.night ? 'N' : 'D', d.lat.toFixed(5), d.lon.toFixed(5)].join(','),
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([[head, ...lines].join('\n') + '\n'], { type: 'text/csv' }));
    a.download = 'detections_in_view.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const panel = {
    get visible() {
      return !el.hidden;
    },
    toggle(on?: boolean) {
      el.hidden = on === undefined ? !el.hidden : !on;
      if (el.hidden) o.highlight(undefined);
      else refresh();
      return !el.hidden;
    },
    /** New data or filters: rebuild the list if open. */
    refresh,
  };
  return panel;
}
