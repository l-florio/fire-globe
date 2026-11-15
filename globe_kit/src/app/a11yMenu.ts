/**
 * Accessibility menu: an icon button in the app bar (#a11y-slot) that opens a non-modal popover with the
 * preference switches (a11yPrefs.ts), a keyboard shortcuts list and, on the globe page, "Describe this view"
 * with an optional read-aloud (Web Speech API). Esc closes and returns focus; a click outside closes.
 */
import { a11y, onA11y, resetA11y, setA11y, type A11yPrefs } from './a11yPrefs';
import { locale, t, type Key } from './i18n';
import './a11y.css';

let describeFn: (() => string) | undefined;
/** The globe page registers how to describe its current view; without it the Describe section stays hidden. */
export function setDescribeProvider(f: () => string) {
  describeFn = f;
}

const ICON =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="7.3" r="1.7" fill="currentColor"/><path d="M6.5 10h11M12 10v4M12 14l-2.6 4.5M12 14l2.6 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const SWITCHES: { id: string; label: Key; get: (p: A11yPrefs) => boolean; set: (on: boolean) => void }[] = [
  { id: 'motion', label: 'a11y.motion', get: (p) => p.reducedMotion, set: (v) => setA11y('reducedMotion', v) },
  { id: 'contrast', label: 'a11y.contrast', get: (p) => p.highContrast, set: (v) => setA11y('highContrast', v) },
  { id: 'palette', label: 'a11y.palette', get: (p) => p.palette === 'cvd', set: (v) => setA11y('palette', v ? 'cvd' : 'default') },
  { id: 'halo', label: 'a11y.halo', get: (p) => p.halo, set: (v) => setA11y('halo', v) },
  { id: 'shortcuts', label: 'a11y.shortcuts', get: (p) => p.shortcuts, set: (v) => setA11y('shortcuts', v) },
  { id: 'text', label: 'a11y.text', get: (p) => p.largeText, set: (v) => setA11y('largeText', v) },
  { id: 'spacing', label: 'a11y.spacing', get: (p) => p.spacing, set: (v) => setA11y('spacing', v) },
  { id: 'font', label: 'a11y.font', get: (p) => p.readableFont, set: (v) => setA11y('readableFont', v) },
];

const ARROWS = '← ↑ → ↓';
/** Keys help rows: keycaps (fixed text) and what they do. */
const KEYS: [string[], Key][] = [
  [[ARROWS], 'a11y.k.pan'],
  [['+', '-'], 'a11y.k.zoom'],
  [[`Shift + ${ARROWS}`], 'a11y.k.rotate'],
  [['Home', '0'], 'a11y.k.home'],
  [['← →'], 'a11y.k.split'],
  [['← →'], 'a11y.k.time'],
  [['Space'], 'a11y.k.play'],
  [[ARROWS], 'a11y.k.cal'],
  [['Home', 'End'], 'a11y.k.calEnds'],
  [['PageUp', 'PageDown'], 'a11y.k.calPage'],
  [['Esc'], 'a11y.k.esc'],
];

const synth: SpeechSynthesis | undefined = typeof speechSynthesis !== 'undefined' ? speechSynthesis : undefined;

