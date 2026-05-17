import type { AppearanceAccent } from '../types/settings';

/**
 * Maps each accent name to its oklch `L C H` triplet. Lifted verbatim from the
 * Keshucord design's `app.jsx` so the runtime palette matches the prototype
 * exactly.
 */
const ACCENT_MAP: Record<AppearanceAccent, { acc: string; hi: string; lo: string }> = {
  purple: { acc: '0.62 0.19 295', hi: '0.72 0.21 295', lo: '0.40 0.16 295' },
  cobalt: { acc: '0.62 0.18 252', hi: '0.72 0.20 255', lo: '0.40 0.16 252' },
  ember: { acc: '0.66 0.20 30', hi: '0.75 0.22 30', lo: '0.46 0.18 28' },
  mono: { acc: '0.70 0.02 285', hi: '0.85 0.02 285', lo: '0.50 0.01 285' },
};

/**
 * Applies the accent's oklch values to the CSS custom properties on
 * `:root`. Any class in `keshucord.css` that references `var(--acc*)` will
 * pick up the new colour immediately, no re-render needed.
 */
export function applyAccent(name: AppearanceAccent): void {
  const a = ACCENT_MAP[name] ?? ACCENT_MAP.purple;
  const root = document.documentElement.style;
  root.setProperty('--acc', `oklch(${a.acc})`);
  root.setProperty('--acc-hi', `oklch(${a.hi})`);
  root.setProperty('--acc-lo', `oklch(${a.lo})`);
  root.setProperty('--acc-glow', `oklch(${a.acc} / 0.35)`);
  root.setProperty('--acc-wash', `oklch(${a.acc} / 0.10)`);
}
