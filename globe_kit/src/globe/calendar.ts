import { lut, RAMPS } from './colormaps';

/**
 * Year x month calendar heatmap (rows = years, columns = months), for any monthly series.
 * - "value" mode: sequential ramp (viridis, colour-blind safe) on a log scale.
 * - "anomaly" mode: ratio to the median of the same calendar month in the other years,
 *   diverging ramp from 1/4x (blue) through 1x (neutral) to 4x (red).
 * Months without coverage are drawn hatched, never as zero.
 * Optional 90% intervals per month: shown in tooltips, and in "anomaly" mode a month whose
 * interval still contains the median is drawn faded (the difference is within the uncertainty).
 */
export interface CalendarOptions {
  onSelect?: (key: string) => void;
  /** Value formatter for tooltips and totals. */
  format?: (v: number) => string;
  unit?: string;
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
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
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
  const fmt = o.format ?? ((v: number) => Math.round(v).toLocaleString('en'));
  let values = new Map<string, number>();
  let covered = new Set<string>();
  let partial = new Set<string>();
  let intervals = new Map<string, [number, number]>();
  let mode: 'value' | 'anomaly' = 'value';
  let selected = '';

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
    return {
      key,
      value: v,
      median: med,
      ratio: med !== undefined ? (v + 1) / (med + 1) : undefined,
      percentile: others.length ? (100 * others.filter((x) => x < v).length) / others.length : undefined,
      baselineYears: others.length,
      lo: iv?.[0],
      hi: iv?.[1],
      significant: iv && med !== undefined ? med < iv[0] || med > iv[1] : undefined,
    };
  }

  function color(key: string, max: number): string {
    if (!covered.has(key)) return '';
    const v = values.get(key) ?? 0;
    let i: number;
    let table = VIRIDIS;
    if (mode === 'value') {
      i = max > 0 ? Math.round((Math.log1p(v) / Math.log1p(max)) * 255) : 0;
    } else {
      const s = stats(key);
      const r = s?.ratio ?? 1;
      i = Math.round(Math.min(1, Math.max(0, 0.5 + Math.log2(r) / 4)) * 255); // 1/4x..4x
      table = DIVERGING;
    }
    const [r, g, b] = [table[i * 4], table[i * 4 + 1], table[i * 4 + 2]];
    // Within the uncertainty: fade the anomaly colour.
    if (mode === 'anomaly' && stats(key)?.significant === false) return `rgba(${r},${g},${b},0.35)`;
    return `rgb(${r},${g},${b})`;
  }

  function render() {
    const keys = [...covered].sort();
    if (!keys.length) {
      el.innerHTML = values.size || covered.size ? '<p class="gk-cal-empty">No data for this area.</p>' : '';
      return;
    }
    const y0 = Number(keys[0].slice(0, 4));
    const y1 = Number(keys[keys.length - 1].slice(0, 4));
    const max = Math.max(0, ...keys.map((k) => values.get(k) ?? 0));
    const yearTotals = new Map<number, number>();
    for (const k of keys) yearTotals.set(Number(k.slice(0, 4)), (yearTotals.get(Number(k.slice(0, 4))) ?? 0) + (values.get(k) ?? 0));
    const maxYear = Math.max(1, ...yearTotals.values());
    let html = '<div class="gk-cal-grid" role="grid"><div></div>';
    html += MON.map((m) => `<div class="gk-cal-h">${m[0]}</div>`).join('') + '<div class="gk-cal-h gk-cal-tot">Year</div>';
    for (let y = y1; y >= y0; y--) {
      html += `<div class="gk-cal-y">${y}</div>`;
      for (let m = 1; m <= 12; m++) {
        const key = `${y}-${String(m).padStart(2, '0')}`;
        const has = covered.has(key);
        const s = has ? stats(key) : undefined;
        const tip = has
          ? `${MON[m - 1]} ${y}: ${fmt(s!.value)}${o.unit ? ' ' + o.unit : ''}` +
            (s!.lo !== undefined ? ` (90%: ${fmt(s!.lo)}-${fmt(s!.hi!)})` : '') +
            (s!.median !== undefined
              ? `; ${s!.ratio!.toFixed(2)}x the ${MON[m - 1]} median (${fmt(s!.median)}, ${s!.baselineYears} other years); higher than ${Math.round(s!.percentile!)}% of them`
              : '')
          : `${MON[m - 1]} ${y}: no data`;
        const part = partial.has(key);
        const t2 = part ? `${tip} (partial month, data still arriving)` : tip;
        html += `<button type="button" class="gk-cal-c${has ? '' : ' gk-cal-na'}${part ? ' gk-cal-part' : ''}${key === selected ? ' gk-cal-sel' : ''}" data-k="${key}" ${has ? '' : 'disabled'} style="background:${color(key, max)}" title="${t2}" aria-label="${t2}"></button>`;
      }
      const tot = yearTotals.get(y) ?? 0;
      html += `<div class="gk-cal-bar" title="${y}: ${fmt(tot)}"><span style="width:${((tot / maxYear) * 100).toFixed(1)}%"></span></div>`;
    }
    // Median row: typical seasonality.
    html += '<div class="gk-cal-y">Med.</div>';
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      const med = median(keys.filter((k) => k.slice(5, 7) === mm).map((k) => values.get(k) ?? 0)) ?? 0;
      html += `<div class="gk-cal-med" title="Median ${MON[m - 1]}: ${fmt(med)}">${fmt(med)}</div>`;
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
