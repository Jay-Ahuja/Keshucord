import OBSWebSocket from 'obs-websocket-js';
import type { OBSConnectionStatus, StreamHealth } from '../types';

const OBS_URL = 'ws://localhost:4455';
const HEALTH_POLL_MS = 1500;
const BITRATE_HISTORY_MAX = 64;
// After this many consecutive poll failures we give up on the connection and
// flip status to 'disconnected'. ConnectionClosed normally handles disconnects,
// but a wedged OBS process (TCP alive, app frozen) emits no close event.
const HEALTH_POLL_MAX_CONSECUTIVE_FAILURES = 4;
// Per-attempt timeout for obs.connect — prevents the launch from hanging
// indefinitely when OBS accepts the TCP connection but never completes the
// WebSocket upgrade / Identify handshake.
const CONNECT_ATTEMPT_TIMEOUT_MS = 8_000;

const obs = new OBSWebSocket();

let status: OBSConnectionStatus = { state: 'disconnected' };
const listeners = new Set<(s: OBSConnectionStatus) => void>();

// ---- Health polling state (module-scoped) ----
type HealthListener = (h: StreamHealth | null) => void;
type BitrateHistoryListener = (h: readonly number[]) => void;
const healthListeners = new Set<HealthListener>();
const bitrateHistoryListeners = new Set<BitrateHistoryListener>();
let healthPollTimer: ReturnType<typeof setTimeout> | null = null;
let healthPollInFlight = false;
let healthPollConsecutiveFailures = 0;
let lastHealth: StreamHealth | null = null;
let prevBytes: number | null = null;
let prevTimestampMs: number | null = null;
let bitrateHistory: number[] = [];

function log(...args: unknown[]) {
  console.info('[obs]', ...args);
}

function maskKey(key: string): string {
  return key ? `…${key.slice(-4)} (len=${key.length})` : '<empty>';
}

function statusEquals(a: OBSConnectionStatus, b: OBSConnectionStatus): boolean {
  return (
    a.state === b.state &&
    a.version === b.version &&
    a.currentScene === b.currentScene &&
    a.error === b.error
  );
}

function setStatus(next: OBSConnectionStatus) {
  // Skip the notification storm when nothing actually changed — saves React
  // re-renders and log noise on idle status events (e.g. scene changes that
  // resolve to the same name).
  if (statusEquals(status, next)) return;

  const wasStreaming = status.state === 'streaming';
  const willBeStreaming = next.state === 'streaming';

  status = next;
  // Per-listener try/catch: one buggy subscriber must not break the others
  // (parity with notifyHealth / notifyBitrateHistory).
  for (const l of listeners) {
    try {
      l(status);
    } catch (err) {
      console.error('[obs] status listener threw:', err);
    }
  }

  // Drive the health poller from the single source of truth — the connection
  // state. This guarantees we start exactly when we begin streaming and stop
  // on any departure from 'streaming' (including disconnects), so there's no
  // leaked interval after OBS goes away.
  if (willBeStreaming && !wasStreaming) startHealthPolling();
  else if (!willBeStreaming && wasStreaming) stopHealthPolling();
}

obs.on('ConnectionClosed', (err) => {
  if (status.state !== 'disconnected' && status.state !== 'error') {
    const code = (err as { code?: number } | undefined)?.code;
    const reason =
      (err as { message?: string } | undefined)?.message ??
      String((err as { reason?: string } | undefined)?.reason ?? '');
    log(`connection closed (code=${code ?? '?'}${reason ? `, reason="${reason}"` : ''})`);
    setStatus({ state: 'disconnected' });
  }
});

