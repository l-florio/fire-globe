import * as Cesium from 'cesium';
import { shortcutsEnabled } from './a11y';

/**
 * Elements that take keys for themselves: text fields, selects, editors, sliders, radios, dialogs.
 * Single-key shortcuts of the app never fire while the focus is in one of them.
 */
const OWN_KEYS =
  'input, select, textarea, [contenteditable]:not([contenteditable="false"]), .cm-editor, [role="textbox"], [role="slider"], [role="radio"], [role="application"], [role="dialog"], [role="listbox"], [role="combobox"]';

/** True when a single-key shortcut must not fire for this event (off in the Accessibility menu, modifier, own keys). */
export function shortcutBlocked(e: KeyboardEvent): boolean {
  if (!shortcutsEnabled() || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return true;
  const el = e.target as HTMLElement | null;
  return !!el?.closest && !!(el.isContentEditable || el.closest(OWN_KEYS));
}

/** Space activates a focused button or link: a play/pause shortcut must leave it alone. */
export const isActivatable = (e: KeyboardEvent) =>
  !!(e.target as HTMLElement | null)?.closest?.('button, a[href], summary');

export interface GlobeKeyboardOptions {
  zoomIn: () => void;
  zoomOut: () => void;
  home: () => void;
}

const R = 6_371_000;
const DEG = Math.PI / 180;

/**
 * Keyboard operation of the globe while it has focus (component-level keys, always on; they are not global
 * shortcuts): arrows pan, + and - zoom, Shift+arrows rotate (left/right) and tilt (up/down), Home or 0 resets.
 * The element must be focusable (the app sets tabindex, role and labels).
 */
export function createGlobeKeyboard(viewer: Cesium.Viewer, el: HTMLElement, o: GlobeKeyboardOptions) {
  const { camera, scene } = viewer;
  const pan = (dx: number, dy: number) => {
    const h = camera.positionCartographic.height;
    const a = Math.min(0.5, Math.max(1e-7, (0.08 * h) / R));
    if (dx > 0) camera.rotateRight(a);
    else if (dx < 0) camera.rotateLeft(a);
    if (dy > 0) camera.rotateDown(a);
    else if (dy < 0) camera.rotateUp(a);
    scene.requestRender();
  };
  /** Orbit around the point at the screen centre: heading and pitch in radians (deltas). */
  const orbit = (dHeading: number, dPitch: number) => {
    const canvas = scene.canvas;
    const c = camera.pickEllipsoid(new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2), scene.globe.ellipsoid);
    if (!c) return;
    const range = Cesium.Cartesian3.distance(camera.positionWC, c);
    const heading = camera.heading + dHeading;
    const pitch = Math.min(-0.15, Math.max(-Cesium.Math.PI_OVER_TWO, camera.pitch + dPitch));
    camera.lookAt(c, new Cesium.HeadingPitchRange(heading, pitch, range));
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    scene.requestRender();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.target !== el || e.ctrlKey || e.metaKey || e.altKey) return;
    let done = true;
    switch (e.key) {
      case 'ArrowLeft':
        e.shiftKey ? orbit(-10 * DEG, 0) : pan(-1, 0);
        break;
      case 'ArrowRight':
        e.shiftKey ? orbit(10 * DEG, 0) : pan(1, 0);
        break;
      case 'ArrowUp':
        e.shiftKey ? orbit(0, 8 * DEG) : pan(0, 1);
        break;
      case 'ArrowDown':
        e.shiftKey ? orbit(0, -8 * DEG) : pan(0, -1);
        break;
      case '+':
      case '=':
        o.zoomIn();
        break;
      case '-':
      case '_':
        o.zoomOut();
        break;
      case 'Home':
      case '0':
        o.home();
        break;
      default:
        done = false;
    }
    if (done) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  el.addEventListener('keydown', onKey);
  return { destroy: () => el.removeEventListener('keydown', onKey) };
}
