import { useMemo, useState } from 'react';
import { BellIcon, ExpandIcon, PauseIcon } from '../components/Icons';
import { obsService } from '../services';
import type { OBSConnectionState, StreamHealth } from '../types';
import { formatDuration } from '../utils/format';
import { useBitrateHistory } from '../utils/useBitrateHistory';
import { useObsStatus } from '../utils/useObsStatus';
import { useStreamHealth } from '../utils/useStreamHealth';

interface MetricView {
  value: string;
  unit?: string;
  caption?: string;
  captionTone?: 'ok' | 'down' | 'neutral';
  accent?: boolean;
}

const IDLE_METRIC: MetricView = { value: '—', caption: 'idle', captionTone: 'neutral' };

function bitrateMetric(health: StreamHealth | null, state: OBSConnectionState): MetricView {
  if (state !== 'streaming') return IDLE_METRIC;
  if (!health || health.bitrateKbps === null) {
    return { value: '…', caption: 'measuring', captionTone: 'neutral' };
  }
  const mbps = health.bitrateKbps / 1000;
  return {
    value: mbps.toFixed(mbps >= 10 ? 1 : 2),
    unit: 'Mbps',
    caption: health.bitrateKbps < 1500 ? 'low' : 'stable',
    captionTone: health.bitrateKbps < 1500 ? 'down' : 'ok',
  };
}

function fpsMetric(health: StreamHealth | null, state: OBSConnectionState): MetricView {
  if (state !== 'streaming') return IDLE_METRIC;
  if (!health) return { value: '…', caption: 'measuring', captionTone: 'neutral' };
  const fps = Math.round(health.fps * 10) / 10;
  return {
    value: String(fps),
    unit: 'fps',
    caption: fps < 25 ? 'unstable' : fps < 50 ? 'mixed' : 'locked',
    captionTone: fps < 25 ? 'down' : fps < 50 ? 'neutral' : 'ok',
  };
}

function droppedMetric(health: StreamHealth | null, state: OBSConnectionState): MetricView {
  if (state !== 'streaming') return IDLE_METRIC;
  if (!health) return { value: '…', caption: 'measuring', captionTone: 'neutral' };
  const pct = health.droppedFramePercent;
  return {
    value: health.droppedFrames.toLocaleString(),
    caption:
      pct < 0.1
        ? 'within tolerance'
        : pct < 1
        ? `${pct.toFixed(2)}% dropped`
        : `${pct.toFixed(2)}% — review network`,
    captionTone: pct < 0.1 ? 'ok' : pct < 1 ? 'neutral' : 'down',
  };
}

function latencyMetric(health: StreamHealth | null, state: OBSConnectionState): MetricView {
  if (state !== 'streaming') return IDLE_METRIC;
  if (!health) return { value: '…', caption: 'measuring', captionTone: 'neutral' };
  const c = health.congestion;
  // OBS doesn't expose end-to-end latency; surface outputCongestion as a
  // qualitative label, matching what OBS Studio's own status bar does.
  if (c < 0.25)
    return { value: 'Low', accent: true, caption: 'congestion < 25%', captionTone: 'ok' };
  if (c < 0.5)
    return { value: 'Moderate', accent: true, caption: 'congestion ' + Math.round(c * 100) + '%', captionTone: 'neutral' };
  if (c < 0.75)
    return { value: 'High', accent: true, caption: 'congestion ' + Math.round(c * 100) + '%', captionTone: 'down' };
  return { value: 'Critical', accent: true, caption: 'congestion ' + Math.round(c * 100) + '%', captionTone: 'down' };
}

function obsConnectionRow(state: OBSConnectionState): { dot: string; sub: string; val: string } {
  switch (state) {
    case 'streaming':
      return { dot: 'ok', val: '127.0.0.1:4455', sub: 'streaming · WebSocket v5' };
    case 'connected':
      return { dot: 'ok', val: '127.0.0.1:4455', sub: 'connected · idle' };
    case 'connecting':
      return { dot: 'warn', val: '127.0.0.1:4455', sub: 'connecting…' };
    case 'error':
      return { dot: 'err', val: '127.0.0.1:4455', sub: 'error — see Settings' };
    default:
      return { dot: 'warn', val: '127.0.0.1:4455', sub: 'disconnected' };
  }
}

