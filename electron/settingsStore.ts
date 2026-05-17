import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './atomicWrite';

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

function isFileNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

export async function load(): Promise<PersistedSettings> {
  let encrypted: Buffer;
  try {
    encrypted = await fs.readFile(settingsFile());
  } catch (err) {
    if (isFileNotFound(err)) {
      // No settings yet — return defaults silently. This is the first-run path.
      return { ...DEFAULT_PERSISTED_SETTINGS };
    }
    console.warn(
      '[settings] Could not read settings.enc — falling back to defaults:',
      err instanceof Error ? err.message : err,
    );
    return { ...DEFAULT_PERSISTED_SETTINGS };
  }

  // Surface decryption / parse failure separately from "file missing" — it's
  // actionable for support (corrupted blob, keychain rotation, different OS
  // user) and helps explain "where did my preferences go?".
  try {
    const json = safeStorage.decryptString(encrypted);
    const parsed = JSON.parse(json) as Partial<PersistedSettings>;
    // Merge with defaults so older payloads pick up any newly-added fields,
    // then run every field through the same normalize guards as `save` so a
    // corrupted/tampered file can't propagate bad enum values to the renderer.
    return normalize({ ...DEFAULT_PERSISTED_SETTINGS, ...parsed });
  } catch (err) {
    console.warn(
      '[settings] settings.enc decrypt/parse failed — falling back to defaults. ' +
        'The file may have been written under a different OS user or the keychain has rotated.',
      err instanceof Error ? err.message : err,
    );
    return { ...DEFAULT_PERSISTED_SETTINGS };
  }
}

export async function save(settings: PersistedSettings): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS-level encryption is unavailable; refusing to write settings in plaintext.',
    );
  }
  const sanitized = normalize(settings);
  const encrypted = safeStorage.encryptString(JSON.stringify(sanitized));
  // Atomic write via tmp+rename — a crash mid-write can no longer leave a
  // half-encrypted settings.enc that fails to decrypt on next boot.
  await atomicWrite(settingsFile(), encrypted, 0o600);
}

export async function reset(): Promise<PersistedSettings> {
  try {
    await fs.unlink(settingsFile());
  } catch (err) {
    if (!isFileNotFound(err)) {
      console.warn(
        '[settings] reset: could not unlink settings.enc:',
        err instanceof Error ? err.message : err,
      );
    }
    // already gone — fall through
  }
  return { ...DEFAULT_PERSISTED_SETTINGS };
}

/**
 * Coerce a partial / possibly-malformed settings object into a valid
 * PersistedSettings. Run on every load and every save so neither path can
 * propagate a bad enum value or non-string into the renderer / onto disk.
 */
function normalize(settings: Partial<PersistedSettings>): PersistedSettings {
  return {
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
