import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRightIcon,
  BoltIcon,
  CheckIcon,
  DashIcon,
} from '../components/Icons';
import { IngestionInfoCard } from '../components/IngestionInfoCard';
import { LAUNCH_STEPS, runLaunchSequence } from '../services';
import type {
  LaunchStep,
  LaunchStepId,
  LaunchStepStatus,
  StreamIngestionInfo,
  StreamSettings,
  YouTubeBroadcast,
  YouTubeUser,
} from '../types';
import { capitalize, formatDuration } from '../utils/format';
import { useObsStatus } from '../utils/useObsStatus';
import { useStreamHealth } from '../utils/useStreamHealth';

interface Props {
  settings: StreamSettings;
  user: YouTubeUser;
  onBack: () => void;
  onOpenDashboard: () => void;
}

type StatusMap = Record<LaunchStepId, LaunchStepStatus>;

function initialStatuses(): StatusMap {
  return Object.fromEntries(LAUNCH_STEPS.map((s) => [s.id, 'pending'])) as StatusMap;
}

type RowState = 'done' | 'active' | 'wait' | 'err';

function rowStateFor(status: LaunchStepStatus): RowState {
  switch (status) {
    case 'done':
      return 'done';
    case 'active':
      return 'active';
    case 'error':
      return 'err';
    default:
      return 'wait';
  }
}

const RING_RADIUS = 88;
const RING_CIRC = 2 * Math.PI * RING_RADIUS;

