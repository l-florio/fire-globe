/**
 * Accessibility preferences of the app, saved in localStorage and applied on every page at load.
 * The Accessibility menu (a11yMenu.ts) changes them; other modules read them with a11y() or listen with onA11y().
 * Classes on <html>: a11y-hc (high contrast), a11y-motion-off (reduced motion), a11y-text-lg (larger text),
 * a11y-spacing (wider letter/line spacing), a11y-font (easy-reading font). Palette and halo are read by the map code.
 */
import { setReducedMotion, setShortcutsEnabled } from '../globe/a11y';

export interface A11yPrefs {
  /** Reduced motion: no camera flights, playback paused at start, no animated transitions. */
  reducedMotion: boolean;
  /** High contrast: 3:1 control borders, 2 px focus ring, opaque panels. */
  highContrast: boolean;
  /** Map palette: 'default' (fire ramp) or 'cvd' (colour-vision-deficiency safe ramp). */
  palette: 'default' | 'cvd';
  /** Dark outline around detection points so they stand out on red soil or forest imagery. */
  halo: boolean;
  /** Single-key keyboard shortcuts (WCAG 2.1.4: they can be turned off). */
  shortcuts: boolean;
  /** Larger text (about 125%). */
  largeText: boolean;
  /** Wider letter, word and line spacing (WCAG 1.4.12). */
  spacing: boolean;
  /** Easy-reading font: EasyReading PRO when installed on the device (its licence does not allow us to host it), else Verdana. */
  readableFont: boolean;
}

const KEY = 'fireglobe.a11y';
const systemReduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const DEFAULTS: A11yPrefs = {
  reducedMotion: systemReduced,
  highContrast: false,
  palette: 'default',
  halo: false,
  shortcuts: true,
  largeText: false,
  spacing: false,
  readableFont: false,
};

function load(): A11yPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<A11yPrefs>) };
  } catch {
    /* storage blocked or bad JSON: defaults */
  }
  return { ...DEFAULTS };
}

let prefs = load();
const listeners = new Set<(p: A11yPrefs, changed: keyof A11yPrefs | undefined) => void>();

function apply() {
  const c = document.documentElement.classList;
  c.toggle('a11y-hc', prefs.highContrast);
  c.toggle('a11y-motion-off', prefs.reducedMotion);
  c.toggle('a11y-text-lg', prefs.largeText);
  c.toggle('a11y-spacing', prefs.spacing);
  c.toggle('a11y-font', prefs.readableFont);
  setReducedMotion(prefs.reducedMotion);
  setShortcutsEnabled(prefs.shortcuts);
}
apply();

export const a11y = (): Readonly<A11yPrefs> => prefs;

export function setA11y<K extends keyof A11yPrefs>(key: K, value: A11yPrefs[K]) {
  prefs = { ...prefs, [key]: value };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* not persisted */
  }
  apply();
  for (const f of listeners) f(prefs, key);
}

export function resetA11y() {
  prefs = { ...DEFAULTS };
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  apply();
  for (const f of listeners) f(prefs, undefined);
}

/** Listen to changes; returns an unsubscribe function. `changed` is undefined after a reset. */
export function onA11y(f: (p: A11yPrefs, changed: keyof A11yPrefs | undefined) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}
