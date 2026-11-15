/**
 * Focus handling of a non-modal popup panel that other code opens and closes by toggling its `hidden` attribute
 * (WCAG 2.4.3): on opening from a button, focus moves into the panel; Esc closes it; closing returns the focus
 * to the button that opened it. Panels opened by code (a link, the start-up state) do not take the focus.
 */
export interface PopupFocusOptions {
  /** Accessible name when the panel has none. */
  label?: string;
  /** Closes the panel (Esc). */
  close: () => void;
  /** Where focus goes when the opener is gone (it was a transient button). */
  fallback: () => HTMLElement | null;
  /** True while another popup is open: the focus then belongs to it and is not restored here. */
  otherOpen?: () => boolean;
}

export function managePopup(el: HTMLElement, o: PopupFocusOptions) {
  el.setAttribute('role', 'dialog'); // non-modal: the page behind stays usable
  if (o.label && !el.getAttribute('aria-label')) el.setAttribute('aria-label', o.label);
  el.tabIndex = -1;
  let pending: HTMLElement | undefined;
  let opener: HTMLElement | undefined;
  let wasHidden = el.hidden;
  new MutationObserver(() => {
    if (el.hidden === wasHidden) return;
    wasHidden = el.hidden;
    if (!el.hidden) {
      opener = pending;
      pending = undefined;
      if (opener) el.focus({ preventScroll: true });
      return;
    }
    const a = document.activeElement;
    const lost = !a || a === document.body || el.contains(a);
    if (lost && opener && !o.otherOpen?.()) {
      const target = opener.isConnected ? opener : o.fallback();
      target?.focus();
    }
    opener = undefined;
  }).observe(el, { attributes: true, attributeFilter: ['hidden'] });
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || el.hidden) return;
    e.preventDefault();
    e.stopPropagation();
    if (!opener) opener = o.fallback() ?? undefined;
    o.close();
  });
  return {
    /** Call from the click handler of the button that opens the panel. */
    opening(button: HTMLElement) {
      pending = button;
      setTimeout(() => (pending = undefined), 0); // the panel toggles in the same click; a later open is not ours
    },
  };
}
