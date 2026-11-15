/**
 * Explains a disabled control in text instead of only in a title tooltip (WCAG 1.3.3): a note linked with
 * aria-describedby, visible next to the control (default) or screen-reader only. Pass no text to remove it.
 * The note goes after the control's label or segmented group, never inside it (it would join the accessible name).
 */
let seq = 0;
export function explainDisabled(el: HTMLElement, text: string | undefined, o: { visible?: boolean } = {}): void {
  const visible = o.visible ?? true;
  let note = (el as HTMLElement & { _why?: HTMLElement })._why;
  if (!text) {
    if (note) {
      note.hidden = true;
      note.textContent = '';
    }
    el.removeAttribute('aria-describedby');
    return;
  }
  if (!note) {
    note = document.createElement('span');
    note.id = `a11yb-why-${++seq}`;
    note.className = visible ? 'note a11yb-why' : 'a11yb-why gk-sr';
    const host = el.closest<HTMLElement>('label, .seg') ?? el;
    host.after(note);
    (el as HTMLElement & { _why?: HTMLElement })._why = note;
  }
  note.hidden = false;
  note.textContent = text;
  el.setAttribute('aria-describedby', note.id);
}
