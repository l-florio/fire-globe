import type { Catalog, DatasetDef, Opt, Scope } from './datasets';
import { field, h, select } from './util';

const TEXT = {
  dataset: 'Dataset',
  series: 'Series',
  regionType: 'Regions',
  sensor: 'Sensor',
  from: 'From',
  to: 'To',
  monthFmt: 'YYYY-MM',
  dateFmt: 'YYYY-MM-DD',
  bbox: 'Area (degrees)',
  west: 'West',
  south: 'South',
  east: 'East',
  north: 'North',
  fixed: 'Month on the time slider: {m}',
  noMonth: 'Move the time slider to choose a month.',
  optional: '(optional)',
} as const;

const DEFAULT_MONTH = '2024-01';

function lastDay(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

export interface ScopeForm {
  el: HTMLElement;
  dataset(): DatasetDef;
  scope(): Scope;
  /** The month on the time slider (YYYY-MM). */
  setMonth(month: string): void;
}

export function createScopeForm(cat: Catalog, onChange: () => void): ScopeForm {
  let month = '';
  const scope: Scope = { series: 'long', rt: 'country', sensor: '', from: '', to: '', bbox: ['', '', '', ''] };
  let ds = cat.datasets[0];

  const dsSel = select(cat.datasets.map((d) => [d.id, d.label] as Opt));
  const seriesSel = select([]);
  const rtSel = select([]);
  const sensorSel = select([]);
  const fromIn = h('input', { type: 'month' });
  const toIn = h('input', { type: 'month' });
  const box = (label: string) => h('input', { type: 'number', step: 'any', 'aria-label': label, placeholder: label });
  const bboxIn = [box(TEXT.west), box(TEXT.south), box(TEXT.east), box(TEXT.north)];
  const doc = h('p', { class: 'ex-note' });
  const fixedNote = h('p', { class: 'ex-note ex-fixed' });

  const seriesF = field(TEXT.series, seriesSel);
  const rtF = field(TEXT.regionType, rtSel);
  const sensorF = field(TEXT.sensor, sensorSel);
  const fromF = field(TEXT.from, fromIn);
  const toF = field(TEXT.to, toIn);
  const bboxF = h('fieldset', { class: 'ex-bbox' }, h('legend', {}, TEXT.bbox), ...bboxIn);
  const row = h('div', { class: 'ex-row' }, seriesF, rtF, sensorF, fromF, toF);
  const el = h('div', { class: 'ex-scope' }, field(TEXT.dataset, dsSel, 'ex-grow'), row, bboxF, fixedNote, doc);

  const setOptions = (sel: HTMLSelectElement, opts: Opt[] | undefined, current: string) => {
    sel.replaceChildren(...(opts ?? []).map(([v, l]) => h('option', { value: v }, l)));
    const ok = opts?.some(([v]) => v === current);
    sel.value = ok ? current : (opts?.[0]?.[0] ?? '');
    return sel.value;
  };

  function applyPeriod() {
    const p = ds.spec.period;
    const base = month || DEFAULT_MONTH;
    if (p === 'fixed') {
      scope.from = month;
      scope.to = month;
    } else if (p === 'month') {
      scope.from = scope.from.slice(0, 7) || (ds.spec.periodRequired ? base : '');
      scope.to = scope.to.slice(0, 7) || (ds.spec.periodRequired ? base : '');
    } else if (p === 'date') {
      scope.from = scope.from.length === 10 ? scope.from : `${scope.from.slice(0, 7) || base}-01`.slice(0, 10);
      scope.to = scope.to.length === 10 ? scope.to : lastDay(scope.to.slice(0, 7) || base);
    }
    const type = p === 'date' ? 'date' : 'month';
    for (const i of [fromIn, toIn]) {
      i.type = type;
      i.placeholder = type === 'date' ? TEXT.dateFmt : TEXT.monthFmt;
    }
    fromIn.value = scope.from;
    toIn.value = scope.to;
    fixedNote.textContent = month ? TEXT.fixed.replace('{m}', month) : TEXT.noMonth;
  }

  function applyDataset() {
    ds = cat.datasets.find((d) => d.id === dsSel.value) ?? cat.datasets[0];
    const s = ds.spec;
    scope.series = setOptions(seriesSel, s.series, scope.series);
    scope.rt = setOptions(rtSel, s.rt, scope.rt);
    scope.sensor = setOptions(sensorSel, s.sensor, scope.sensor);
    seriesF.hidden = !s.series;
    rtF.hidden = !s.rt;
    sensorF.hidden = !s.sensor;
    fromF.hidden = toF.hidden = !s.period || s.period === 'fixed';
    fixedNote.hidden = s.period !== 'fixed';
    bboxF.hidden = !s.bbox;
    doc.textContent = ds.doc;
    applyPeriod();
  }

  const read = () => {
    scope.series = seriesSel.value;
    scope.rt = rtSel.value;
    scope.sensor = sensorSel.value;
    scope.from = fromIn.value.trim();
    scope.to = toIn.value.trim();
    scope.bbox = bboxIn.map((i) => i.value.trim()) as Scope['bbox'];
    onChange();
  };

  dsSel.addEventListener('change', () => {
    applyDataset();
    onChange();
  });
  for (const c of [seriesSel, rtSel, sensorSel, fromIn, toIn, ...bboxIn]) c.addEventListener('change', read);
  applyDataset();

  return {
    el,
    dataset: () => ds,
    scope: () => ({ ...scope, bbox: [...scope.bbox] as Scope['bbox'] }),
    setMonth(m) {
      month = m;
      if (ds.spec.period === 'fixed') {
        applyPeriod();
        onChange();
      }
    },
  };
}
