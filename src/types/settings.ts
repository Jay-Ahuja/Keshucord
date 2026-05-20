import type { Privacy } from './stream';

export type AppearanceAccent = 'purple' | 'cobalt' | 'ember' | 'mono';
export type AppearanceDensity = 'comfortable' | 'compact';

/**
 * Persistent per-user preferences. Saved to disk encrypted via Electron's
 * safeStorage (DPAPI / Keychain / libsecret). New fields can be added safely
 * — the load path merges with DEFAULT_USER_SETTINGS so older payloads upgrade.
 */
export interface UserSettings {
  /** OBS WebSocket password — treated as a secret, encrypted at rest. */
  obsPassword: string;
  defaultTitle: string;
  defaultDescription: string;
  defaultPrivacy: Privacy;
  defaultCategory: string;
  /**
   * When true, the Create screen auto-prepends today's date (M/D/YYYY)
   * followed by " - " to the stream title on mount. The prefix is editable
   * plain text after insertion — it is not a separate field and is not
   * re-locked. Surfaced in Settings → Stream defaults.
   */
  titleDatePrefix: boolean;

  // Appearance — surfaced in the Keshucord redesign's Settings → Appearance tab.
  // Phase A introduces the shape; later phases wire the UI. Defaults match the
  // design's "out of the box" preset (wealthy purple, comfortable density, no
  // motion reduction, expanded sidebar).
  appearanceAccent: AppearanceAccent;
  appearanceDensity: AppearanceDensity;
  appearanceReduceMotion: boolean;
  sidebarCompact: boolean;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  obsPassword: '',
  defaultTitle: '',
  defaultDescription: '',
  defaultPrivacy: 'public',
  defaultCategory: '',
  titleDatePrefix: false,
  appearanceAccent: 'purple',
  appearanceDensity: 'comfortable',
  appearanceReduceMotion: false,
  sidebarCompact: false,
};
