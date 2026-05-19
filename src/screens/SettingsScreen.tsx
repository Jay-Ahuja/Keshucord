import { useEffect, useId, useState } from 'react';
import {
  BoltIcon,
  ChipIcon,
  CmdIcon,
  EyeIcon,
  LayersIcon,
  SparkleIcon,
  YouTubeIcon,
} from '../components/Icons';
import { obsService } from '../services';
import type {
  AppearanceAccent,
  AppearanceDensity,
  Privacy,
  UserSettings,
  YouTubeUser,
} from '../types';
import { initialsOf } from '../utils/format';
import { useObsStatus } from '../utils/useObsStatus';
import { useSettings } from '../utils/settingsContext';

interface Props {
  user: YouTubeUser;
  onSignOut: () => void;
}

type TabId = 'connections' | 'defaults' | 'account' | 'appearance' | 'shortcuts' | 'advanced';

const TABS: { id: TabId; label: string; icon: JSX.Element }[] = [
  { id: 'connections', label: 'Connections', icon: <ChipIcon /> },
  { id: 'defaults', label: 'Stream defaults', icon: <LayersIcon /> },
  { id: 'account', label: 'YouTube account', icon: <YouTubeIcon className="h-3.5 w-3.5" /> },
  { id: 'appearance', label: 'Appearance', icon: <SparkleIcon /> },
  { id: 'shortcuts', label: 'Shortcuts', icon: <CmdIcon /> },
  { id: 'advanced', label: 'Advanced', icon: <BoltIcon className="h-3.5 w-3.5" /> },
];

const PRIVACY_OPTIONS: { value: Privacy; label: string }[] = [
  { value: 'public', label: 'Public' },
  { value: 'unlisted', label: 'Unlisted' },
  { value: 'private', label: 'Private' },
];

const ACCENT_OPTIONS: { value: AppearanceAccent; label: string }[] = [
  { value: 'purple', label: 'Purple' },
  { value: 'cobalt', label: 'Cobalt' },
  { value: 'ember', label: 'Ember' },
  { value: 'mono', label: 'Mono' },
];

const SHORTCUTS: [string, string][] = [
  ['Overview', '⌘1'],
  ['New stream', '⌘N'],
  ['Stream Health', '⌘H'],
  ['Settings', '⌘,'],
  ['Toggle sidebar', '⌘\\'],
];

export default function SettingsScreen({ user, onSignOut }: Props) {
  const { settings, save, reset, loadFailed } = useSettings();
  const obsStatus = useObsStatus();

  const [tab, setTab] = useState<TabId>('connections');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Optimistic auto-save — every control change pushes the full UserSettings
  // through useSettings().save(), which updates context state synchronously
  // and persists to disk in the background. Errors flow back via .catch.
  const update = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    setSaveError(null);
    save({ ...settings, [key]: value })
      .then(() => setSavedAt(Date.now()))
      .catch((err: unknown) => {
        setSaveError(err instanceof Error ? err.message : 'Failed to save settings.');
      });
  };

  return (
    <div className="page fadein">
      <div className="page-head">
        <div>
          <div className="page-title">Settings</div>
          <div className="page-sub">Configure Keshucord, OBS, and your YouTube account.</div>
        </div>
        <div className="actions">
          <SyncStatusChip savedAt={savedAt} error={saveError} />
        </div>
      </div>

      {loadFailed && (
        <div
          role="alert"
          style={{
            marginBottom: 16,
            borderRadius: 10,
            border: '1px solid oklch(0.66 0.22 22 / 0.4)',
            background: 'oklch(0.66 0.22 22 / 0.08)',
            padding: '12px 14px',
            color: 'oklch(0.92 0.06 22)',
            fontSize: 12.5,
            lineHeight: 1.55,
          }}
        >
          ⚠ Couldn't load your saved settings — the app is using defaults.
          Changes you make here are NOT being saved. Try restarting Keshucord,
          or check Settings → Advanced → Reset to defaults if the issue
          persists.
        </div>
      )}

      <div className="settings">
        <div className="set-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={'set-tab' + (tab === t.id ? ' on' : '')}
              onClick={() => setTab(t.id)}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        <div className="set-section">
          {tab === 'connections' && (
            <ConnectionsTab
              settings={settings}
              update={update}
              obsStatus={obsStatus}
            />
          )}
          {tab === 'defaults' && <DefaultsTab settings={settings} update={update} />}
          {tab === 'account' && <AccountTab user={user} onSignOut={onSignOut} />}
          {tab === 'appearance' && <AppearanceTab settings={settings} update={update} />}
          {tab === 'shortcuts' && <ShortcutsTab />}
          {tab === 'advanced' && <AdvancedTab onReset={reset} />}
        </div>
      </div>
    </div>
  );
}

