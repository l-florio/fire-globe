/**
 * Accessibility switches of the globe library, set by the app (src/app/a11yPrefs.ts).
 * - reduced motion: camera flights jump instead of animating (use flightSeconds() for every flyTo duration);
 * - keyboard shortcuts: single-key shortcuts of the controls can be turned off (WCAG 2.1.4).
 */
const state = {
  reducedMotion: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  shortcuts: true,
};

export function setReducedMotion(on: boolean) {
  state.reducedMotion = on;
}
export const reducedMotion = () => state.reducedMotion;
/** Duration for a camera flight: 0 (jump) when reduced motion is on. */
export const flightSeconds = (seconds: number) => (state.reducedMotion ? 0 : seconds);

export function setShortcutsEnabled(on: boolean) {
  state.shortcuts = on;
}
export const shortcutsEnabled = () => state.shortcuts;
