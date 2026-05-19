import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { settingsService } from '../services';
import type { UserSettings } from '../types';
import { DEFAULT_USER_SETTINGS } from '../types/settings';

export interface SettingsContextValue {
  settings: UserSettings;
  loaded: boolean;
  loadFailed: boolean;
  save(next: UserSettings): Promise<void>;
  reset(): Promise<UserSettings>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_USER_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  // Sequential save queue. Without this, two rapid keystrokes can produce two
  // in-flight `settingsService.save` calls whose writes race — the older
  // payload's `fs.writeFile` may finish *after* the newer one's, leaving disk
  // state out of sync with the optimistic React state.
  //
  // Strategy: chain every save onto a single tail promise so only one write
  // hits disk at a time. Errors don't break the chain (the lock catches them
  // for chaining purposes; the caller's promise still rejects). If a newer
  // save arrives while one is queued, the older queued call detects that and
  // skips its actual write — its promise resolves once the newer value has
  // persisted, since "latest input wins" matches the user's intent.
  const writeLock = useRef<Promise<unknown>>(Promise.resolve());
  const latestRequestId = useRef(0);

  useEffect(() => {
    let cancelled = false;
    settingsService
      .load()
      .then((loadedSettings) => {
        if (!cancelled) setSettings(loadedSettings);
      })
      .catch(() => {
        // Surface the load failure to the UI. Without this, the first auto-save
        // would silently overwrite a (potentially recoverable) on-disk file
        // with DEFAULT_USER_SETTINGS — see audit H4.
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback((next: UserSettings) => {
    // Refuse to write when the initial load failed — otherwise the first
    // save would overwrite a (potentially recoverable) on-disk file with
    // defaults. See audit H4. This also skips the optimistic in-memory
    // update; the SettingsScreen banner explains why inputs revert.
    if (loadFailed) {
      return Promise.reject(
        new Error('Settings did not load from disk — refusing to save until this is resolved.')
      );
    }

    // Optimistic update — UI reflects the new value immediately so toggles
    // (sidebar compact, accent swatches) feel instant rather than waiting on
    // a disk round-trip.
    setSettings(next);
    const myRequestId = ++latestRequestId.current;

    const myPromise = writeLock.current.then(async () => {
      // If a newer save() call has come in while we were queued, skip our
      // actual write — the newer one will overwrite us anyway, and skipping
      // avoids two back-to-back disk writes plus a guaranteed-stale write.
      // The caller's promise still resolves successfully: their intent ("save
      // this value or any newer one") is satisfied.
      if (latestRequestId.current !== myRequestId) return;
      try {
        await settingsService.save(next);
      } catch (err) {
        // Disk write failed — restore the canonical state from disk so the UI
        // doesn't lie about what's actually persisted, then surface the error.
        // BUT only if our save is still the latest one in flight; otherwise a
        // newer queued save's optimistic value is what the user just typed,
        // and reloading stale disk content would erase their input. See audit
        // H5.
        if (latestRequestId.current === myRequestId) {
          try {
            const fresh = await settingsService.load();
            setSettings(fresh);
          } catch {
            // Re-load also failed; leave the UI as-is and let the caller handle.
          }
        }
        throw err;
      }
    });

    // Chain the lock onto our promise but SWALLOW errors so the next save
    // isn't blocked on this one's failure. The caller still sees the error
    // via `myPromise`.
    writeLock.current = myPromise.catch(() => undefined);

    return myPromise;
  }, [loadFailed]);

  const reset = useCallback(async () => {
    // Refuse to write defaults when we don't trust the load state — same
    // reasoning as save(). See audit H4.
    if (loadFailed) {
      throw new Error(
        'Settings did not load from disk — refusing to reset until this is resolved.'
      );
    }

    // A reset must drain any queued saves first so we don't race-overwrite
    // the freshly-reset file. Wait for the current chain to settle, bump the
    // request id so any in-flight coalesced saves no-op, then perform reset.
    const drainPromise = writeLock.current.catch(() => undefined);
    const resetPromise = drainPromise.then(async () => {
      latestRequestId.current += 1;
      const fresh = await settingsService.reset();
      setSettings(fresh);
      return fresh;
    });
    writeLock.current = resetPromise.catch(() => undefined);
    return resetPromise;
  }, [loadFailed]);

  return (
    <SettingsContext.Provider value={{ settings, loaded, loadFailed, save, reset }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside <SettingsProvider>.');
  return ctx;
}