export default function LaunchStatusScreen({ settings, user, onBack, onOpenDashboard }: Props) {
  const [statuses, setStatuses] = useState<StatusMap>(initialStatuses);
  const [details, setDetails] = useState<Partial<Record<LaunchStepId, string>>>({});
  const [broadcast, setBroadcast] = useState<YouTubeBroadcast | null>(null);
  const [ingestion, setIngestion] = useState<StreamIngestionInfo | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [cleanedUp, setCleanedUp] = useState<string[]>([]);
  const obsStatus = useObsStatus();
  const health = useStreamHealth();

  useEffect(() => {
    const controller = new AbortController();
    runLaunchSequence({
      settings,
      signal: controller.signal,
      onEvent: (event) => {
        if (controller.signal.aborted) return;
        switch (event.type) {
          case 'step:start':
            setStatuses((prev) => ({ ...prev, [event.stepId]: 'active' }));
            break;
          case 'step:done':
            setStatuses((prev) => ({ ...prev, [event.stepId]: 'done' }));
            break;
          case 'step:error':
            setStatuses((prev) => ({ ...prev, [event.stepId]: 'error' }));
            setFatalError(event.error.message);
            break;
          case 'step:detail':
            setDetails((prev) => ({ ...prev, [event.stepId]: event.detail }));
            break;
          case 'broadcast-created':
            setBroadcast(event.broadcast);
            break;
          case 'ingestion-ready':
            setIngestion(event.ingestion);
            break;
          case 'cleanup':
            setCleanedUp(event.deleted);
            break;
          case 'complete':
            setBroadcast(event.broadcast);
            break;
        }
      },
    }).catch(() => {
      // step:error already surfaces failures via state
    });
    return () => controller.abort();
  }, [settings]);

  const done = broadcast?.status === 'live';
  const totalSteps = LAUNCH_STEPS.length;

  // Derive ring progress + the index of the row that should render "active" /
  // "err" highlighting from the real per-step status map.
  const {
    doneCount,
    activeStepIdx,
    pct,
    progressDescription,
  }: {
    doneCount: number;
    activeStepIdx: number;
    pct: number;
    progressDescription: string;
  } = useMemo(() => {
    const dones = LAUNCH_STEPS.filter((s) => statuses[s.id] === 'done').length;
    const activeIdx = LAUNCH_STEPS.findIndex((s) => statuses[s.id] === 'active');
    const errorIdx = LAUNCH_STEPS.findIndex((s) => statuses[s.id] === 'error');
    const focusIdx = errorIdx !== -1 ? errorIdx : activeIdx !== -1 ? activeIdx : dones;
    const percent = Math.round((dones / totalSteps) * 100);
    const focusStep: LaunchStep | undefined = LAUNCH_STEPS[focusIdx];
    const desc = focusStep
      ? `Step ${focusIdx + 1} of ${totalSteps} · ${details[focusStep.id] ?? focusStep.detail}`
      : 'Initializing…';
    return {
      doneCount: dones,
      activeStepIdx: focusIdx,
      pct: percent,
      progressDescription: desc,
    };
  }, [statuses, details, totalSteps]);

  const ringDashOffset = RING_CIRC - (RING_CIRC * pct) / 100;
  const focusStep = LAUNCH_STEPS[activeStepIdx];
  const inProgress = !done && !fatalError;

  const liveDuration =
    obsStatus.state === 'streaming' && health?.outputDurationMs
      ? formatDuration(health.outputDurationMs)
      : '00:00:00';

  const ringStatusText = fatalError
    ? 'Launch failed'
    : done
    ? 'You are live on YouTube.'
    : focusStep?.label ?? 'Initializing…';

  const ringSubText = fatalError
    ? 'See the error below.'
    : done
    ? `${user.channel || user.name} · ${capitalize(settings.privacy)}${settings.category ? ` · ${settings.category}` : ''}`
    : progressDescription;

  const ringLabel = fatalError ? 'Failed' : done ? 'Live' : 'Preparing';

  const copyShareLink = async () => {
    if (!broadcast?.watchUrl) return;
    try {
      await navigator.clipboard.writeText(broadcast.watchUrl);
    } catch {
      // ignore — UI feedback would be nice but matches existing copy patterns
    }
  };

  const openInYouTube = () => {
    if (broadcast?.watchUrl) {
      window.open(broadcast.watchUrl, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div className="page fadein">
      <div className="page-head">
        <div>
          <div className="page-title row" style={{ gap: 12 }}>
            Going live
            <span className="chip acc">
              <BoltIcon className="h-3 w-3" /> Auto-pilot
            </span>
            {done && (
              <span className="chip live">
                <span className="dot live" /> LIVE · {liveDuration}
              </span>
            )}
          </div>
          <div className="page-sub">
            {totalSteps} checks, one outcome. Stay here or step away — we'll handle it.
          </div>
        </div>
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onBack}>
            {fatalError ? 'Back to setup' : inProgress ? 'Cancel' : 'Back to setup'}
          </button>
          {done && (
            <button type="button" className="btn primary" onClick={onOpenDashboard}>
              Open dashboard <ArrowRightIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="launch">
        {/* LEFT — stage with progress ring */}
        <div className="launch-stage aurora">
          <div className="grid-bg" />
          <div className="center">
            <div className="ring-wrap">
              <svg viewBox="0 0 200 200">
                <defs>
                  <linearGradient id="ringgrad" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="oklch(0.78 0.20 295)" />
                    <stop offset="100%" stopColor="oklch(0.50 0.18 290)" />
                  </linearGradient>
                </defs>
                <circle className="ring-bg" cx="100" cy="100" r={RING_RADIUS} />
                <circle
                  className="ring-fg"
                  cx="100"
                  cy="100"
                  r={RING_RADIUS}
                  strokeDasharray={RING_CIRC}
                  strokeDashoffset={ringDashOffset}
                />
              </svg>
              <div className="ring-pct">
                <b>
                  {pct}
                  <span style={{ fontSize: 22, color: 'var(--fg-dim)' }}>%</span>
                </b>
                <span>{ringLabel}</span>
              </div>
            </div>
            <div>
              <div className="launch-status-text">{ringStatusText}</div>
              <div className="sub" style={{ textAlign: 'center' }}>
                {ringSubText}
              </div>
            </div>

            {done && (
              <div className="row gap-sm">
                <span className="chip live">
                  <span className="dot live" /> LIVE {liveDuration}
                </span>
                <span className="chip ok">Healthy</span>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT — checklist + (when available) ingestion + (error) banner */}
        <div className="col" style={{ gap: 18 }}>
          <div className="card padL">
            <h3>
              Launch sequence
              <span className="tag mono">
                {doneCount}/{totalSteps}
              </span>
            </h3>
            <div className="checklist">
              {LAUNCH_STEPS.map((step, i) => {
                const state = rowStateFor(statuses[step.id]);
                const cls =
                  'check-item' +
                  (state === 'done' ? ' done' : '') +
                  (state === 'active' ? ' active' : '') +
                  (state === 'err' ? ' err' : '');
                const detailText =
                  state === 'active' ? details[step.id] ?? step.detail : step.detail;
                const metaText =
                  state === 'done'
                    ? 'ok'
                    : state === 'active'
                    ? 'running'
                    : state === 'err'
                    ? 'failed'
                    : '—';
                return (
                  <div key={step.id} className={cls}>
                    <div className="check-ind">
                      {state === 'done' ? (
                        <CheckIcon className="h-2.5 w-2.5" />
                      ) : state === 'err' ? (
                        <span style={{ fontSize: 11, fontWeight: 600 }}>!</span>
                      ) : state === 'wait' ? (
                        <span style={{ fontSize: 10.5 }}>{i + 1}</span>
                      ) : null}
                    </div>
                    <div className="check-text">
                      <b>{step.label}</b>
                      <span>{detailText}</span>
                    </div>
                    <span className="check-meta">{metaText}</span>
                  </div>
                );
              })}
            </div>

            {fatalError && (
              <div
                role="alert"
                style={{
                  marginTop: 16,
                  borderRadius: 10,
                  border: '1px solid oklch(0.66 0.22 22 / 0.4)',
                  background: 'oklch(0.66 0.22 22 / 0.08)',
                  padding: '12px 14px',
                  color: 'oklch(0.92 0.06 22)',
                  fontSize: 12.5,
                  lineHeight: 1.55,
                }}
              >
                <div>{fatalError}</div>
                {cleanedUp.length > 0 && (
                  <div style={{ marginTop: 8, opacity: 0.75 }}>
                    Cleaned up orphan {cleanedUp.join(', ')}.
                  </div>
                )}
              </div>
            )}

            {done && broadcast && (
              <div className="row gap-sm" style={{ marginTop: 16 }}>
                <button type="button" className="btn" onClick={copyShareLink}>
                  Copy share link
                </button>
                <button type="button" className="btn" onClick={openInYouTube}>
                  Open in YouTube
                </button>
                <button
                  type="button"
                  className="btn primary"
                  style={{ marginLeft: 'auto' }}
                  onClick={onOpenDashboard}
                >
                  <DashIcon className="h-3 w-3" /> Stream Health
                </button>
              </div>
            )}
          </div>

          <IngestionInfoCard broadcast={broadcast} ingestion={ingestion} />
        </div>
      </div>
    </div>
  );
}

