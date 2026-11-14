type Attr = string | number | boolean | undefined | ((e: Event) => void);

/** Tiny DOM builder: on* attributes are listeners, `class` sets className, true sets a boolean attribute. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, Attr> = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') e.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') e.className = String(v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  e.append(...kids);
  return e;
}

/** A label wrapping its control: names the control for assistive technology without ids. */
export function field(label: string, control: HTMLElement, cls = ''): HTMLLabelElement {
  return h('label', { class: `ex-field ${cls}`.trim() }, h('span', { class: 'ex-flabel' }, label), control);
}

export function select(options: [value: string, label: string][], value?: string, aria?: string): HTMLSelectElement {
  const s = h('select', aria ? { 'aria-label': aria } : {});
  for (const [v, l] of options) s.append(h('option', { value: v }, l));
  if (value !== undefined && options.some(([v]) => v === value)) s.value = value;
  return s;
}

/** SQL identifier, double-quoted. */
export const qi = (name: string) => `"${name.replace(/"/g, '""')}"`;
/** SQL string literal, single-quoted. */
export const ql = (text: string) => `'${text.replace(/'/g, "''")}'`;

export const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const RE_MONTH = /^\d{4}-\d{2}$/;

/** Finite number from user input; undefined when it is not one. */
export function toNum(v: string | number): number | undefined {
  if (typeof v === 'string' && v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function saveBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const stamp = () => new Date().toISOString().slice(0, 10);

/** Months since 2000-01 for a YYYY-MM string; undefined when invalid or before 2000. */
export function monthIndex(ym: string): number | undefined {
  if (!RE_MONTH.test(ym)) return undefined;
  const y = Number(ym.slice(0, 4));
  const mo = Number(ym.slice(5, 7));
  return y >= 2000 && mo >= 1 && mo <= 12 ? (y - 2000) * 12 + mo - 1 : undefined;
}

export function readJson<T>(key: string): T | undefined {
  try {
    const t = localStorage.getItem(key);
    return t ? (JSON.parse(t) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function writeJson(key: string, value: unknown | undefined) {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked or full: layout is simply not remembered */
  }
}

/** CSV text with a BOM so that Excel reads UTF-8. */
export function toCsv(head: string[], rows: unknown[][]): string {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const t = String(v);
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return '﻿' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
