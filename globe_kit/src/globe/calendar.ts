import { lut, RAMPS } from './colormaps';

/**
 * Year x month calendar heatmap (rows = years, columns = months), for any monthly series.
 * - "value" mode: sequential ramp (viridis, colour-blind safe) on a log scale.
 * - "anomaly" mode: ratio to the median of the same calendar month in the other years,
 *   diverging ramp from 1/4x (blue) through 1x (neutral) to 4x (red).
 * Months without coverage are drawn hatched, never as zero.
 * Optional 90% intervals per month: shown in tooltips, and in "anomaly" mode a month whose
 * interval still contains the median is drawn faded (the difference is within the uncertainty).
 * Optional display range (setRange): only the months inside it are drawn and totalled, while the anomaly
 * baseline and the median row keep using every covered month (a short range would make the median meaningless).
 */
export interface CalendarOptions {
  onSelect?: (key: string) => void;
  /** Value formatter for tooltips and totals. */
  format?: (v: number) => string;
  unit?: string;
  /** Locale for numbers (default 'en'). */
  locale?: string;
  /** Texts (English defaults); the app passes translated ones. */
  labels?: Partial<CalendarLabels>;
}

/** Everything the heatmap writes. Month names are short, January first. */
export interface CalendarLabels {
  months: string[];
  /** One-letter column headers; default: first letter of each month. */
  initials: string[];
  empty: string;
  year: string;
  medianRow: string;
  noData(month: string, year: number): string;
  /** Appended to the tooltip of a partial month. */
  partial(tip: string): string;
  /** Tooltip of a month with data; numbers are already formatted. */
  tip(p: { month: string; year: number; value: string; unit?: string; interval?: [string, string]; ratio?: string; median?: string; years?: number; percentile?: number }): string;
  medianTip(month: string, value: string): string;
}

export interface MonthStats {
  key: string;
  value: number;
  median: number | undefined;
  ratio: number | undefined;
  /** Share of other years with a lower value (0-100). */
  percentile: number | undefined;
  baselineYears: number;
  /** 90% interval of the value, when the series provides one. */
  lo?: number;
  hi?: number;
  /** True when an interval exists and does not contain the median. */
  significant?: boolean;
  /** Month still being filled (newest month): not compared with full months. */
  partial?: boolean;
}

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LABELS_EN: CalendarLabels = {
  months: MONTHS_EN,
  initials: MONTHS_EN.map((m) => m[0]),
  empty: 'No data for this area.',
  year: 'Year',
  medianRow: 'Med.',
  noData: (month, year) => `${month} ${year}: no data`,
  partial: (tip) => `${tip} (partial month, data still arriving)`,
  tip: (p) =>
    `${p.month} ${p.year}: ${p.value}${p.unit ? ' ' + p.unit : ''}` +
    (p.interval ? ` (90%: ${p.interval[0]}-${p.interval[1]})` : '') +
    (p.median !== undefined
      ? `; ${p.ratio}x the ${p.month} median (${p.median}, ${p.years} other years); higher than ${Math.round(p.percentile!)}% of them`
      : ''),
  medianTip: (month, value) => `Median ${month}: ${value}`,
};
const VIRIDIS = lut(RAMPS.viridis);
const DIVERGING = lut(RAMPS.diverging);