// ---- Header sync chip ----

function SyncStatusChip({ savedAt, error }: { savedAt: number | null; error: string | null }) {
  // Re-tick every minute so "just now" → "1m ago" updates without a save.
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    if (!savedAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, [savedAt]);

  if (error) {
    return (
      <span
        className="chip"
        style={{
          background: 'oklch(0.66 0.22 22 / 0.12)',
          borderColor: 'oklch(0.66 0.22 22 / 0.4)',
          color: 'oklch(0.86 0.14 22)',
        }}
        title={error}
      >
        Save failed
      </span>
    );
  }
  if (!savedAt) {
    return <span className="chip">Local · encrypted</span>;
  }
  const age = Math.floor((Date.now() - savedAt) / 1000);
  const label = age < 5 ? 'just now' : age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ago`;
  return <span className="chip ok">Saved · {label}</span>;
}

// ---- Connections tab ----

function ConnectionsTab({
  settings,
  update,
  obsStatus,
}: {
  settings: UserSettings;
  update: <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => void;
  obsStatus: ReturnType<typeof useObsStatus>;
}) {
  const passwordId = useId();
  const [showPassword, setShowPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    | { kind: 'success'; text: string }
    | { kind: 'error'; text: string }
    | null
  >(null);

  const handleTest = async () => {
    if (!settings.obsPassword.trim()) {
      setTestResult({ kind: 'error', text: 'Enter the OBS WebSocket password first.' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await obsService.testConnection(settings.obsPassword);
      setTestResult({ kind: result.ok ? 'success' : 'error', text: result.message });
    } finally {
      setTesting(false);
    }
  };

  const obsConnected = obsStatus.state === 'connected' || obsStatus.state === 'streaming';

  return (
    <div className="card padL">
      <h3>
        <ChipIcon /> OBS Studio
      </h3>

      <div className="set-row">
        <div className="info">
          <b>WebSocket host</b>
          <p>
            Keshucord connects to OBS over its built-in WebSocket. We use the loopback
            (<span className="mono">127.0.0.1</span>) on port <span className="mono">4455</span> —
            this isn't currently configurable.
          </p>
        </div>
        <div className="set-control">
          <input
            className="input mono"
            value="127.0.0.1"
            disabled
            style={{ maxWidth: 180 }}
            readOnly
          />
          <span className="dim mono">:</span>
          <input
            className="input mono"
            value="4455"
            disabled
            style={{ maxWidth: 90 }}
            readOnly
          />
        </div>
      </div>

      <div className="set-row">
        <div className="info">
          <b>WebSocket password</b>
          <p>
            Stored encrypted in your OS keychain. Generate or paste the password from OBS → Tools
            → WebSocket Server Settings → Show Connect Info.
          </p>
        </div>
        <div className="set-control col">
          <div className="secret">
            <input
              id={passwordId}
              className="input"
              type={showPassword ? 'text' : 'password'}
              value={settings.obsPassword}
              onChange={(e) => update('obsPassword', e.target.value)}
              placeholder="paste from OBS"
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="button"
              className="reveal"
              onClick={() => setShowPassword((v) => !v)}
            >
              <EyeIcon /> {showPassword ? 'hide' : 'show'}
            </button>
          </div>
          <div className="row gap-sm">
            <button
              type="button"
              className="btn sm"
              onClick={handleTest}
              disabled={testing}
            >
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <span
              className={
                'chip ' +
                (obsConnected ? 'ok' : obsStatus.state === 'error' ? '' : '')
              }
              style={
                obsStatus.state === 'error'
                  ? {
                      background: 'oklch(0.66 0.22 22 / 0.12)',
                      borderColor: 'oklch(0.66 0.22 22 / 0.4)',
                      color: 'oklch(0.86 0.14 22)',
                    }
                  : undefined
              }
            >
              <span
                className={
                  'dot ' +
                  (obsConnected
                    ? 'ok'
                    : obsStatus.state === 'connecting'
                    ? 'warn'
                    : obsStatus.state === 'error'
                    ? 'err'
                    : '')
                }
              />{' '}
              {obsConnected
                ? 'Connected'
                : obsStatus.state === 'connecting'
                ? 'Connecting…'
                : obsStatus.state === 'error'
                ? 'Error'
                : 'Disconnected'}
            </span>
          </div>
          {testResult && (
            <div
              role={testResult.kind === 'error' ? 'alert' : 'status'}
              style={{
                fontSize: 11.5,
                lineHeight: 1.5,
                padding: '8px 10px',
                borderRadius: 8,
                background:
                  testResult.kind === 'success'
                    ? 'oklch(0.78 0.14 158 / 0.10)'
                    : 'oklch(0.66 0.22 22 / 0.10)',
                border:
                  '1px solid ' +
                  (testResult.kind === 'success'
                    ? 'oklch(0.78 0.14 158 / 0.35)'
                    : 'oklch(0.66 0.22 22 / 0.40)'),
                color:
                  testResult.kind === 'success'
                    ? 'oklch(0.85 0.10 158)'
                    : 'oklch(0.86 0.14 22)',
              }}
            >
              {testResult.text}
            </div>
          )}
        </div>
      </div>

      <div className="set-row">
        <div className="info">
          <b>Scene collection</b>
          <p>OBS chooses this — Keshucord uses whatever scene is active when you go live.</p>
        </div>
        <div className="set-control">
          <span className="mono" style={{ color: 'var(--fg-mute)', fontSize: 12 }}>
            {obsStatus.currentScene ?? '—'}
          </span>
        </div>
      </div>
    </div>
  );
}

// ---- Defaults tab ----

function DefaultsTab({
  settings,
  update,
}: {
  settings: UserSettings;
  update: <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => void;
}) {
  const titleId = useId();
  const descId = useId();
  const categoryId = useId();

  return (
    <div className="card padL">
      <h3>
        <LayersIcon /> Default broadcast values
      </h3>

      <div className="set-row">
        <div className="info">
          <b>Default title</b>
          <p>Pre-fills the New Stream form. Leave blank to start from empty each time.</p>
        </div>
        <div className="set-control col">
          <input
            id={titleId}
            type="text"
            className="input"
            value={settings.defaultTitle}
            onChange={(e) => update('defaultTitle', e.target.value)}
            placeholder="e.g. Late night dev stream"
            maxLength={100}
          />
        </div>
      </div>

      <div className="set-row">
        <div className="info">
          <b>Default description</b>
          <p>Pre-fills the New Stream description field.</p>
        </div>
        <div className="set-control col">
          <textarea
            id={descId}
            className="textarea"
            value={settings.defaultDescription}
            onChange={(e) => update('defaultDescription', e.target.value)}
            placeholder="Tell viewers what you're streaming."
            maxLength={5000}
          />
        </div>
      </div>

      <div className="set-row">
        <div className="info">
          <b>Default privacy</b>
          <p>Applied to every new broadcast unless changed at creation.</p>
        </div>
        <div className="set-control">
          <div className="seg">
            {PRIVACY_OPTIONS.map((p) => (
              <button
                key={p.value}
                type="button"
                className={settings.defaultPrivacy === p.value ? 'on' : ''}
                onClick={() => update('defaultPrivacy', p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="set-row">
        <div className="info">
          <b>Default category</b>
          <p>Pre-fills the category select on the New Stream form.</p>
        </div>
        <div className="set-control">
          <input
            id={categoryId}
            type="text"
            className="input"
            value={settings.defaultCategory}
            onChange={(e) => update('defaultCategory', e.target.value)}
            placeholder="e.g. Gaming"
            style={{ maxWidth: 260 }}
          />
        </div>
      </div>
    </div>
  );
}

// ---- Account tab ----

function AccountTab({ user, onSignOut }: { user: YouTubeUser; onSignOut: () => void }) {
  return (
    <div className="card padL">
      <h3>
        <YouTubeIcon className="h-3.5 w-3.5" /> YouTube account
      </h3>

      <div className="set-row">
        <div className="info">
          <b>Connected channel</b>
          <p>
            OAuth scopes granted: channel info, broadcasts, livestreams. Tokens are encrypted at
            rest in your OS keychain.
          </p>
        </div>
        <div className="set-control">
          <div
            className="row"
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid var(--line-soft)',
              background: 'var(--bg-2)',
              gap: 10,
              minWidth: 0,
            }}
          >
            {user.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt=""
                style={{ width: 30, height: 30, borderRadius: '50%', objectFit: 'cover' }}
                referrerPolicy="no-referrer"
              />
            ) : (
              <div
                className="avatar"
                style={{
                  width: 30,
                  height: 30,
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                {initialsOf(user.name)}
              </div>
            )}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>
                {user.channel || user.name}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--fg-dim)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {user.email}
              </div>
            </div>
            <button
              type="button"
              className="btn sm ghost"
              onClick={onSignOut}
              style={{ marginLeft: 14 }}
            >
              Sign out
            </button>
          </div>
        </div>
      </div>

      <div className="set-row">
        <div className="info">
          <b>Add another channel</b>
          <p>Multi-account switching isn't implemented yet — sign out first to add another.</p>
        </div>
        <div className="set-control">
          <button
            type="button"
            className="btn"
            disabled
            title="Multi-account switching coming soon."
          >
            + Connect channel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Appearance tab ----

function AppearanceTab({
  settings,
  update,
}: {
  settings: UserSettings;
  update: <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => void;
}) {
  return (
    <div className="card padL">
      <h3>
        <SparkleIcon /> Appearance
      </h3>

      <div className="set-row">
        <div className="info">
          <b>Accent</b>
          <p>Dark-only, by design. Pick the room you want to work in.</p>
        </div>
        <div className="set-control">
          <div className="theme-swatches">
            {ACCENT_OPTIONS.map((a) => (
              <div
                key={a.value}
                role="button"
                tabIndex={0}
                className={`theme-sw ${a.value}${
                  settings.appearanceAccent === a.value ? ' on' : ''
                }`}
                onClick={() => update('appearanceAccent', a.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    update('appearanceAccent', a.value);
                  }
                }}
                aria-label={`${a.label} accent`}
                title={a.label}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="set-row">
        <div className="info">
          <b>Density</b>
          <p>Compact density saves space on smaller displays.</p>
        </div>
        <div className="set-control">
          <div className="seg">
            {(['comfortable', 'compact'] as AppearanceDensity[]).map((d) => (
              <button
                key={d}
                type="button"
                className={settings.appearanceDensity === d ? 'on' : ''}
                onClick={() => update('appearanceDensity', d)}
              >
                {d === 'comfortable' ? 'Comfortable' : 'Compact'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="set-row">
        <div className="info">
          <b>Reduce motion</b>
          <p>Disables non-essential animations and the launch ring's sweep transition.</p>
        </div>
        <div className="set-control">
          <Switch
            on={settings.appearanceReduceMotion}
            onChange={() => update('appearanceReduceMotion', !settings.appearanceReduceMotion)}
          />
        </div>
      </div>

      <div className="set-row">
        <div className="info">
          <b>Window glass</b>
          <p>OS-level transparency and blur behind the app. Not yet wired.</p>
        </div>
        <div className="set-control">
          <Switch on={false} disabled onChange={() => {}} />
        </div>
      </div>
    </div>
  );
}

function Switch({
  on,
  onChange,
  disabled,
}: {
  on: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={'switch' + (on ? ' on' : '')}
      role="switch"
      aria-checked={on}
      tabIndex={disabled ? -1 : 0}
      onClick={disabled ? undefined : onChange}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onChange();
        }
      }}
      style={disabled ? { opacity: 0.4, cursor: 'not-allowed' } : { cursor: 'pointer' }}
    />
  );
}

// ---- Shortcuts tab ----

function ShortcutsTab() {
  return (
    <div className="card padL">
      <h3>
        <CmdIcon /> Keyboard shortcuts
      </h3>
      <div className="col" style={{ gap: 2 }}>
        {SHORTCUTS.map(([k, v], i) => (
          <div
            key={k}
            className="row"
            style={{
              padding: '10px 4px',
              borderBottom: i < SHORTCUTS.length - 1 ? '1px dashed var(--line-soft)' : 'none',
              fontSize: 13,
            }}
          >
            <span className="flex1">{k}</span>
            <span className="kbd">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Advanced tab ----

function AdvancedTab({ onReset }: { onReset: () => Promise<UserSettings> }) {
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetDone, setResetDone] = useState(false);

  const handleReset = async () => {
    if (resetting) return;
    setResetting(true);
    setResetError(null);
    setResetDone(false);
    try {
      await onReset();
      setResetDone(true);
      window.setTimeout(() => setResetDone(false), 2000);
    } catch (err) {
      setResetError(err instanceof Error ? err.message : 'Failed to reset settings.');
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="card padL">
      <h3>
        <BoltIcon className="h-3.5 w-3.5" /> Advanced
      </h3>

      <div className="set-row">
        <div className="info">
          <b>Telemetry</b>
          <p>Anonymous crash + performance reporting. Not yet wired — currently always off.</p>
        </div>
        <div className="set-control">
          <Switch on={false} disabled onChange={() => {}} />
        </div>
      </div>

      <div className="set-row">
        <div className="info">
          <b>Experimental features</b>
          <p>Multistream targets, automated highlights, AI scene suggestions — none implemented yet.</p>
        </div>
        <div className="set-control">
          <Switch on={false} disabled onChange={() => {}} />
        </div>
      </div>

      <div className="set-row">
        <div className="info">
          <b>Log level</b>
          <p>Console verbosity for debugging. Not yet wired.</p>
        </div>
        <div className="set-control">
          <select className="select" defaultValue="info" disabled style={{ maxWidth: 160 }}>
            <option value="error">error</option>
            <option value="warn">warn</option>
            <option value="info">info</option>
            <option value="debug">debug</option>
          </select>
        </div>
      </div>

      <div className="set-row">
        <div className="info">
          <b>Reset settings</b>
          <p>
            Wipes the encrypted settings file (defaults + OBS password). YouTube tokens are kept
            — sign out from the Account tab to revoke them.
          </p>
        </div>
        <div className="set-control col">
          <button
            type="button"
            className="btn"
            onClick={handleReset}
            disabled={resetting}
            style={{
              alignSelf: 'flex-end',
              borderColor: 'oklch(0.66 0.22 22 / 0.45)',
              color: 'oklch(0.86 0.14 22)',
            }}
          >
            {resetting ? 'Resetting…' : 'Reset to defaults'}
          </button>
          {resetDone && (
            <span style={{ fontSize: 11.5, color: 'oklch(0.85 0.10 158)', textAlign: 'right' }}>
              Settings reset.
            </span>
          )}
          {resetError && (
            <span style={{ fontSize: 11.5, color: 'oklch(0.86 0.14 22)', textAlign: 'right' }}>
              {resetError}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