export function mountA11yMenu(slot: HTMLElement) {
  slot.innerHTML =
    `<button type="button" class="a11y-btn" id="a11y-btn" aria-label="${t('a11y.button')}" title="${t('a11y.button')}" aria-expanded="false" aria-controls="a11y-pop" aria-haspopup="dialog">${ICON}</button>` +
    `<div id="a11y-pop" class="a11y-pop" role="dialog" aria-label="${t('a11y.title')}" hidden>` +
    `<div class="a11y-head"><h2>${t('a11y.title')}</h2><button type="button" class="a11y-x" aria-label="${t('a11y.close')}">&times;</button></div>` +
    `<div class="a11y-list">${SWITCHES.map((s) => `<label class="a11y-row"><span>${t(s.label)}</span><input type="checkbox" role="switch" data-sw="${s.id}" /></label>`).join('')}</div>` +
    `<div class="a11y-actions"><button type="button" class="a11y-reset">${t('a11y.reset')}</button>` +
    `<button type="button" class="a11y-link a11y-keys-btn" aria-expanded="false" aria-controls="a11y-keys">${t('a11y.keys')}</button></div>` +
    `<div id="a11y-keys" class="a11y-keys" hidden><dl>${KEYS.map(([k, d]) => `<dt>${k.map((x) => `<kbd>${x}</kbd>`).join(' ')}</dt><dd>${t(d)}</dd>`).join('')}</dl><p>${t('a11y.k.note')}</p></div>` +
    `<div class="a11y-desc-sec" hidden><div class="a11y-actions"><button type="button" class="a11y-describe">${t('a11y.describe')}</button>` +
    `<button type="button" class="a11y-read" hidden>${t('a11y.read')}</button></div>` +
    `<div class="a11y-desc" aria-live="polite" aria-atomic="true" aria-label="${t('a11y.describe.title')}"></div></div>` +
    `</div>`;
  const btn = slot.querySelector<HTMLButtonElement>('#a11y-btn')!;
  const pop = slot.querySelector<HTMLElement>('#a11y-pop')!;
  const boxes = [...pop.querySelectorAll<HTMLInputElement>('input[data-sw]')];
  const keysBtn = pop.querySelector<HTMLButtonElement>('.a11y-keys-btn')!;
  const keysEl = pop.querySelector<HTMLElement>('#a11y-keys')!;
  const descSec = pop.querySelector<HTMLElement>('.a11y-desc-sec')!;
  const descBox = pop.querySelector<HTMLElement>('.a11y-desc')!;
  const readBtn = pop.querySelector<HTMLButtonElement>('.a11y-read')!;

  const sync = () => {
    const p = a11y();
    boxes.forEach((b, i) => (b.checked = SWITCHES[i].get(p)));
  };
  sync();
  onA11y(sync);
  boxes.forEach((b, i) => b.addEventListener('change', () => SWITCHES[i].set(b.checked)));
  pop.querySelector('.a11y-reset')!.addEventListener('click', () => resetA11y());
  keysBtn.addEventListener('click', () => {
    keysEl.hidden = !keysEl.hidden;
    keysBtn.setAttribute('aria-expanded', String(!keysEl.hidden));
  });

  // ---- describe + read aloud
  const stopSpeech = () => {
    synth?.cancel();
    readBtn.textContent = t('a11y.read');
  };
  pop.querySelector('.a11y-describe')!.addEventListener('click', () => {
    if (!describeFn) return;
    stopSpeech();
    descBox.textContent = '';
    const text = describeFn();
    // Set on the next frame so a polite live region announces it even when the text is unchanged.
    requestAnimationFrame(() => (descBox.textContent = text));
  });
  if (synth) {
    readBtn.hidden = false;
    readBtn.addEventListener('click', () => {
      if (synth.speaking) return stopSpeech();
      const text = descBox.textContent || describeFn?.() || '';
      if (!text) return;
      if (!descBox.textContent) descBox.textContent = text;
      const u = new SpeechSynthesisUtterance(text);
      const tag = locale.split('-u-')[0];
      u.lang = tag;
      const short = tag.split('-')[0].toLowerCase();
      const voices = synth.getVoices();
      const v =
        voices.find((x) => x.lang.replace('_', '-').toLowerCase() === tag.toLowerCase()) ??
        voices.find((x) => x.lang.toLowerCase().startsWith(short));
      if (v) u.voice = v;
      u.onend = u.onerror = () => (readBtn.textContent = t('a11y.read'));
      readBtn.textContent = t('a11y.stop');
      synth.speak(u);
    });
  }

  // ---- open / close
  const open = () => {
    descSec.hidden = !describeFn;
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    boxes[0].focus();
  };
  const close = (refocus: boolean) => {
    if (pop.hidden) return;
    pop.hidden = true;
    stopSpeech();
    btn.setAttribute('aria-expanded', 'false');
    if (refocus) btn.focus();
  };
  btn.addEventListener('click', () => (pop.hidden ? open() : close(true)));
  pop.querySelector('.a11y-x')!.addEventListener('click', () => close(true));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !slot.contains(e.target as Node)) close(false);
  });
}