obs.on('StreamStateChanged', ({ outputActive }) => {
  log('StreamStateChanged outputActive=', outputActive, 'currentState=', status.state);
  if (outputActive) {
    // Only accept the flip into 'streaming' from a 'connected' baseline.
    // Receiving an outputActive=true while disconnected/connecting/error
    // would mean we've fallen out of sync with OBS — refusing to flip
    // prevents silently starting the health poller against a dead session.
    if (status.state === 'connected') {
      setStatus({ ...status, state: 'streaming' });
    } else if (status.state !== 'streaming') {
      log(
        `ignoring StreamStateChanged(true) — state is "${status.state}", not "connected". ` +
          'Will reconcile on the next user-initiated action.',
      );
    }
  } else {
    if (status.state === 'streaming') {
      setStatus({ ...status, state: 'connected' });
    }
  }
});

obs.on('CurrentProgramSceneChanged', ({ sceneName }) => {
  if (status.state === 'connected' || status.state === 'streaming') {
    setStatus({ ...status, currentScene: sceneName });
  }
});

export function getStatus(): OBSConnectionStatus {
  return status;
}

export function subscribe(listener: (s: OBSConnectionStatus) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---- Health metrics ----

export function getStreamHealth(): StreamHealth | null {
  return lastHealth;
}

/**
 * Subscribe to live health snapshots. Receives `null` when not streaming or
 * after a disconnect. Returns an unsubscribe function — callers MUST call it
 * to avoid leaking the listener.
 */
export function subscribeHealth(listener: HealthListener): () => void {
  healthListeners.add(listener);
  // Push the current snapshot immediately so new subscribers don't render an
  // empty card while waiting for the next poll tick.
  try {
    listener(lastHealth);
  } catch (err) {
    console.error('[obs] health listener threw on initial emit:', err);
  }
  return () => {
    healthListeners.delete(listener);
  };
}

function notifyHealth(h: StreamHealth | null): void {
  for (const l of healthListeners) {
    try {
      l(h);
    } catch (err) {
      console.error('[obs] health listener threw:', err);
    }
  }
}

/**
 * Snapshot of the most recent bitrate samples (kbps). Newest values are at
 * the END of the array. Empty when not streaming or before the first delta
 * can be computed. Capped at `BITRATE_HISTORY_MAX` samples (~96 s at the
 * current 1.5 s poll cadence).
 */
export function getBitrateHistory(): readonly number[] {
  return bitrateHistory.slice();
}

export function subscribeBitrateHistory(listener: BitrateHistoryListener): () => void {
  bitrateHistoryListeners.add(listener);
  try {
    listener(bitrateHistory.slice());
  } catch (err) {
    console.error('[obs] bitrate-history listener threw on initial emit:', err);
  }
  return () => {
    bitrateHistoryListeners.delete(listener);
  };
}

function notifyBitrateHistory(): void {
  // Pass a fresh shallow copy so React subscribers see a new identity and
  // re-render. Listeners receive a readonly view.
  const snapshot = bitrateHistory.slice();
  for (const l of bitrateHistoryListeners) {
    try {
      l(snapshot);
    } catch (err) {
      console.error('[obs] bitrate-history listener threw:', err);
    }
  }
}

function startHealthPolling(): void {
  if (healthPollTimer) return;
  log('starting stream health polling');
  prevBytes = null;
  prevTimestampMs = null;
  lastHealth = null;
  bitrateHistory = [];
  healthPollInFlight = false;
  healthPollConsecutiveFailures = 0;
  // Self-scheduling tick: each completed poll arms the next setTimeout. This
  // is naturally non-reentrant (a slow OBS can never produce overlapping
  // ticks) and drifts a little instead of queuing — both better than
  // setInterval for this workload.
  void runHealthTick();
}

function stopHealthPolling(): void {
  if (!healthPollTimer && !healthPollInFlight) {
    // Already stopped; nothing to clean up.
    if (lastHealth !== null || bitrateHistory.length > 0) {
      // Idempotent reset path — keep state consistent even on duplicate stop.
      lastHealth = null;
      bitrateHistory = [];
      notifyHealth(null);
      notifyBitrateHistory();
    }
    return;
  }
  log('stopping stream health polling');
  if (healthPollTimer) {
    clearTimeout(healthPollTimer);
    healthPollTimer = null;
  }
  // We can't cancel an in-flight obs.call, but runHealthTick checks
  // healthPollTimer before notifying or re-scheduling, so a late-arriving
  // result is dropped cleanly.
  prevBytes = null;
  prevTimestampMs = null;
  lastHealth = null;
  bitrateHistory = [];
  healthPollInFlight = false;
  healthPollConsecutiveFailures = 0;
  // Emit empty/null to subscribers so their UI switches to the idle state.
  notifyHealth(null);
  notifyBitrateHistory();
}

async function runHealthTick(): Promise<void> {
  if (healthPollInFlight) return;
  healthPollInFlight = true;
  // Snapshot the streaming state at tick start. If we leave 'streaming' while
  // an obs.call is in flight, we drop the result rather than write into reset
  // module state.
  const wasStreaming = status.state === 'streaming';
  let success = false;

  try {
    const [streamStatus, stats] = await Promise.all([
      obs.call('GetStreamStatus'),
      obs.call('GetStats'),
    ]);

    // If we stopped streaming mid-call, discard the result. stopHealthPolling
    // already reset module state; we must not stomp on it.
    if (!wasStreaming || status.state !== 'streaming') return;

    const now = Date.now();
    const bytes = streamStatus.outputBytes ?? 0;

    // Compute bitrate from the delta between samples. The very first poll has
    // no prior reading — emit `null` so the UI can show "Measuring…" rather
    // than a misleading 0.
    let bitrateKbps: number | null = null;
    if (prevBytes !== null && prevTimestampMs !== null) {
      const dtSec = (now - prevTimestampMs) / 1000;
      if (dtSec > 0) {
        const dBytes = Math.max(0, bytes - prevBytes);
        bitrateKbps = Math.round((dBytes * 8) / 1000 / dtSec);
      }
    }
    prevBytes = bytes;
    prevTimestampMs = now;

    const droppedFrames = streamStatus.outputSkippedFrames ?? 0;
    const totalFrames = streamStatus.outputTotalFrames ?? 0;
    const droppedFramePercent = totalFrames > 0 ? (droppedFrames / totalFrames) * 100 : 0;

    const health: StreamHealth = {
      bitrateKbps,
      fps: typeof stats.activeFps === 'number' ? stats.activeFps : 0,
      droppedFrames,
      droppedFramePercent,
      congestion: typeof streamStatus.outputCongestion === 'number' ? streamStatus.outputCongestion : 0,
      renderTimeMs:
        typeof stats.averageFrameRenderTime === 'number' ? stats.averageFrameRenderTime : 0,
      outputDurationMs: streamStatus.outputDuration ?? 0,
      totalFrames,
      timestamp: now,
    };

    lastHealth = health;
    notifyHealth(health);

    if (bitrateKbps !== null) {
      bitrateHistory = [...bitrateHistory, bitrateKbps].slice(-BITRATE_HISTORY_MAX);
      notifyBitrateHistory();
    }

    success = true;
  } catch (err) {
    if (status.state !== 'streaming') return; // already torn down; ignore
    healthPollConsecutiveFailures += 1;
    log(
      `health poll failed (${healthPollConsecutiveFailures}/${HEALTH_POLL_MAX_CONSECUTIVE_FAILURES}):`,
      err instanceof Error ? err.message : err,
    );
    if (healthPollConsecutiveFailures >= HEALTH_POLL_MAX_CONSECUTIVE_FAILURES) {
      // OBS hasn't emitted ConnectionClosed but isn't responding either —
      // wedged process, dead socket, or similar. Flip to 'disconnected' via
      // the canonical funnel, which will tear down the poller cleanly.
      log(
        'health poll: exceeded consecutive-failure threshold — treating OBS as disconnected. ' +
          'No ConnectionClosed event was received; the socket may be wedged.',
      );
      setStatus({
        state: 'disconnected',
        error: 'OBS stopped responding to status requests.',
      });
      return;
    }
  } finally {
    healthPollInFlight = false;
    if (success) healthPollConsecutiveFailures = 0;
    // Only re-schedule if we're still streaming. If setStatus flipped us
    // out of 'streaming' (either via consecutive-failure threshold above or
    // via ConnectionClosed handler), stopHealthPolling will have already
    // nulled healthPollTimer; we must not re-arm it.
    if (status.state === 'streaming') {
      healthPollTimer = setTimeout(() => void runHealthTick(), HEALTH_POLL_MS);
    }
  }
}

// ---- Connect ----

export interface ConnectOptions {
  /** Total attempts including the first try. Defaults to 1 (no retry). */
  attempts?: number;
  /** Backoff between attempts in ms. Defaults to 1500. */
  retryDelayMs?: number;
}

export async function connect(
  password: string,
  options: ConnectOptions = {},
): Promise<OBSConnectionStatus> {
  if (status.state === 'connecting') {
    throw new Error('Already trying to connect to OBS.');
  }
  if (status.state === 'streaming') {
    throw new Error('Stop the stream before reconnecting to OBS.');
  }
  if (status.state === 'connected') {
    log('reconnecting — closing existing session first');
    await disconnect();
  }

  const attempts = Math.max(1, options.attempts ?? 1);
  const retryDelay = options.retryDelayMs ?? 1500;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    setStatus({ state: 'connecting' });
    log(`connect attempt ${attempt}/${attempts} → ${OBS_URL} (timeout ${CONNECT_ATTEMPT_TIMEOUT_MS}ms)`);

    try {
      // obs.connect itself has no per-call timeout — wrap it. A hung TCP
      // handshake or stalled Identify exchange would otherwise block the
      // entire launch (and any user-facing abort doesn't cancel the WS).
      const { obsWebSocketVersion } = await withTimeout(
        obs.connect(OBS_URL, password || undefined),
        CONNECT_ATTEMPT_TIMEOUT_MS,
        'OBS WebSocket handshake timed out.',
      );
      const sceneInfo = await obs.call('GetCurrentProgramScene');
      const streamStatus = await obs.call('GetStreamStatus');

      const next: OBSConnectionStatus = {
        state: streamStatus.outputActive ? 'streaming' : 'connected',
        version: obsWebSocketVersion,
        currentScene: sceneInfo.currentProgramSceneName,
      };
      setStatus(next);
      log(
        `connected (OBS WebSocket v${obsWebSocketVersion}, scene "${next.currentScene}", ` +
          `outputActive=${!!streamStatus.outputActive})`,
      );
      return next;
    } catch (err) {
      lastError = err;
      log(`connect attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
      // Defensively close any half-open socket from the failed attempt so the
      // next retry (or the surfaced error) starts from a known state.
      try {
        await obs.disconnect();
      } catch {
        // best-effort
      }
      if (attempt < attempts) {
        await sleep(retryDelay);
      }
    }
  }

  const message = explainObsError(lastError);
  setStatus({ state: 'error', error: message });
  throw new Error(message);
}

function withTimeout<T>(p: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

export async function disconnect(): Promise<void> {
  try {
    await obs.disconnect();
  } catch {
    // best-effort
  }
  setStatus({ state: 'disconnected' });
}

// ---- Configure stream service ----

export interface StreamServiceConfig {
  rtmpUrl: string;
  streamKey: string;
}

interface RawStreamServiceSettings {
  streamServiceType?: string;
  streamServiceSettings?: {
    server?: unknown;
    key?: unknown;
    service?: unknown;
  };
}

export async function configureStreamService(config: StreamServiceConfig): Promise<void> {
  log(
    `configureStreamService start: server="${config.rtmpUrl}", key=${maskKey(config.streamKey)}, ` +
      `current state="${status.state}"`,
  );
  if (status.state === 'streaming') {
    throw new Error('OBS is already streaming. Stop the stream before changing service settings.');
  }
  if (status.state !== 'connected') {
    throw new Error('Connect to OBS before configuring stream settings.');
  }
  if (!config.rtmpUrl || !config.streamKey) {
    throw new Error('Missing RTMP URL or stream key — cannot configure OBS.');
  }

  // Read current settings first so we can detect the YouTube account-linked state
  // and produce a precise error if our write later fails to take effect.
  let before: RawStreamServiceSettings = {};
  try {
    before = (await obs.call('GetStreamServiceSettings')) as RawStreamServiceSettings;
    log('current stream service before change:', JSON.stringify(before));
  } catch (err) {
    log('could not read current stream service:', err);
  }

  const wasYouTubeManaged = isYouTubeManagedConfig(before);
  if (wasYouTubeManaged) {
    log(
      'WARNING: OBS is currently using the managed YouTube service. Switching to rtmp_custom; ' +
        'if OBS has "Connect Account" linked to YouTube, this will silently revert at StartStream time.',
    );
  }

  // Apply the new settings.
  log(`setting service to rtmp_custom (server="${config.rtmpUrl}", key=${maskKey(config.streamKey)})`);
  try {
    await obs.call('SetStreamServiceSettings', {
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: {
        server: config.rtmpUrl,
        key: config.streamKey,
        use_auth: false,
      },
    });
  } catch (err) {
    throw new Error(
      `OBS rejected the stream service settings: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }

  // Poll-verify for up to 3s — OBS's GetStreamServiceSettings can briefly lag
  // behind a write while the frontend persists to disk.
  const verifyDeadline = Date.now() + 3000;
  let lastApplied: RawStreamServiceSettings = {};

  while (Date.now() < verifyDeadline) {
    try {
      lastApplied = (await obs.call('GetStreamServiceSettings')) as RawStreamServiceSettings;
    } catch (err) {
      throw new Error(
        `Could not verify OBS stream service settings: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }

    if (matchesConfig(lastApplied, config)) {
      log('stream service settings verified');
      return;
    }
    await sleep(200);
  }

  // Verification failed — explain precisely what happened.
  const appliedType = lastApplied.streamServiceType ?? '<unknown>';
  const appliedServer =
    typeof lastApplied.streamServiceSettings?.server === 'string'
      ? lastApplied.streamServiceSettings.server
      : '<none>';

  log('stream service verification FAILED', { expected: config, applied: lastApplied });

  if (isYouTubeManagedConfig(lastApplied) || wasYouTubeManaged) {
    throw new Error(
      'OBS would not switch to a custom RTMP service — it is locked to a managed YouTube ' +
        'broadcast workflow. When you click Start Streaming with this configuration, OBS shows ' +
        'the popup "You must select a broadcast first.", which we cannot dismiss programmatically.' +
        '\n\nFix (one-time): open OBS → Settings → Stream. Under your YouTube account, click ' +
        '"Disconnect", then click OK. Keshucord provisions the broadcast and stream key ' +
        "itself, so OBS doesn't need the account link. Retry the launch after disconnecting.",
    );
  }

  throw new Error(
    `OBS did not apply the new stream settings — service is "${appliedType}" with server ` +
      `"${appliedServer}". Open OBS → Settings → Stream, change Service to "Custom..." (and ` +
      'disconnect any linked YouTube account), click OK, then retry the launch.',
  );
}

function matchesConfig(applied: RawStreamServiceSettings, config: StreamServiceConfig): boolean {
  if (applied.streamServiceType !== 'rtmp_custom') return false;
  const server = applied.streamServiceSettings?.server;
  const key = applied.streamServiceSettings?.key;
  return server === config.rtmpUrl && key === config.streamKey;
}

function isYouTubeManagedConfig(s: RawStreamServiceSettings): boolean {
  if (s.streamServiceType !== 'rtmp_common') return false;
  const service = s.streamServiceSettings?.service;
  return typeof service === 'string' && service.toLowerCase().includes('youtube');
}

/**
 * Reads OBS's current stream service settings and throws if any of
 * `streamServiceType`, `server`, or `key` doesn't exactly match `expected`.
 *
 * The launch flow calls this immediately before `StartStream` as the final
 * defense-in-depth check: even though `configureStreamService` already
 * poll-verified the write, OBS Studio's "Connect Account" YouTube
 * integration can re-mutate the active service asynchronously, and we want
 * to refuse to start streaming if anything has drifted since.
 */
export async function assertActiveStreamServiceSettings(
  expected: StreamServiceConfig,
): Promise<void> {
  log(`asserting OBS stream service matches expected ingestion (key=${maskKey(expected.streamKey)})`);
  // Single retry on transient read failure. We deliberately do NOT retry on
  // value mismatch — a mismatch is exactly the case this assertion exists to
  // catch, so retrying would mask the bug it's designed to surface. A retry
  // only helps when the read itself fails (busy OBS, transient WS hiccup).
  let applied: RawStreamServiceSettings | undefined;
  let readError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      applied = (await obs.call('GetStreamServiceSettings')) as RawStreamServiceSettings;
      readError = undefined;
      break;
    } catch (err) {
      readError = err;
      log(
        `pre-StartStream GetStreamServiceSettings read failed (attempt ${attempt}/2): ` +
          (err instanceof Error ? err.message : String(err)),
      );
      if (attempt < 2) await sleep(500);
    }
  }
  if (!applied) {
    throw new Error(
      `Could not read OBS stream service settings before StartStream: ${
        readError instanceof Error ? readError.message : 'unknown error'
      }`,
    );
  }

  const appliedType = applied.streamServiceType ?? '';
  const appliedServer =
    typeof applied.streamServiceSettings?.server === 'string'
      ? applied.streamServiceSettings.server
      : '';
  const appliedKey =
    typeof applied.streamServiceSettings?.key === 'string'
      ? applied.streamServiceSettings.key
      : '';

  log('pre-StartStream OBS state:', {
    type: appliedType,
    server: appliedServer,
    keyTail: appliedKey ? `…${appliedKey.slice(-4)}` : '<empty>',
    keyLen: appliedKey.length,
    expectedServer: expected.rtmpUrl,
    expectedKeyTail: `…${expected.streamKey.slice(-4)}`,
    expectedKeyLen: expected.streamKey.length,
  });

  if (appliedType !== 'rtmp_custom') {
    throw new Error(
      `Pre-StartStream check failed: OBS stream service is "${appliedType}" (expected "rtmp_custom"). ` +
        `Something — most likely OBS Studio's "Connect Account" YouTube link — reverted the custom service we configured. ` +
        `Open OBS → Settings → Stream → Disconnect, then retry.`,
    );
  }
  if (appliedServer !== expected.rtmpUrl) {
    throw new Error(
      `Pre-StartStream check failed: OBS RTMP server is "${appliedServer}" but the broadcast we just provisioned expects "${expected.rtmpUrl}". Refusing to start streaming to the wrong destination.`,
    );
  }
  if (appliedKey !== expected.streamKey) {
    throw new Error(
      `Pre-StartStream check failed: OBS stream key does not match the key YouTube returned for our new broadcast. ` +
        `Starting now would push your video to a different destination. ` +
        `This usually means OBS has "Connect Account" linked to YouTube — disconnect it in Settings → Stream and retry.`,
    );
  }
  log('pre-StartStream check passed — OBS is configured for our broadcast');
}

// ---- Start / Stop streaming ----

const START_STREAM_VERIFY_WINDOW_MS = 5_000;
const START_STREAM_POLL_MS = 250;

export async function startStreaming(): Promise<OBSConnectionStatus> {
  if (status.state === 'streaming') return status;
  if (status.state !== 'connected') {
    throw new Error('Connect to OBS before starting the stream.');
  }

  log('calling StartStream');
  try {
    await obs.call('StartStream');
  } catch (err) {
    throw new Error(
      `OBS refused to start streaming: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }

  // StartStream returns immediately, but OBS may show a blocking modal (most
  // commonly "You must select a broadcast first." when a YouTube account is
  // connected) that prevents streaming from actually beginning. Poll
  // GetStreamStatus for a short window — if outputActive doesn't flip true,
  // something is blocking on the OBS side and we should fail loudly.
  const deadline = Date.now() + START_STREAM_VERIFY_WINDOW_MS;
  while (Date.now() < deadline) {
    let streamStatus: { outputActive?: boolean };
    try {
      streamStatus = (await obs.call('GetStreamStatus')) as { outputActive?: boolean };
    } catch (err) {
      throw new Error(
        `Could not verify OBS streaming state: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
    if (streamStatus.outputActive) {
      const next: OBSConnectionStatus = { ...status, state: 'streaming' };
      setStatus(next);
      log('stream is active');
      return next;
    }
    await sleep(START_STREAM_POLL_MS);
  }

  log('StartStream accepted but outputActive never became true within window');
  throw new Error(
    'OBS accepted the StartStream command but is not actually streaming. The most common ' +
      'cause is a blocking modal in OBS — specifically "You must select a broadcast first.", ' +
      'which appears when OBS Settings → Stream has a YouTube account connected via "Connect ' +
      'Account".' +
      '\n\nFix (one-time): bring OBS to the foreground, dismiss the popup, then open ' +
      'Settings → Stream and click "Disconnect" under your YouTube account. Retry the launch.',
  );
}

export async function stopStreaming(): Promise<OBSConnectionStatus> {
  if (status.state !== 'streaming') return status;
  log('calling StopStream');
  try {
    await obs.call('StopStream');
    const next: OBSConnectionStatus = { ...status, state: 'connected' };
    setStatus(next);
    return next;
  } catch (err) {
    throw new Error(
      `OBS refused to stop streaming: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
}

// ---- Test (used by the setup-screen button) ----

export interface TestResult {
  ok: boolean;
  message: string;
  status: OBSConnectionStatus;
}

export async function testConnection(password: string): Promise<TestResult> {
  try {
    const next = await connect(password);
    return {
      ok: true,
      message: `Connected to OBS WebSocket v${next.version ?? '?'} · Scene: ${
        next.currentScene ?? '—'
      }`,
      status: next,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Connection failed.',
      status: getStatus(),
    };
  }
}

// Launching OBS as a process needs the Electron main process (shell exec).
// Stubbed for now — the launch flow assumes OBS is already running and reuses
// whatever instance owns ws://localhost:4455.
export async function launchObs(): Promise<void> {
  await sleep(200);
}

// ---- internals ----

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function explainObsError(err: unknown): string {
  const code = (err as { code?: number })?.code;
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const lowered = raw.toLowerCase();

  if (code === 4009) {
    return 'OBS rejected the password. Open OBS → Tools → WebSocket Server Settings → Show Connect Info to copy the correct password.';
  }
  if (code === 4008) {
    return 'OBS requires a password but none was provided. Enter the password from OBS → Tools → WebSocket Server Settings.';
  }
  if (code === 4006) {
    return 'OBS closed the connection unexpectedly. Make sure OBS is still running.';
  }

  if (
    !raw ||
    lowered.includes('econnrefused') ||
    lowered.includes('connection refused') ||
    lowered.includes('failed to construct') ||
    lowered.includes('failed to connect') ||
    lowered.includes('connection failed') ||
    lowered.includes('network error')
  ) {
    return 'Could not reach OBS at ws://localhost:4455. Make sure OBS Studio is open and that Tools → WebSocket Server Settings has the server enabled on port 4455.';
  }
  if (lowered.includes('timeout') || lowered.includes('timed out')) {
    return (
      'Connection to OBS timed out — OBS accepted the WebSocket but never completed the ' +
      'handshake. Try closing and reopening OBS, or check Tools → WebSocket Server Settings.'
    );
  }
  if (lowered.includes('authentication') || lowered.includes('unauthorized')) {
    return 'OBS rejected the password. Check Tools → WebSocket Server Settings → Show Connect Info.';
  }

  return `OBS connection error: ${raw}`;
}
