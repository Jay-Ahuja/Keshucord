import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ArrowRightIcon,
  BoltIcon,
  CheckIcon,
  ClockIcon,
  LayersIcon,
  LiveIcon,
  SparkleIcon,
  UploadIcon,
  WifiIcon,
} from '../components/Icons';
import { ObsLaunchDialog } from '../components/ObsLaunchDialog';
import { probe as probeObs } from '../services/obsService';
import type {
  OBSConnectionState,
  Privacy,
  StreamSettings,
  YouTubeUser,
} from '../types';
import { formatDatePrefix } from '../utils/format';
import { useObsStatus } from '../utils/useObsStatus';
import { useSettings } from '../utils/settingsContext';

interface Props {
  user: YouTubeUser;
  /** Controlled form value — state lives in App so it survives screen navigation. */
  value: StreamSettings;
  onChange: (value: StreamSettings) => void;
  onSubmit: (value: StreamSettings) => void;
}

interface Preset {
  id: string;
  label: string;
  icon: JSX.Element;
}

const PRESETS: Preset[] = [
  { id: 'gameplay', label: 'Gameplay · 1080p60', icon: <BoltIcon className="h-3 w-3" /> },
  { id: 'irl', label: 'IRL · 720p60', icon: <WifiIcon className="h-3 w-3" /> },
  { id: 'podcast', label: 'Podcast · 1080p30', icon: <LayersIcon className="h-3 w-3" /> },
  { id: 'event', label: 'Live Event · 1440p60', icon: <SparkleIcon className="h-3 w-3" /> },
];

const CATEGORIES = [
  'Science & Technology',
  'Gaming',
  'Music',
  'Education',
  'Entertainment',
  'People & Blogs',
];

const PRIVACY_OPTIONS: { id: Privacy; label: string; desc: string }[] = [
  { id: 'public', label: 'Public', desc: 'Anyone can find and watch' },
  { id: 'unlisted', label: 'Unlisted', desc: 'Anyone with the link' },
  { id: 'private', label: 'Private', desc: 'Only you and invitees' },
];

function privacyDisplay(p: Privacy): string {
  return PRIVACY_OPTIONS.find((o) => o.id === p)?.label ?? 'Public';
}

interface PreflightRow {
  ok: 'ok' | 'warn' | 'err' | 'placeholder';
  label: string;
  sub: string;
  showCheck: boolean;
}

function obsPreflight(state: OBSConnectionState): PreflightRow {
  switch (state) {
    case 'connected':
    case 'streaming':
      return { ok: 'ok', label: 'OBS WebSocket reachable', sub: '127.0.0.1:4455', showCheck: true };
    case 'connecting':
      return { ok: 'warn', label: 'OBS WebSocket', sub: 'connecting…', showCheck: false };
    case 'error':
      return { ok: 'err', label: 'OBS WebSocket error', sub: 'see Settings → Connections', showCheck: false };
    default:
      return {
        ok: 'warn',
        label: 'OBS WebSocket',
        sub: 'connects automatically on Go Live',
        showCheck: false,
      };
  }
}

