import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PlaceholderScreen } from './components/PlaceholderScreen';
import { Sidebar } from './components/Sidebar';
import { Spinner } from './components/Spinner';
import { TitleBar } from './components/TitleBar';
import CreateScreen from './screens/CreateScreen';
import DashScreen from './screens/DashScreen';
import LaunchStatusScreen from './screens/LaunchStatusScreen';
import LoginScreen from './screens/LoginScreen';
import SettingsScreen from './screens/SettingsScreen';
import { abortActiveLaunch, awaitActiveLaunchSettled, obsService, youtubeService } from './services';
import type { Screen, StreamSettings, UserSettings, YouTubeBroadcast, YouTubeUser } from './types';
import { DEFAULT_USER_SETTINGS } from './types/settings';
import { applyAccent } from './utils/applyAccent';
import { formatDuration } from './utils/format';
import { useObsStatus } from './utils/useObsStatus';
import { useSettings } from './utils/settingsContext';
import { useStreamHealth } from './utils/useStreamHealth';

function toStreamSettings(u: UserSettings): StreamSettings {
  return {
    title: u.defaultTitle,
    description: u.defaultDescription,
    privacy: u.defaultPrivacy,
    category: u.defaultCategory,
    obsPassword: u.obsPassword,
  };
}

const INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export default function App() {
  const { settings: userSettings, loaded: settingsLoaded, save: saveUserSettings } = useSettings();
  const obsStatus = useObsStatus();
  const health = useStreamHealth();

  const [authBootstrapping, setAuthBootstrapping] = useState(true);
  const [screen, setScreen] = useState<Screen>('login');
  const [user, setUser] = useState<YouTubeUser | null>(null);
  const [activeBroadcast, setActiveBroadcast] = useState<YouTubeBroadcast | null>(null);

  // Mirror `screen` into a ref so stable callbacks (notably `handleBroadcastLive`
  // below) can read the current value without taking a dep on it. Keeping
  // `handleBroadcastLive`'s deps array empty is load-bearing: a fresh identity
  // would re-fire LaunchStatusScreen's launch-firing useEffect and restart the
  // launch mid-flight.
  const screenRef = useRef(screen);
  useEffect(() => {
    screenRef.current = screen;
  });

  // Controlled form state for the launch flow. Lives at the app level so it
  // survives navigation to other screens without losing in-progress edits.
  const [streamSettings, setStreamSettings] = useState<StreamSettings>(() =>
    toStreamSettings(DEFAULT_USER_SETTINGS),
  );
  const [seededFromUserDefaults, setSeededFromUserDefaults] = useState(false);

  // ---- bootstrap ----

  useEffect(() => {
    let cancelled = false;
    youtubeService
      .getCurrentUser()
      .then((existing) => {
        if (cancelled) return;
        if (existing) {
          setUser(existing);
          setScreen('create');
        }
      })
      .catch(() => {
        // fall through to login
      })
      .finally(() => {
        if (!cancelled) setAuthBootstrapping(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (settingsLoaded && !seededFromUserDefaults) {
      setStreamSettings(toStreamSettings(userSettings));
      setSeededFromUserDefaults(true);
    }
  }, [settingsLoaded, userSettings, seededFromUserDefaults]);

  // ---- visual chrome side-effects ----

  // Push the accent into CSS variables on `:root` so every keshucord.css rule
  // that references `var(--acc*)` updates immediately.
  useEffect(() => {
    applyAccent(userSettings.appearanceAccent);
  }, [userSettings.appearanceAccent]);

  // ---- navigation handlers ----

  const handleNavigate = useCallback((next: Screen) => {
    setScreen(next);
  }, []);

  const handleToggleSidebar = useCallback(() => {
    void saveUserSettings({
      ...userSettings,
      sidebarCompact: !userSettings.sidebarCompact,
    });
  }, [userSettings, saveUserSettings]);

  const handleSignOut = useCallback(async () => {
    // H6: drain any in-flight launch BEFORE clearing auth tokens. The
    // launch's cleanup branch calls youtube.deleteBroadcast /
    // deleteLiveStream, which need valid tokens. Without this drain, sign-out
    // -mid-launch racing the launch's own catch block leaves orphan resources
    // on the user's YouTube channel.
    abortActiveLaunch();
    await awaitActiveLaunchSettled().catch(() => {
      // expected — the launch was aborted
    });

    // H2: disconnect OBS so the next session doesn't inherit a 'streaming'
    // state from this user's broadcast (the obsService instance is
    // module-scoped and survives sign-out). Best-effort: ignore failures, OBS
    // may be unreachable.
    await obsService.disconnect().catch(() => undefined);

    try {
      await youtubeService.signOut();
    } catch {
      // local state resets regardless
    }
    setUser(null);
    setActiveBroadcast(null);
    setStreamSettings(toStreamSettings(userSettings));
    setScreen('login');
  }, [userSettings]);

  // Stable identity is critical here: LaunchStatusScreen's launch-firing
  // useEffect must never re-fire because a new callback identity slipped in.
  // `setActiveBroadcast` is stable from useState, so empty deps are safe.
  //
  // Auto-advance to Dash on successful launch. We read `screen` via
  // `screenRef` (not a dep) so we don't break the stable identity contract
  // above. The `=== 'launch'` guard prevents yanking the user to Dash if
  // they manually navigated away mid-flight (e.g. opened Settings while
  // waiting for the stream to go active). Do NOT add `screen` to deps —
  // that would defeat the whole point.
  const handleBroadcastLive = useCallback((b: YouTubeBroadcast) => {
    setActiveBroadcast(b);
    if (screenRef.current === 'launch') {
      setScreen('dash');
    }
  }, []);

  // Stable identity for DashScreen's onEnded — same reasoning. Clearing the
  // broadcast here also lets the user start a new launch cleanly.
  const handleBroadcastEnded = useCallback(() => {
    setActiveBroadcast(null);
  }, []);

  // ---- keyboard shortcuts ----

  useEffect(() => {
    if (!user) return; // shortcuts only active once signed in
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      // Don't capture while the user is typing in a form field — the only
      // exception below is the sidebar-toggle which is harmless globally.
      const target = e.target as HTMLElement | null;
      const inInput = target ? INPUT_TAGS.has(target.tagName) || target.isContentEditable : false;

      if (e.key === '\\') {
        e.preventDefault();
        handleToggleSidebar();
        return;
      }
      if (inInput) return;

      if (e.key === '1') {
        e.preventDefault();
        setScreen('home');
      } else if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setScreen('create');
      } else if (e.key.toLowerCase() === 'h') {
        e.preventDefault();
        setScreen('dash');
      } else if (e.key === ',') {
        e.preventDefault();
        setScreen('settings');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [user, handleToggleSidebar]);

  // ---- derived ----

  // Settings handed off to LaunchStatusScreen. We splice the live
  // userSettings.obsPassword in over streamSettings (which is seeded only
  // once at boot — see seededFromUserDefaults above) so a password set in
  // Settings between Go Live attempts actually reaches the orchestrator.
  //
  // CRITICAL: this MUST be memoized. LaunchStatusScreen's launch-firing
  // useEffect depends on the `settings` reference; if we pass a new object
  // literal on every App render, the effect re-fires on every render. App
  // re-renders on every useObsStatus() change (which fires at step 7 when
  // OBS connects), which would abort and restart the launch in a feedback
  // loop — the mutex's cleanup branch disconnects OBS, which fires another
  // status change, ad infinitum. Steps 1–5 re-run, OBS oscillates
  // connected/disconnected, the user is stuck on "Connecting to OBS".
  const launchSettings = useMemo(
    () => ({ ...streamSettings, obsPassword: userSettings.obsPassword }),
    [streamSettings, userSettings.obsPassword],
  );

  const bootstrapping = authBootstrapping || !settingsLoaded;
  const showSidebar = !bootstrapping && user !== null && screen !== 'login';
  const isLive = obsStatus.state === 'streaming';
  const liveDuration =
    isLive && health?.outputDurationMs ? formatDuration(health.outputDurationMs) : undefined;

  // ---- render ----

  return (
    <div className={'app' + (userSettings.sidebarCompact ? ' compact' : '')}>
      <TitleBar page={screen} isLive={isLive} liveDuration={liveDuration} />
      {showSidebar && user && (
        <Sidebar
          page={screen}
          onNavigate={handleNavigate}
          onToggleCompact={handleToggleSidebar}
          onSignOut={handleSignOut}
          user={user}
          obsStatus={obsStatus}
        />
      )}
      <main
        className="main"
        style={!showSidebar ? { gridColumn: '1 / -1' } : undefined}
      >
        {bootstrapping ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-white/40">
            <Spinner size="lg" />
            <span className="text-xs uppercase tracking-[0.3em]">Loading session…</span>
          </div>
        ) : (
          renderScreen()
        )}
      </main>
    </div>
  );

  function renderScreen() {
    // --- New-design screens that own their own full-bleed layout ---
    if (screen === 'login') {
      return (
        <LoginScreen
          onSignedIn={(signedIn) => {
            // Reset the "seeded from user defaults" latch BEFORE updating the
            // user so the seeding effect on lines 73-77 re-fires for the new
            // account's stored defaults. Without this, the previous account's
            // form values (title/description/privacy/category) would leak
            // into the new user's CreateScreen — a cross-account data leak
            // that's both confusing and a privacy footgun.
            setSeededFromUserDefaults(false);
            setUser(signedIn);
            setScreen('create');
          }}
        />
      );
    }
    if (screen === 'home') {
      return (
        <PlaceholderScreen
          title="Overview"
          subtitle="Your dashboard for stream activity, presets, and quick start."
        />
      );
    }
    if (screen === 'dash') {
      return (
        <DashScreen
          broadcastId={activeBroadcast?.id ?? null}
          onEnded={handleBroadcastEnded}
        />
      );
    }
    if (screen === 'history') {
      return (
        <PlaceholderScreen
          title="History"
          subtitle="Past broadcasts, drafts and recordings."
        />
      );
    }
    if (screen === 'help') {
      return (
        <PlaceholderScreen
          title="Help & Docs"
          subtitle="Get unstuck fast, or learn what Keshucord can do."
        />
      );
    }
    if (screen === 'create' && user) {
      return (
        <CreateScreen
          user={user}
          value={streamSettings}
          onChange={setStreamSettings}
          onSubmit={(next) => {
            setStreamSettings(next);
            setScreen('launch');
          }}
        />
      );
    }
    if (screen === 'launch' && user) {
      return (
        <LaunchStatusScreen
          settings={launchSettings}
          user={user}
          onBack={() => setScreen('create')}
          onOpenDashboard={() => setScreen('dash')}
          onBroadcastLive={handleBroadcastLive}
        />
      );
    }
    if (screen === 'settings' && user) {
      return <SettingsScreen user={user} onSignOut={handleSignOut} />;
    }

    // Defensive fallback — should never render given the route guards above.
    return null;
  }
}
