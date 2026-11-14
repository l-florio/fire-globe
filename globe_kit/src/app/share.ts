/**
 * Shareable links: the view state lives in the URL hash, e.g.
 *   #t=2023-07&mode=HARM&harm=HARM_LONG&cal=1&area=region:c:EU&cs=HARM_LONG
 * The hash is updated in place while the user works (no new history entries), so the address bar is always a
 * link to the current view. Keys: t (time key), mode, harm, viirs, metric, step, view, cam (lon,lat,height m),
 * cal (calendar open), area (see calendarPanel areaSpec), cs / cv / cm (calendar sensor, variable, colour),
 * cf / ct (calendar period, YYYY-MM), src (calendar sources: veg | all | static; veg is the default),
 * gsrc (globe sources: veg | all | volcano | static | offshore; veg is the default).
 */
export type ShareState = Record<string, string | undefined>;

export function readShare(): ShareState {
  const out: ShareState = {};
  for (const part of location.hash.replace(/^#/, '').split('&')) {
    const i = part.indexOf('=');
    if (i > 0) out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

/** Readable encoding: keep : , . - and letters as they are. */
const enc = (v: string) => encodeURIComponent(v).replace(/%3A/gi, ':').replace(/%2C/gi, ',');

export function writeShare(s: ShareState) {
  const h = Object.entries(s)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${enc(v!)}`)
    .join('&');
  const url = `${location.pathname}${location.search}${h ? `#${h}` : ''}`;
  if (url !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(null, '', url);
}

/** Copy the current link; resolves to false when the clipboard is not available. */
export async function copyLink(): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(location.href);
    return true;
  } catch {
    return false;
  }
}
