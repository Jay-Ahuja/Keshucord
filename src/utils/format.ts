export function capitalize(value: string): string {
  if (!value) return value;
  return value[0].toUpperCase() + value.slice(1);
}

export function initialsOf(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .map((p) => p[0]!)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/** Format a duration (ms) as `HH:MM:SS`. Used by the title bar's LIVE chip
 *  and the launch screen's success summary. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hh = String(Math.floor(total / 3600)).padStart(2, '0');
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Today's date as `M/D/YYYY` with no zero-padding. Used by the Create
 * screen when `titleDatePrefix` is on to prepend the date to stream titles.
 *
 * Deliberately uses Date builtins rather than `Intl.DateTimeFormat`: the
 * Intl path's output depends on the host locale (e.g. `en-GB` yields
 * `DD/MM/YYYY`, `de-DE` yields `D.M.YYYY`), which would silently diverge
 * from the documented M/D/YYYY contract — and from the duplicate-prefix
 * check in CreateScreen, which would then re-prepend the date on every
 * re-mount in those locales.
 */
export function formatDatePrefix(): string {
  const d = new Date();
  return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
}
