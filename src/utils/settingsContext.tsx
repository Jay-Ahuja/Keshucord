import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { settingsService } from '../services';
import type { UserSettings } from '../types';
import { DEFAULT_USER_SETTINGS } from '../types/settings';

export interface SettingsContextValue {
  settings: UserSettings;
  loaded: boolean;
  save(next: UserSettings): Promise<void>;
  reset(): Promise<UserSettings>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_USER_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    settingsService
      .load()
      .then((loadedSettings) => {
        if (!cancelled) setSettings(loadedSettings);
      })
      .catch(() => {
        // Fall back to defaults silently — the SettingsScreen surfaces save errors separately.
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (next: UserSettings) => {
    // Optimistic update — UI reflects the new value immediately so toggles
    // (sidebar compact, accent swatches) feel instant rather than waiting on
    // a disk round-trip. The `await` still resolves only after the write
    // completes, so callers that want to render "Saved" feedback (e.g. the
    // Settings screen) stay accurate.
    setSettings(next);
    try {
      await settingsService.save(next);
    } catch (err) {
      // Disk write failed — restore the canonical state from disk so the UI
      // doesn't lie about what's actually persisted, then surface the error.
      try {
        const fresh = await settingsService.load();
        setSettings(fresh);
      } catch {
        // Re-load also failed; leave the UI as-is and let the caller handle.
      }
      throw err;
    }
  }, []);

  const reset = useCallback(async () => {
    const fresh = await settingsService.reset();
    setSettings(fresh);
    return fresh;
  }, []);

  return (
    <SettingsContext.Provider value={{ settings, loaded, save, reset }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside <SettingsProvider>.');
  return ctx;
}