const median = (xs: number[]) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function createCalendarHeatmap(parent: HTMLElement, o: CalendarOptions = {}) {
  const el = document.createElement('div');
  el.className = 'gk-cal';
  parent.appendChild(el);
  const loc = o.locale ?? 'en';
  const L: CalendarLabels = { ...LABELS_EN, ...o.labels };
  if (o.labels?.months && !o.labels.initials) L.initials = L.months.map((m) => m[0]);
  const MON = L.months;
  const fmt = o.format ?? ((v: number) => Math.round(v).toLocaleString(loc));
  const ratioTxt = (r: number) => r.toLocaleString(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let values = new Map<string, number>();
  let covered = new Set<string>();
  let partial = new Set<string>();
  let intervals = new Map<string, [number, number]>();
  let mode: 'value' | 'anomaly' = 'value';
  let selected = '';
  let range: [string, string] | undefined;
  const inRange = (k: string) => !range || (k >= range[0] && k <= range[1]);

  /** Stats of one month against the same calendar month in the other covered years. */
  function stats(key: string): MonthStats | undefined {
    if (!covered.has(key)) return undefined;
    const v = values.get(key) ?? 0;
    const mm = key.slice(5, 7);
    // Partial months (data still arriving) are left out of the baseline.
    const others = [...covered]
      .filter((k) => k.slice(5, 7) === mm && k !== key && !partial.has(k))
      .map((k) => values.get(k) ?? 0);
    const med = median(others);
    const iv = intervals.get(key);
    // A partial month is not compared with full months: it would always look low.
    const part = partial.has(key);
    return {
      key,
      value: v,
      median: med,
      ratio: !part && med !== undefined && med > 0 ? v / med : undefined,
      percentile: !part && others.length ? (100 * others.filter((x) => x < v).length) / others.length : undefined,
      baselineYears: others.length,
      lo: iv?.[0],
      hi: iv?.[1],
      significant: !part && iv && med !== undefined ? med < iv[0] || med > iv[1] : undefined,
      partial: part,
    };
  }

  function color(key: string, max: number): string {
    if (!covered.has(key) || !inRange(key)) return '';
    const v = values.get(key) ?? 0;
    let i: number;
    let table = VIRIDIS;
    if (mode === 'value') {
      i = max > 0 ? Math.round((Math.log1p(v) / Math.log1p(max)) * 255) : 0;
    } else {
      const s = stats(key);
      // Colour on a smoothed ratio, so that months with a median of 0 still get a colour; partial months neutral.
      const r = !s || s.partial || s.median === undefined ? 1 : (s.value + 1) / (s.median + 1);
      i = Math.round(Math.min(1, Math.max(0, 0.5 + Math.log2(r) / 4)) * 255); // 1/4x..4x
      table = DIVERGING;
    }
    const [r, g, b] = [table[i * 4], table[i * 4 + 1], table[i * 4 + 2]];
    // Within the uncertainty: fade the anomaly colour.
    if (mode === 'anomaly' && stats(key)?.significant === false) return `rgba(${r},${g},${b},0.35)`;
    return `rgb(${r},${g},${b})`;
  }

  function render() {
    const allKeys = [...covered].sort();
    const keys = allKeys.filter(inRange);
    if (!keys.length) {
      el.innerHTML = values.size || covered.size ? `<p class="gk-cal-empty">${L.empty}</p>` : '';
      return;
    }
    const y0 = Number(keys[0].slice(0, 4));
    const y1 = Number(keys[keys.length - 1].slice(0, 4));
    const max = Math.max(0, ...keys.map((k) => values.get(k) ?? 0));
    const yearTotals = new Map<number, number>();
    for (const k of keys) yearTotals.set(Number(k.slice(0, 4)), (yearTotals.get(Number(k.slice(0, 4))) ?? 0) + (values.get(k) ?? 0));
    const maxYear = Math.max(1, ...yearTotals.values());
    let html = '<div class="gk-cal-grid" role="grid"><div></div>';
    html += L.initials.map((m) => `<div class="gk-cal-h">${m}</div>`).join('') + `<div class="gk-cal-h gk-cal-tot">${L.year}</div>`;
    for (let y = y1; y >= y0; y--) {
      html += `<div class="gk-cal-y">${y}</div>`;
      for (let m = 1; m <= 12; m++) {
        const key = `${y}-${String(m).padStart(2, '0')}`;
        const has = covered.has(key) && inRange(key);
        const s = has ? stats(key) : undefined;
        const tip = has
          ? L.tip({
              month: MON[m - 1],
              year: y,
              value: fmt(s!.value),
              unit: o.unit,
              interval: s!.lo !== undefined ? [fmt(s!.lo), fmt(s!.hi!)] : undefined,
              ratio: s!.ratio !== undefined ? ratioTxt(s!.ratio) : undefined,
              median: s!.median !== undefined ? fmt(s!.median) : undefined,
              years: s!.baselineYears,
              percentile: s!.percentile,
            })
          : inRange(key) ? L.noData(MON[m - 1], y) : '';
        const part = has && partial.has(key);
        const t2 = part ? L.partial(tip) : tip;
        html += `<button type="button" class="gk-cal-c${has ? '' : ' gk-cal-na'}${part ? ' gk-cal-part' : ''}${key === selected ? ' gk-cal-sel' : ''}" data-k="${key}" ${has ? '' : 'disabled'} style="background:${color(key, max)}" title="${t2}" aria-label="${t2}"></button>`;
      }
      const tot = yearTotals.get(y) ?? 0;
      html += `<div class="gk-cal-bar" title="${y}: ${fmt(tot)}"><span style="width:${((tot / maxYear) * 100).toFixed(1)}%"></span></div>`;
    }
    // Median row: typical seasonality.
    html += `<div class="gk-cal-y">${L.medianRow}</div>`;
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      const med = median(allKeys.filter((k) => k.slice(5, 7) === mm).map((k) => values.get(k) ?? 0)) ?? 0;
      html += `<div class="gk-cal-med" title="${L.medianTip(MON[m - 1], fmt(med))}">${fmt(med)}</div>`;
    }
    html += '<div></div></div>';
    el.innerHTML = html;
  }

  el.addEventListener('click', (e) => {
    const k = (e.target as HTMLElement).closest<HTMLButtonElement>('.gk-cal-c')?.dataset.k;
    if (k) o.onSelect?.(k);
  });

  return {
    /** values: YYYY-MM -> number; covered: months where the sensor observed (missing values count as 0). */
    setData(
      v: Map<string, number>,
      cov: Iterable<string>,
      part: Iterable<string> = [],
      iv: Map<string, [number, number]> = new Map(),
    ) {
      values = v;
      covered = new Set(cov);
      partial = new Set(part);
      intervals = iv;
      render();
    },
    /** Months shown (YYYY-MM, inclusive); undefined = all. Baselines still use the whole record. */
    setRange(from?: string, to?: string) {
      range = from && to ? [from.slice(0, 7), to.slice(0, 7)] : undefined;
      render();
    },
    /** True when the month is inside the display range. */
    inRange,
    setMode(m: 'value' | 'anomaly') {
      mode = m;
      render();
    },
    select(key: string) {
      selected = key.slice(0, 7);
      el.querySelector('.gk-cal-sel')?.classList.remove('gk-cal-sel');
      el.querySelector(`[data-k="${selected}"]`)?.classList.add('gk-cal-sel');
    },
    stats,
    destroy: () => el.remove(),
  };
}
