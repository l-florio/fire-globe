/**
 * Arrow-key pattern of a radiogroup made of <button role="radio"> (WAI-ARIA): roving tabindex (only the checked
 * radio is in the tab order), arrows and Home/End move the selection and the focus, disabled or hidden radios
 * are skipped. The app keeps aria-checked up to date; a MutationObserver keeps tabindex in step with it.
 */
export function enhanceRadioGroup(group: HTMLElement) {
  const radios = () => [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
  const usable = (r: HTMLElement) => !r.hidden && !(r as HTMLButtonElement).disabled && r.getClientRects().length > 0;
  const sync = () => {
    const all = radios();
    const checked = all.find((r) => r.getAttribute('aria-checked') === 'true');
    const on = (checked && usable(checked) ? checked : undefined) ?? all.find(usable) ?? checked ?? all[0];
    for (const r of all) r.tabIndex = r === on ? 0 : -1;
  };
  group.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const list = radios().filter(usable);
    const i = list.indexOf(e.target as HTMLElement);
    if (i < 0) return;
    let j = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % list.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + list.length) % list.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = list.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    list[j].click(); // selection follows focus
    sync();
    list[j].focus();
  });
  new MutationObserver(sync).observe(group, { subtree: true, attributes: true, attributeFilter: ['aria-checked', 'disabled', 'hidden'] });
  sync();
  return { sync };
}
