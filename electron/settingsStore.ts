import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

export type Privacy = 'public' | 'unlisted' | 'private';
export type AppearanceAccent = 'purple' | 'cobalt' | 'ember' | 'mono';
export type AppearanceDensity = 'comfortable' | 'compact';

export interface PersistedSettings {
  obsPassword: string;
  defaultTitle: string;
  defaultDescription: string;
  defaultPrivacy: Privacy;
  defaultCategory: string;

  // Appearance preferences (Keshucord redesign).
  appearanceAccent: AppearanceAccent;
  appearanceDensity: AppearanceDensity;
  appearanceReduceMotion: boolean;
  sidebarCompact: boolean;
}

export const DEFAULT_PERSISTED_SETTINGS: PersistedSettings = {
  obsPassword: '',
  defaultTitle: '',
  defaultDescription: '',
  defaultPrivacy: 'public',
  defaultCategory: '',
  appearanceAccent: 'purple',
  appearanceDensity: 'comfortable',
  appearanceReduceMotion: false,
  sidebarCompact: false,
};

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.enc');
}

export async function load(): Promise<PersistedSettings> {
  try {
    const encrypted = await fs.readFile(settingsFile());
    const json = safeStorage.decryptString(encrypted);
    const parsed = JSON.parse(json) as Partial<PersistedSettings>;
    // Merge with defaults so older payloads pick up any newly-added fields.
    return { ...DEFAULT_PERSISTED_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_PERSISTED_SETTINGS };
  }
}

export async function save(settings: PersistedSettings): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS-level encryption is unavailable; refusing to write settings in plaintext.',
    );
  }
  const sanitized: PersistedSettings = {
    obsPassword: String(settings.obsPassword ?? ''),
    defaultTitle: String(settings.defaultTitle ?? ''),
    defaultDescription: String(settings.defaultDescription ?? ''),
    defaultPrivacy: normalizePrivacy(settings.defaultPrivacy),
    defaultCategory: String(settings.defaultCategory ?? ''),
    appearanceAccent: normalizeAccent(settings.appearanceAccent),
    appearanceDensity: normalizeDensity(settings.appearanceDensity),
    appearanceReduceMotion: Boolean(settings.appearanceReduceMotion),
    sidebarCompact: Boolean(settings.sidebarCompact),
  };
  const encrypted = safeStorage.encryptString(JSON.stringify(sanitized));
  await fs.writeFile(settingsFile(), encrypted, { mode: 0o600 });
}

export async function reset(): Promise<PersistedSettings> {
  try {
    await fs.unlink(settingsFile());
  } catch {
    // already gone
  }
  return { ...DEFAULT_PERSISTED_SETTINGS };
}

function normalizePrivacy(value: unknown): Privacy {
  return value === 'unlisted' || value === 'private' ? value : 'public';
}

function normalizeAccent(value: unknown): AppearanceAccent {
  return value === 'cobalt' || value === 'ember' || value === 'mono' ? value : 'purple';
}

function normalizeDensity(value: unknown): AppearanceDensity {
  return value === 'compact' ? 'compact' : 'comfortable';
}