export default function CreateScreen({ user, value, onChange, onSubmit }: Props) {
  const obsStatus = useObsStatus();
  const { settings: userSettings } = useSettings();

  // --- titleDatePrefix mount effect.
  //
  // When `userSettings.titleDatePrefix` is on, prepend today's `M/D/YYYY - `
  // to the title field exactly once per CreateScreen mount, as long as the
  // title doesn't already start with today's date.
  //
  // Why a useRef guard:
  // - StrictMode double-mounts every component in dev, which would otherwise
  //   trigger the prefix logic twice. The second pass would see the already-
  //   prefixed value and (because of the duplicate-prefix check) skip — but
  //   that's load-bearing and easy to break, so the ref guards it explicitly.
  // - Re-mount on Settings → Create navigation is desired behavior: each visit
  //   re-applies the prefix based on the current date and current toggle, so
  //   a user who flips the toggle and navigates back gets the expected result.
  //
  // We read `userSettings` / `value` / `onChange` via refs so the empty-deps
  // closure can never see a stale value or pin an old `onChange` identity.
  const userSettingsRef = useRef(userSettings);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    userSettingsRef.current = userSettings;
  }, [userSettings]);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const datePrefixAppliedRef = useRef(false);
  useEffect(() => {
    if (datePrefixAppliedRef.current) return;
    datePrefixAppliedRef.current = true;
    if (!userSettingsRef.current.titleDatePrefix) return;
    const todayPrefix = formatDatePrefix();
    const currentTitle = valueRef.current.title;
    // Idempotency: if the title already starts with today's date, leave it
    // alone — the user has already seen and (possibly) edited the prefix.
    // We deliberately don't strip a stale prefix from a previous day; the
    // user controls the title once it's been seeded.
    if (currentTitle.startsWith(todayPrefix)) return;
    onChangeRef.current({
      ...valueRef.current,
      title: `${todayPrefix} - ${currentTitle}`,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Mock-only UI state for design fields not backed by real settings yet.
  //     Per the integration plan these are visible for visual completeness but
  //     don't persist anywhere; they reset whenever the user leaves the screen.
  const [preset, setPreset] = useState('gameplay');
  const [tags, setTags] = useState('');
  const [schedule, setSchedule] = useState<'now' | 'later'>('now');
  const [notify, setNotify] = useState(true);
  const [showAdv, setShowAdv] = useState(false);

  // Thumbnail picker. `value.thumbnailFile` is the persisted (in-memory)
  // File on StreamSettings; `previewUrl` is derived locally because object
  // URLs are tied to the renderer's lifecycle, not to a serialisable state.
  // We regenerate the preview URL whenever the File on `value` changes, and
  // revoke the prior URL to avoid the well-known browser-memory leak.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!value.thumbnailFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(value.thumbnailFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [value.thumbnailFile]);
  const thumbFilled = previewUrl !== null;

  const titleId = useId();
  const descId = useId();
  const categoryId = useId();
  const tagsId = useId();
  const dateId = useId();
  const timeId = useId();

  // Real fields → flow back through onChange.
  const update = <K extends keyof StreamSettings>(key: K, next: StreamSettings[K]) =>
    onChange({ ...value, [key]: next });

  const handleThumbnailPick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);
  const handleThumbnailChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0] ?? null;
      // Defensive — the accept attribute filters in the picker UI, but
      // drag-drop on platforms that ignore `accept` can still hand us a
      // GIF/SVG/etc. YouTube only takes JPEG and PNG.
      if (file && file.type !== 'image/jpeg' && file.type !== 'image/png') {
        console.warn('[create] thumbnail picker rejected non-JPEG/PNG:', file.type);
        update('thumbnailFile', undefined);
      } else {
        update('thumbnailFile', file ?? undefined);
      }
      // Allow re-selecting the same file (input.onChange doesn't fire if
      // the value is identical to last time).
      e.target.value = '';
    },
    [update],
  );
  const handleThumbnailRemove = useCallback(
    (e: React.MouseEvent) => {
      // Stop the click from bubbling to .thumb-drop, which would re-open
      // the picker on the same click.
      e.stopPropagation();
      update('thumbnailFile', undefined);
    },
    [update],
  );

  // If the saved category isn't one of the design's predefined options,
  // include it as a leading select option so we don't silently drop it.
  const includeCustom = value.category.length > 0 && !CATEGORIES.includes(value.category);
  const categoryOptions = useMemo(
    () => (includeCustom ? [value.category, ...CATEGORIES] : CATEGORIES),
    [includeCustom, value.category],
  );

  const passwordSet = value.obsPassword.trim().length > 0;
  const titleValid = value.title.trim().length > 0;
  const isStreaming = obsStatus.state === 'streaming';

  // Pre-flight gating UI state. `obsDialogOpen` covers both the prompt and
  // the in-flight launch — the Go Live button is disabled the whole time so
  // the user can't trigger a parallel probe by double-clicking.
  // `probing` covers the brief window between the click and either the
  // dialog opening or onSubmit firing (probe() itself is fast — capped at
  // 1.5s — but the click needs to feel inert while it's outstanding).
  const [probing, setProbing] = useState(false);
  const [obsDialogOpen, setObsDialogOpen] = useState(false);

  // Submit gating. Missing OBS password is now gated here — `validateSettings`
  // (step 1 of the orchestrator) rejects an empty password, so without this
  // gate the user pays a screen transition + 250ms validate sleep + bounce
  // back to Create for a config we already know is bad. The pre-flight side
  // panel below already surfaces "OBS WebSocket password: not set"; this
  // wires the same signal into the button.
  const blockReason: string | null = !titleValid
    ? 'Add a title to continue.'
    : !passwordSet
    ? 'Set your OBS WebSocket password in Settings before launching.'
    : isStreaming
    ? 'OBS is already streaming — stop it before launching a managed broadcast.'
    : schedule === 'later'
    ? 'Scheduling lands in a follow-up — switch to “Start now” to launch.'
    : null;
  // Local-validation gate. We track this separately from `canSubmit` so the
  // button reflects both "form is valid" AND "no preflight in flight".
  const formValid = blockReason === null;
  const canSubmit = formValid && !probing && !obsDialogOpen;

  /**
   * Trim + freeze the form values once we know the launch is going through.
   * Reused by both the direct-onSubmit path (OBS already running) and the
   * post-dialog path (user launched OBS and we proceed).
   */
  const fireSubmit = useCallback(() => {
    onSubmit({
      ...value,
      title: value.title.trim(),
      description: value.description.trim(),
      category: value.category.trim(),
    });
  }, [onSubmit, value]);

  /**
   * Go Live click handler with the OBS pre-flight gate.
   *
   * Order of operations (must not change):
   *   1. local form validation — bail out silently if `!formValid` (button
   *      is already disabled in this case, but defending against keyboard
   *      shortcut callers).
   *   2. `probe()` — fast raw-WebSocket check. NO state mutation in
   *      `obsService` — see the comment block above `probe()`.
   *   3. if reachable: hand off to `onSubmit` (App.tsx routes to launch).
   *      if NOT reachable: open the launch-OBS dialog. The dialog drives
   *      `launchAndWait()` and calls back into `handleObsLaunched` on
   *      success.
   *
   * Defensive: if `probe()` itself throws (shouldn't — it catches
   * everything internally), we log and open the dialog rather than
   * silently dropping the click. Better to ask the user than to leave
   * them tapping a dead button.
   */
  const handleSubmit = useCallback(async () => {
    if (!formValid || probing || obsDialogOpen) return;
    setProbing(true);
    let reachable = false;
    try {
      reachable = await probeObs();
    } catch (err) {
      console.warn('[obs] preflight probe threw unexpectedly:', err);
      reachable = false;
    } finally {
      setProbing(false);
    }
    if (reachable) {
      fireSubmit();
    } else {
      setObsDialogOpen(true);
    }
  }, [formValid, probing, obsDialogOpen, fireSubmit]);

  const handleObsLaunched = useCallback(() => {
    setObsDialogOpen(false);
    fireSubmit();
  }, [fireSubmit]);

  const handleObsDialogClose = useCallback(() => {
    setObsDialogOpen(false);
  }, []);

  const preflightOBS = obsPreflight(obsStatus.state);

  return (
    <div className="page fadein">
      <div className="page-head">
        <div>
          <div className="page-title">Set up your stream</div>
          <div className="page-sub">
            We'll create the broadcast on YouTube and configure OBS the moment you hit Go Live.
          </div>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn ghost"
            title="Drafts haven't been implemented yet."
            disabled
          >
            <ClockIcon className="h-3.5 w-3.5" /> Save as draft
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            title={
              blockReason ??
              (probing
                ? 'Checking OBS…'
                : obsDialogOpen
                ? 'Finish the OBS launch dialog to continue.'
                : 'Create the broadcast and start streaming')
            }
          >
            Go Live <ArrowRightIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="create">
        {/* LEFT — main form */}
        <div className="col" style={{ gap: 22 }}>
          {/* Preset bar (mock UI) */}
          <div className="preset-bar fadein d1">
            <span
              style={{
                fontSize: 11,
                color: 'var(--fg-dim)',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                marginRight: 4,
              }}
            >
              Preset
            </span>
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={'chip' + (preset === p.id ? ' acc' : '')}
                onClick={() => setPreset(p.id)}
                style={{ cursor: 'pointer' }}
              >
                {p.icon} {p.label}
              </button>
            ))}
          </div>

          {/* Thumbnail (real file picker) */}
          <div className="card pad fadein d2">
            <h3>
              Thumbnail <span className="tag">1920×1080 · PNG/JPG · up to 2 MB</span>
            </h3>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png"
              onChange={handleThumbnailChange}
              style={{ display: 'none' }}
            />
            <div
              className={'thumb-drop' + (thumbFilled ? ' filled' : '')}
              onClick={handleThumbnailPick}
              role="button"
              tabIndex={0}
              title={thumbFilled ? 'Click to choose a different image' : 'Click to choose an image'}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleThumbnailPick();
                }
              }}
              style={thumbFilled ? { padding: 0, overflow: 'hidden' } : undefined}
            >
              {thumbFilled && previewUrl ? (
                <img
                  src={previewUrl}
                  alt="Selected thumbnail preview"
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
              ) : (
                <>
                  <div className="ic">
                    <UploadIcon className="h-6 w-6" />
                  </div>
                  <div>Drop an image or click to upload</div>
                  <div className="sm">JPEG · PNG · up to 2 MB</div>
                </>
              )}
            </div>
            {value.thumbnailFile && (
              <div
                className="row"
                style={{ marginTop: 8, fontSize: 12, color: 'var(--fg-mute)' }}
              >
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                  }}
                  title={value.thumbnailFile.name}
                >
                  {value.thumbnailFile.name}{' '}
                  <span style={{ color: 'var(--fg-ghost)' }}>
                    · {(value.thumbnailFile.size / 1024).toFixed(0)} KB
                  </span>
                </span>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={handleThumbnailRemove}
                >
                  Remove
                </button>
              </div>
            )}
          </div>

          {/* Details (real) */}
          <div className="card pad fadein d3">
            <h3>Details</h3>
            <div className="form-grid">
              <div className="field full">
                <label htmlFor={titleId}>
                  Title <span className="hint">{value.title.length}/100</span>
                </label>
                <input
                  id={titleId}
                  type="text"
                  className="input"
                  placeholder="Late night dev stream — building a chat overlay"
                  value={value.title}
                  onChange={(e) => update('title', e.target.value)}
                  maxLength={100}
                  required
                />
              </div>
              <div className="field full">
                <label htmlFor={descId}>Description</label>
                <textarea
                  id={descId}
                  className="textarea"
                  placeholder="Tell viewers what you're streaming. Mention chapters, links, and your social handles."
                  value={value.description}
                  onChange={(e) => update('description', e.target.value)}
                  maxLength={5000}
                />
              </div>
              <div className="field">
                <label htmlFor={categoryId}>Category</label>
                <select
                  id={categoryId}
                  className="select"
                  value={value.category || CATEGORIES[0]}
                  onChange={(e) => update('category', e.target.value)}
                >
                  {categoryOptions.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor={tagsId}>
                  Tags <span className="hint">comma separated · mock</span>
                </label>
                <input
                  id={tagsId}
                  type="text"
                  className="input"
                  placeholder="coding, devstream, indie"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                />
              </div>
              <div className="field full">
                <label>Privacy</label>
                <div className="privacy-radio">
                  {PRIVACY_OPTIONS.map((o) => {
                    const selected = value.privacy === o.id;
                    return (
                      <div
                        key={o.id}
                        className={'opt' + (selected ? ' on' : '')}
                        onClick={() => update('privacy', o.id)}
                        role="radio"
                        aria-checked={selected}
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            update('privacy', o.id);
                          }
                        }}
                      >
                        <b>
                          {selected ? (
                            <span style={{ color: 'var(--acc-hi)' }}>
                              <CheckIcon className="h-2.5 w-2.5" />
                            </span>
                          ) : (
                            <span
                              style={{
                                width: 11,
                                height: 11,
                                border: '1.5px solid var(--line)',
                                borderRadius: 99,
                                display: 'inline-block',
                              }}
                            />
                          )}
                          {o.label}
                        </b>
                        <span>{o.desc}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Schedule (now is real; later is UI-only) */}
          <div className="card pad fadein d4">
            <h3>
              Schedule <span className="tag">Optional</span>
            </h3>
            <div className="row" style={{ marginBottom: 12 }}>
              <div className="seg">
                <button
                  type="button"
                  className={schedule === 'now' ? 'on' : ''}
                  onClick={() => setSchedule('now')}
                >
                  Start now
                </button>
                <button
                  type="button"
                  className={schedule === 'later' ? 'on' : ''}
                  onClick={() => setSchedule('later')}
                >
                  Schedule
                </button>
              </div>
              <span style={{ fontSize: 12, color: 'var(--fg-dim)' }}>
                {schedule === 'now'
                  ? 'Broadcast goes live the moment OBS connects.'
                  : 'Scheduling lands in a follow-up — switch to “Start now” to launch.'}
              </span>
            </div>
            {schedule === 'later' && (
              <div className="form-grid">
                <div className="field">
                  <label htmlFor={dateId}>Date</label>
                  <input id={dateId} className="input" type="date" defaultValue="" disabled />
                </div>
                <div className="field">
                  <label htmlFor={timeId}>Time</label>
                  <input id={timeId} className="input" type="time" defaultValue="" disabled />
                </div>
                <div className="field full">
                  <label>Notify subscribers</label>
                  <div className="row">
                    <div
                      className={'switch' + (notify ? ' on' : '')}
                      onClick={() => setNotify((v) => !v)}
                      role="switch"
                      aria-checked={notify}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setNotify((v) => !v);
                        }
                      }}
                    />
                    <span style={{ fontSize: 12.5, color: 'var(--fg-mute)' }}>
                      Send the standard YouTube premiere announcement.
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Advanced (mock UI — none of these fields are wired) */}
          <details className="card pad collapsible fadein d5" open={showAdv}>
            <summary
              onClick={(e) => {
                e.preventDefault();
                setShowAdv((s) => !s);
              }}
            >
              Advanced settings{' '}
              <span style={{ color: 'var(--fg-ghost)', marginLeft: 6, fontSize: 11 }}>
                bitrate, latency, chat, monetization · UI-only
              </span>
            </summary>
            {showAdv && (
              <div className="adv-grid">
                <div className="field">
                  <label>Latency</label>
                  <select className="select" defaultValue="low">
                    <option value="normal">Normal (15-20s)</option>
                    <option value="low">Low (3-5s)</option>
                    <option value="ultra">Ultra-low (1-2s)</option>
                  </select>
                </div>
                <div className="field">
                  <label>DVR</label>
                  <select className="select" defaultValue="on">
                    <option>Off</option>
                    <option>On (12h rewind)</option>
                    <option>On (4h rewind)</option>
                  </select>
                </div>
                <div className="field">
                  <label>Made for kids</label>
                  <select className="select" defaultValue="no">
                    <option>No, it's not made for kids</option>
                    <option>Yes, it's made for kids</option>
                  </select>
                </div>
                <div className="field">
                  <label>Auto-start recording</label>
                  <div className="row" style={{ height: 38 }}>
                    <div className="switch on" />
                    <span style={{ fontSize: 12, color: 'var(--fg-mute)' }}>
                      Mock — recording not yet implemented.
                    </span>
                  </div>
                </div>
                <div className="field">
                  <label>Enable chat</label>
                  <div className="row" style={{ height: 38 }}>
                    <div className="switch on" />
                  </div>
                </div>
                <div className="field">
                  <label>Subscriber-only chat</label>
                  <div className="row" style={{ height: 38 }}>
                    <div className="switch" />
                  </div>
                </div>
              </div>
            )}
          </details>
        </div>

        {/* RIGHT — preview + pre-flight + sticky Go Live */}
        <div className="side-panel">
          <div className="card pad fadein d2">
            <h3>
              YouTube Preview{' '}
              <span className="tag">{user.channel ? `· ${user.channel}` : ''}</span>
            </h3>
            <div
              className={'thumb-drop' + (thumbFilled ? ' filled' : '')}
              style={{
                aspectRatio: '16/9',
                cursor: 'default',
                ...(thumbFilled ? { padding: 0, overflow: 'hidden' } : {}),
              }}
            >
              {thumbFilled && previewUrl ? (
                <img
                  src={previewUrl}
                  alt=""
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
              ) : (
                <div className="ph-label mono dim">thumbnail goes here</div>
              )}
            </div>
            <div className="preview-stream" style={{ marginTop: 12 }}>
              <div className="title-line">{value.title || 'Untitled stream'}</div>
              <div className="meta-line">
                <span className="dot live"></span>
                <span style={{ color: 'oklch(0.86 0.14 22)' }}>LIVE</span>
                <span>·</span>
                <span>{user.channel || user.name}</span>
                <span>·</span>
                <span>{privacyDisplay(value.privacy)}</span>
              </div>
            </div>
          </div>

          <div className="card pad fadein d3">
            <h3>Pre-flight</h3>
            <div className="col" style={{ gap: 8 }}>
              <PreflightRowView
                tone="ok"
                label="YouTube channel verified"
                sub={user.channel ? `${user.channel} · ${user.email}` : user.email}
                showCheck
              />
              <PreflightRowView
                tone={preflightOBS.ok}
                label={preflightOBS.label}
                sub={preflightOBS.sub}
                showCheck={preflightOBS.showCheck}
              />
              <PreflightRowView
                tone={passwordSet ? 'ok' : 'warn'}
                label="OBS WebSocket password"
                sub={passwordSet ? 'configured' : 'not set — Settings → Connections'}
                showCheck={passwordSet}
              />
              {obsStatus.currentScene ? (
                <PreflightRowView
                  tone="ok"
                  label="Scene collection loaded"
                  sub={obsStatus.currentScene}
                  showCheck
                />
              ) : (
                <PreflightRowView
                  tone="placeholder"
                  label="Scene collection"
                  sub="detected on connect"
                  showCheck={false}
                />
              )}
              <PreflightRowView
                tone="placeholder"
                label="Upstream bandwidth"
                sub="not measured"
                showCheck={false}
              />
            </div>
          </div>

          <button
            type="button"
            className="btn primary lg"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            title={
              blockReason ??
              (probing
                ? 'Checking OBS…'
                : obsDialogOpen
                ? 'Finish the OBS launch dialog to continue.'
                : 'Create the broadcast and start streaming')
            }
            style={{ justifyContent: 'center', width: '100%' }}
          >
            <LiveIcon className="h-4 w-4" />{' '}
            {probing ? 'Checking OBS…' : 'Go Live'}
            <span style={{ marginLeft: 'auto', opacity: 0.7 }}>⌘↵</span>
          </button>

          {blockReason && (
            <div
              className="fineprint"
              style={{
                fontSize: 11,
                color: 'var(--fg-dim)',
                textAlign: 'center',
                marginTop: -8,
              }}
            >
              {blockReason}
            </div>
          )}
        </div>
      </div>

      {/*
        OBS pre-flight launch dialog. Mounted from this screen (not App.tsx)
        so its lifecycle is tied to CreateScreen — navigating away (e.g. user
        opens Settings during the prompt) cleanly unmounts it. The dialog
        owns its own 'prompt' / 'launching' / 'error' state machine; we only
        provide the open flag and the success/dismiss callbacks.
      */}
      <ObsLaunchDialog
        open={obsDialogOpen}
        onClose={handleObsDialogClose}
        onLaunched={handleObsLaunched}
      />
    </div>
  );
}

function PreflightRowView({
  tone,
  label,
  sub,
  showCheck,
}: {
  tone: 'ok' | 'warn' | 'err' | 'placeholder';
  label: string;
  sub: string;
  showCheck: boolean;
}) {
  const dotClass =
    tone === 'ok'
      ? 'dot ok'
      : tone === 'warn'
      ? 'dot warn'
      : tone === 'err'
      ? 'dot err'
      : 'dot';
  return (
    <div className="row" style={{ fontSize: 12.5 }}>
      <span className={dotClass} />
      <div className="flex1">
        <div style={{ color: 'var(--fg)' }}>{label}</div>
        <div
          style={{ color: 'var(--fg-ghost)', fontSize: 11, fontFamily: 'var(--font-mono)' }}
        >
          {sub}
        </div>
      </div>
      {showCheck ? (
        <span style={{ color: 'var(--ok)' }}>
          <CheckIcon className="h-3 w-3" />
        </span>
      ) : (
        <span style={{ width: 12 }} />
      )}
    </div>
  );
}