export default function DashScreen() {
  const obsStatus = useObsStatus();
  const health = useStreamHealth();
  const bitrateHistory = useBitrateHistory();
  const [endStreamBusy, setEndStreamBusy] = useState(false);
  const [endStreamError, setEndStreamError] = useState<string | null>(null);

  const isStreaming = obsStatus.state === 'streaming';
  const liveDuration = isStreaming && health?.outputDurationMs
    ? formatDuration(health.outputDurationMs)
    : '00:00:00';

  // Chart geometry: scale bars to the buffer's max so the chart auto-zooms.
  const { bars, avgKbps, maxKbps } = useMemo(() => {
    if (bitrateHistory.length === 0) {
      return { bars: [] as number[], avgKbps: 0, maxKbps: 0 };
    }
    const max = Math.max(...bitrateHistory, 1);
    const sum = bitrateHistory.reduce((a, b) => a + b, 0);
    return {
      bars: bitrateHistory.map((v) => Math.max(0.06, v / max)),
      avgKbps: Math.round(sum / bitrateHistory.length),
      maxKbps: max,
    };
  }, [bitrateHistory]);

  const handleEndStream = async () => {
    if (!isStreaming || endStreamBusy) return;
    setEndStreamBusy(true);
    setEndStreamError(null);
    try {
      await obsService.stopStreaming();
    } catch (err) {
      setEndStreamError(err instanceof Error ? err.message : 'Failed to stop OBS streaming.');
    } finally {
      setEndStreamBusy(false);
    }
  };

  const conn = obsConnectionRow(obsStatus.state);
  const bitrate = bitrateMetric(health, obsStatus.state);
  const fps = fpsMetric(health, obsStatus.state);
  const dropped = droppedMetric(health, obsStatus.state);
  const latency = latencyMetric(health, obsStatus.state);

  return (
    <div className="page fadein">
      <div className="page-head">
        <div>
          <div className="page-title row" style={{ gap: 12 }}>
            Stream Health
            {isStreaming && (
              <span className="chip live">
                <span className="dot live" /> LIVE · {liveDuration}
              </span>
            )}
          </div>
          <div className="page-sub">Real-time telemetry from OBS and YouTube ingestion.</div>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn ghost"
            disabled
            title="Pop-out window not yet implemented."
          >
            <ExpandIcon /> Pop-out
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled
            title="Alert routing not yet implemented."
          >
            <BellIcon /> Alerts
          </button>
          <button
            type="button"
            className="btn live-go"
            onClick={handleEndStream}
            disabled={!isStreaming || endStreamBusy}
            title={
              isStreaming
                ? 'Stop OBS streaming (the YouTube broadcast will end automatically after no incoming video).'
                : 'Not currently streaming.'
            }
          >
            <PauseIcon /> {endStreamBusy ? 'Stopping…' : 'End stream'}
          </button>
        </div>
      </div>

      <div className="dash">
        {/* LEFT — preview + chart */}
        <div className="col" style={{ gap: 18 }}>
          <div className="preview-large">
            <div className="grid-bg" />
            {isStreaming && (
              <>
                <div className="live-tag">
                  <span /> LIVE
                </div>
                <div className="duration">{liveDuration}</div>
              </>
            )}
            <div className="ph-label">
              {isStreaming
                ? `stream preview · ingest mirror${
                    obsStatus.currentScene ? ` · ${obsStatus.currentScene}` : ''
                  }`
                : 'not currently streaming — launch from new stream'}
            </div>
          </div>

          <div className="card padL">
            <div className="row" style={{ marginBottom: 6 }}>
              <h3 style={{ margin: 0, flex: 1 }}>
                Bitrate ·{' '}
                {bitrateHistory.length > 0
                  ? `last ${bitrateHistory.length} sample${bitrateHistory.length === 1 ? '' : 's'}`
                  : 'live history'}
              </h3>
            </div>
            <div className="bar-chart">
              {bars.length === 0 ? (
                <EmptyChart isStreaming={isStreaming} />
              ) : (
                bars.map((b, i) => (
                  <div
                    key={i}
                    className="bar"
                    style={{ height: `${Math.round(b * 100)}%` }}
                    title={`${bitrateHistory[i]?.toLocaleString()} kbps`}
                  />
                ))
              )}
            </div>
            <div
              className="row between"
              style={{
                marginTop: 10,
                fontSize: 11,
                color: 'var(--fg-dim)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              <span>oldest</span>
              <span>now</span>
            </div>
            <div className="legend" style={{ marginTop: 14 }}>
              <span className="l">
                <span
                  className="sw"
                  style={{ background: 'oklch(0.62 0.19 295)' }}
                />{' '}
                Bitrate
              </span>
              <span className="l" style={{ marginLeft: 'auto' }}>
                <span className="mono">
                  {avgKbps > 0
                    ? `avg ${avgKbps.toLocaleString()} kbps · peak ${maxKbps.toLocaleString()} kbps`
                    : 'no samples yet'}
                </span>
              </span>
            </div>
          </div>
        </div>

        {/* RIGHT — KPIs, connection, events */}
        <div className="col" style={{ gap: 18 }}>
          <div className="kpi-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <KpiCard label="Bitrate" view={bitrate} />
            <KpiCard label="FPS" view={fps} />
            <KpiCard label="Dropped frames" view={dropped} />
            <KpiCard label="Latency" view={latency} />
          </div>

          <div className="card padL">
            <h3>Connection</h3>
            {endStreamError && (
              <div
                role="alert"
                style={{
                  marginBottom: 10,
                  borderRadius: 8,
                  border: '1px solid oklch(0.66 0.22 22 / 0.4)',
                  background: 'oklch(0.66 0.22 22 / 0.08)',
                  padding: '8px 10px',
                  color: 'oklch(0.92 0.06 22)',
                  fontSize: 12,
                }}
              >
                {endStreamError}
              </div>
            )}
            <div className="col" style={{ gap: 10 }}>
              <ConnectionRow
                label="YouTube ingest"
                val={isStreaming ? 'rtmps · YouTube' : '—'}
                sub={isStreaming ? 'pushing video' : 'idle'}
                dot={isStreaming ? 'ok' : 'placeholder'}
              />
              <ConnectionRow
                label="OBS WebSocket"
                val={conn.val}
                sub={
                  conn.sub +
                  (obsStatus.version ? ` · v${obsStatus.version}` : '')
                }
                dot={conn.dot as 'ok' | 'warn' | 'err' | 'placeholder'}
              />
              {obsStatus.currentScene && (
                <ConnectionRow
                  label="Scene"
                  val={obsStatus.currentScene}
                  sub="from OBS"
                  dot="ok"
                />
              )}
              <ConnectionRow
                label="Upstream bandwidth"
                val="—"
                sub="not measured"
                dot="placeholder"
              />
              <ConnectionRow
                label="CPU · encode"
                val="—"
                sub="not measured"
                dot="placeholder"
              />
            </div>
          </div>

          <div className="card padL">
            <h3>
              Event feed <span className="tag">live</span>
            </h3>
            <div
              className="event-feed"
              style={{
                color: 'var(--fg-ghost)',
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              No events yet — runtime events from OBS and YouTube will appear here once the
              event-stream plumbing lands in a follow-up step.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function KpiCard({ label, view }: { label: string; view: MetricView }) {
  return (
    <div className={'kpi' + (view.accent ? ' acc' : '')}>
      <div className="label">{label}</div>
      <div className="val">
        {view.value}
        {view.unit && <span className="u">{view.unit}</span>}
      </div>
      {view.caption && (
        <div
          className={
            'delta' +
            (view.captionTone === 'ok'
              ? ' up'
              : view.captionTone === 'down'
              ? ' down'
              : '')
          }
        >
          {view.caption}
        </div>
      )}
    </div>
  );
}

function ConnectionRow({
  label,
  val,
  sub,
  dot,
}: {
  label: string;
  val: string;
  sub: string;
  dot: 'ok' | 'warn' | 'err' | 'placeholder';
}) {
  const dotClass = dot === 'placeholder' ? 'dot' : `dot ${dot}`;
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
      <span className="mono" style={{ color: 'var(--fg-mute)', fontSize: 11.5 }}>
        {val}
      </span>
    </div>
  );
}

function EmptyChart({ isStreaming }: { isStreaming: boolean }) {
  return (
    <div
      style={{
        flex: 1,
        display: 'grid',
        placeItems: 'center',
        color: 'var(--fg-ghost)',
        fontSize: 11.5,
        fontFamily: 'var(--font-mono)',
      }}
    >
      {isStreaming ? 'collecting first samples…' : 'no live stream — bars will fill once OBS is pushing'}
    </div>
  );
}
