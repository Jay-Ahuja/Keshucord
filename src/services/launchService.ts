import type {
  LaunchStep,
  LaunchStepId,
  StreamIngestionInfo,
  StreamSettings,
  YouTubeBroadcast,
  YouTubeLiveStream,
} from '../types';
import * as obs from './obsService';
import * as youtube from './youtubeService';

export const LAUNCH_STEPS: readonly LaunchStep[] = [
  { id: 'validate', label: 'Validating form fields', detail: 'Checking required values…' },
  { id: 'auth', label: 'Confirming YouTube sign-in', detail: 'Verifying stored credentials…' },
  { id: 'broadcast', label: 'Creating YouTube broadcast', detail: 'Reserving the live event…' },
  { id: 'stream', label: 'Creating YouTube live stream', detail: 'Provisioning ingestion endpoint…' },
  { id: 'bind', label: 'Binding broadcast to stream', detail: 'Linking broadcast and ingest…' },
  { id: 'ingestion', label: 'Getting stream key', detail: 'Fetching RTMP credentials…' },
  { id: 'connect-obs', label: 'Connecting to OBS', detail: 'Authenticating WebSocket…' },
  { id: 'configure-obs', label: 'Configuring OBS stream settings', detail: 'Setting RTMP server + key…' },
  { id: 'start-stream', label: 'Starting OBS streaming', detail: 'Pushing video to YouTube…' },
  { id: 'go-live', label: 'Going live on YouTube', detail: 'Waiting for ingestion + transitioning…' },
];

export type LaunchEvent =
  | { type: 'step:start'; stepId: LaunchStepId }
  | { type: 'step:done'; stepId: LaunchStepId }
  | { type: 'step:error'; stepId: LaunchStepId; error: Error }
  | { type: 'step:detail'; stepId: LaunchStepId; detail: string }
  | { type: 'broadcast-created'; broadcast: YouTubeBroadcast }
  | { type: 'ingestion-ready'; ingestion: StreamIngestionInfo }
  | { type: 'cleanup'; deleted: string[] }
  | { type: 'complete'; broadcast: YouTubeBroadcast };

export interface RunLaunchOptions {
  settings: StreamSettings;
  onEvent: (event: LaunchEvent) => void;
  signal?: AbortSignal;
}

function log(...args: unknown[]) {
  console.info('[launch]', ...args);
}

function maskKey(key: string): string {
  return key ? `<${key.length}-char key ending …${key.slice(-4)}>` : '<empty>';
}

// ---- module-level serialization ----
//
// At most one launch may be in flight at a time. A new call aborts the prior
// one and *waits for it to fully settle* (including the catch-block YouTube
// cleanup) before starting. This prevents the race that was causing OBS to be
// configured with stream key A while video was being sent to broadcast B:
//
//   - React StrictMode mounts useEffect twice in dev
//   - User double-clicks Go Live
//   - User clicks Cancel then immediately re-submits
//
// Each of those previously kicked off a second parallel `runLaunchSequence`
// that competed with the first for the shared OBS service object. Whichever
// `SetStreamServiceSettings` call finished last won — but the broadcast we
// surfaced to the UI might have been from the other launch, so video would
// arrive at the wrong YouTube broadcast (often a deleted one, since the
// aborted launch's catch block cleans up its broadcast).
//
// With serialization the second launch sits idle until the first has fully
// torn down its OBS write + deleted its orphan broadcast, then runs cleanly.

let activeLaunch: Promise<YouTubeBroadcast> | null = null;
let activeAbort: AbortController | null = null;

/**
 * Aborts the currently-active launch sequence (if any). Used by App's
 * `handleSignOut` to ensure cleanup runs with valid auth tokens BEFORE
 * sign-out clears them (audit H6).
 *
 * This is NOT for per-step aborts within a launch — pass an `AbortSignal`
 * into `runLaunchSequence` for that. This helper exists solely for the
 * App-level sign-out drain.
 */
export function abortActiveLaunch(): void {
  activeAbort?.abort();
}

/**
 * Returns a promise that resolves when the currently-active launch (if any)
 * has fully settled, including its cleanup branch. Resolves to
 * `Promise<unknown>` because callers don't care about the result here — we
 * only care about completion. Used by `handleSignOut` together with
 * `abortActiveLaunch()` to wait out the cleanup before clearing tokens.
 */
export function awaitActiveLaunchSettled(): Promise<unknown> {
  return activeLaunch ?? Promise.resolve();
}

export async function runLaunchSequence(opts: RunLaunchOptions): Promise<YouTubeBroadcast> {
  log('runLaunchSequence requested');

  // Wait out any prior launch. We loop because, in rare timing windows, a
  // third call could land between our await and our assignment of
  // `activeLaunch` below — guarding with `while` makes it idempotent.
  while (activeLaunch) {
    log('runLaunchSequence: a prior launch is still in flight — aborting it and waiting for cleanup');
    activeAbort?.abort();
    try {
      await activeLaunch;
    } catch {
      // expected — the prior launch was aborted
    }
  }

  // Merge the caller's abort signal with our internal one so either can stop
  // this run. We use our own controller for the serialization-driven aborts
  // above; the caller's signal is for component-unmount cleanup, etc.
  const myAbort = new AbortController();
  activeAbort = myAbort;

  const mergedController = new AbortController();
  // When the merged signal fires, also reach into main and abort any in-flight
  // YouTube fetches. AbortSignal can't cross IPC, so without this an aborted
  // launch would have to wait out each running fetch's per-attempt timeout
  // (up to 20s × 3 retries) before unwinding.
  const propagate = () => {
    mergedController.abort();
    void youtube.cancel().catch(() => undefined);
  };
  if (opts.signal) {
    if (opts.signal.aborted) propagate();
    else opts.signal.addEventListener('abort', propagate, { once: true });
  }
  myAbort.signal.addEventListener('abort', propagate, { once: true });

  let myPromise!: Promise<YouTubeBroadcast>;
  myPromise = (async () => {
    try {
      return await _runLaunchSequence(
        { ...opts, signal: mergedController.signal },
        { propagate, callerSignal: opts.signal, internalSignal: myAbort.signal },
      );
    } finally {
      // Only clear the module slots if they still point to us — a newer launch
      // may have replaced us, in which case we leave its bookkeeping alone.
      if (activeLaunch === myPromise) activeLaunch = null;
      if (activeAbort === myAbort) activeAbort = null;
      // Symmetric listener detachment — the catch block in _runLaunchSequence
      // detaches both signals on failure (H7), so on the happy path we mirror
      // that here. `myAbort` becomes unreachable after this finally returns,
      // so this is belt-and-braces against future refactors that retain the
      // controller (e.g. for diagnostics).
      opts.signal?.removeEventListener('abort', propagate);
      myAbort.signal.removeEventListener('abort', propagate);
    }
  })();

  activeLaunch = myPromise;
  return myPromise;
}

// Internal handle for `_runLaunchSequence` so its catch block can detach the
// propagate listener before running cleanup. See H7 below.
interface InternalLaunchHandle {
  propagate: () => void;
  callerSignal: AbortSignal | undefined;
  internalSignal: AbortSignal;
}

async function _runLaunchSequence(
  { settings, onEvent, signal }: RunLaunchOptions,
  handle: InternalLaunchHandle,
): Promise<YouTubeBroadcast> {
  const run = async <T>(stepId: LaunchStepId, work: () => Promise<T>): Promise<T> => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const startedAt = Date.now();
    log(`step:start ${stepId}`);
    onEvent({ type: 'step:start', stepId });
    try {
      const result = await work();
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      log(`step:done  ${stepId} (${Date.now() - startedAt}ms)`);
      onEvent({ type: 'step:done', stepId });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log(`step:error ${stepId} (${Date.now() - startedAt}ms): ${error.message}`);
      onEvent({ type: 'step:error', stepId, error });
      throw error;
    }
  };

  // YouTube resources created during this run — captured in outer scope so
  // the catch block can clean them up on failure or abort.
  let broadcast: YouTubeBroadcast | null = null;
  let stream: YouTubeLiveStream | null = null;
  const launchStart = Date.now();
  // Track how far the OBS-side steps got. The cleanup branch uses this to
  // decide whether to drop the OBS connection — connected/configured failures
  // need a clean re-handshake on the next launch (otherwise the next attempt
  // inherits a possibly half-dead WebSocket), but a 'streaming' failure is
  // left alone per the documented invariant ("never auto-stop a live stream
  // on a flaky go-live"). See docs/launch-flow.md §8.
  type ObsProgress = 'none' | 'connected' | 'configured' | 'streaming';
  let obsProgress = 'none' as ObsProgress;

  try {
    // 1. Validate the form a final time on the orchestrator side — defends
    //    against callers that bypass the UI button-disable.
    await run('validate', async () => {
      validateSettings(settings);
      await sleep(250); // brief flash so the step is actually visible
    });

    // 2. Confirm YouTube sign-in (no OAuth popup — just inspects stored tokens).
    await run('auth', async () => {
      const user = await youtube.getCurrentUser();
      if (!user) {
        throw new Error('You are not signed in to YouTube. Sign in from the login screen and try again.');
      }
    });

    // 3. Create the YouTube broadcast (the live event metadata).
    broadcast = await run('broadcast', () => youtube.createBroadcast(settings));
    log('broadcast id:', broadcast.id);
    onEvent({ type: 'broadcast-created', broadcast });

    // 3a. Optional, best-effort thumbnail upload. Runs OUTSIDE the run()
    //     wrapper so the broadcast step's step:done has already fired;
    //     the UI shows a detail line on the now-closed broadcast row.
    //     A thumbnail failure must NEVER abort the launch — emit a
    //     step:detail warning and continue. NOT a new entry in
    //     LAUNCH_STEPS (the user-facing 10-step ring stays unchanged).
    if (settings.thumbnailFile) {
      onEvent({
        type: 'step:detail',
        stepId: 'broadcast',
        detail: 'Uploading thumbnail to YouTube…',
      });
      try {
        await youtube.uploadThumbnail(broadcast.id, settings.thumbnailFile);
        log('thumbnail uploaded for broadcast', broadcast.id);
        onEvent({
          type: 'step:detail',
          stepId: 'broadcast',
          detail: 'Thumbnail uploaded.',
        });
      } catch (thumbErr) {
        const msg = thumbErr instanceof Error ? thumbErr.message : String(thumbErr);
        console.warn('[launch] thumbnail upload failed (non-fatal):', msg);
        onEvent({
          type: 'step:detail',
          stepId: 'broadcast',
          detail: `Thumbnail upload failed: ${msg} — broadcast continues without it.`,
        });
      }
    }

    // 4. Create the YouTube live stream (the ingestion endpoint).
    stream = await run('stream', () => youtube.createLiveStream(settings));
    log('stream id:', stream.id);

    // 5. Bind broadcast → stream. This now asserts the bound stream id
    //    matches what we provisioned (see electron/youtube.ts).
    await run('bind', () => youtube.bindBroadcastToStream(broadcast!.id, stream!.id));

    // 6. Pull the real RTMP URL + stream key.
    const ingestion = await run('ingestion', () => youtube.getStreamIngestionInfo(stream!.id));
    if (ingestion.streamId !== stream.id) {
      // Should be impossible after the assertion in getStreamIngestionInfo,
      // but belt-and-suspenders since we're about to send credentials to OBS.
      throw new Error(
        `Ingestion info is for stream ${ingestion.streamId} but we provisioned ${stream.id}. Refusing to continue.`,
      );
    }
    log('ingestion ready:', {
      streamId: ingestion.streamId,
      rtmpUrl: ingestion.rtmpUrl,
      streamKey: maskKey(ingestion.streamKey),
    });
    onEvent({ type: 'ingestion-ready', ingestion });

    // 7. Connect to OBS over WebSocket. Retry a couple of times in case OBS
    //    is still finishing its startup handshake.
    await run('connect-obs', async () => {
      await obs.connect(settings.obsPassword, { attempts: 3, retryDelayMs: 1500 });
      obsProgress = 'connected';
    });

    // 8. Send the YouTube credentials to OBS via SetStreamServiceSettings.
    //    `configureStreamService` poll-verifies via GetStreamServiceSettings.
    await run('configure-obs', async () => {
      await obs.configureStreamService({
        rtmpUrl: ingestion.rtmpUrl,
        streamKey: ingestion.streamKey,
      });
      obsProgress = 'configured';
    });

    // 9. Tell OBS to start the actual RTMP push.
    //    BEFORE sending the irrevocable StartStream command, do one final
    //    immutable read+match of the current OBS service settings. This
    //    catches any drift between our configure-verify and now (e.g. OBS
    //    Studio's Connect Account integration re-mutating the service
    //    asynchronously). If anything is off — wrong type, wrong server,
    //    wrong key — we throw before pushing a single byte of video.
    await run('start-stream', async () => {
      await obs.assertActiveStreamServiceSettings({
        rtmpUrl: ingestion.rtmpUrl,
        streamKey: ingestion.streamKey,
      });
      // H3: mark BEFORE the StartStream call so a verify-loop timeout still
      // routes through the cleanup branch's 'streaming' rollback. Without
      // this, if obs.startStreaming() rejects after OBS has already begun
      // pushing RTMP (e.g. our 5s outputActive poll times out but the actual
      // encoder is running), obsProgress stays 'configured' and cleanup
      // doesn't call stopStreaming — OBS keeps streaming to a deleted
      // broadcast endpoint. obs.startStreaming is internally bounded and
      // obs.stopStreaming is a no-op when state !== 'streaming', so marking
      // optimistically is safe.
      obsProgress = 'streaming';
      const result = await obs.startStreaming();
      return result;
    });

    // 10. Wait for YouTube to recognise the stream as active, then transition
    //     to live. We can't transition before YouTube is receiving video —
    //     the API rejects it.
    const liveBroadcast = await run('go-live', async () => {
      onEvent({
        type: 'step:detail',
        stepId: 'go-live',
        detail: 'Waiting for YouTube to receive video from OBS…',
      });
      await youtube.waitForStreamActive(stream!.id, {
        signal,
        onTick: ({ status, elapsedSeconds }) => {
          onEvent({
            type: 'step:detail',
            stepId: 'go-live',
            detail: `YouTube reports stream "${status}" — waiting (${elapsedSeconds}s)…`,
          });
        },
      });
      onEvent({
        type: 'step:detail',
        stepId: 'go-live',
        detail: 'Transitioning broadcast to live…',
      });
      return youtube.transitionToLive(broadcast!);
    });

    log(`launch complete — broadcast is live (total ${Date.now() - launchStart}ms)`);
    onEvent({ type: 'complete', broadcast: liveBroadcast });
    return liveBroadcast;
  } catch (err) {
    // H7: detach the propagate listener before running cleanup so a
    // user-initiated abort (which fires propagate -> youtube.cancel()) cannot
    // cancel the cleanup branch's own youtube.deleteBroadcast /
    // deleteLiveStream calls. Without this, a Cancel-during-cleanup fires
    // youtube.cancel() which aborts the in-flight deletes, orphaning resources
    // on the user's channel. The listeners were registered { once: true } but
    // may not have fired yet — explicit removeEventListener is required.
    handle.callerSignal?.removeEventListener('abort', handle.propagate);
    handle.internalSignal.removeEventListener('abort', handle.propagate);
    // Clean up any orphaned YouTube resources + roll back OBS state before
    // re-throwing so the user doesn't accumulate dead broadcasts/streams from
    // failed launches or mid-launch navigation. Each YouTube delete is
    // internally retried up to 3× on transient 5xx/429 by the main-process
    // `callDelete` helper, so a single network blip during cleanup no longer
    // leaves an orphan on the user's channel. Runs in parallel so one cleanup
    // failing doesn't mask the original error or block the other.
    const deleted: string[] = [];
    const tasks: Promise<unknown>[] = [];
    if (broadcast) {
      const id = broadcast.id;
      tasks.push(
        youtube.deleteBroadcast(id).then(
          () => deleted.push(`broadcast ${id}`),
          (cleanupErr) =>
            console.warn('[launch] failed to delete orphan broadcast', id, cleanupErr),
        ),
      );
    }
    if (stream) {
      const id = stream.id;
      tasks.push(
        youtube.deleteLiveStream(id).then(
          () => deleted.push(`stream ${id}`),
          (cleanupErr) =>
            console.warn('[launch] failed to delete orphan stream', id, cleanupErr),
        ),
      );
    }
    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
      if (deleted.length > 0) {
        log('cleanup complete:', deleted);
        onEvent({ type: 'cleanup', deleted });
      }
    }

    // OBS state hygiene. Two branches:
    //
    //  - 'connected' / 'configured': we opened a WebSocket and possibly wrote
    //    a stream-service config pointing at the now-deleted broadcast. Drop
    //    the connection so the next launch starts from a clean slate.
    //
    //  - 'streaming': step 9 (start-stream) succeeded but a later step failed
    //    — OBS is actively pushing RTMP to a broadcast we're about to delete.
    //    Stop it. This contradicts the "never auto-stop a live stream"
    //    invariant in docs/launch-flow.md §8, but only superficially: that
    //    invariant assumes the broadcast might still be salvageable. In the
    //    cleanup branch the broadcast is being deleted unconditionally, so
    //    leaving OBS pushing to a tombstoned endpoint is strictly worse than
    //    a graceful stop (the user gets a frozen-LIVE chip and a failed RTMP
    //    output instead).
    // Each cleanup OBS call is bounded by a 5s timeout. The catch block runs
    // on the user's "I just clicked Cancel" path too — if OBS itself is wedged
    // (the WebSocket accepted the request but the OBS event loop is frozen,
    // which we've seen during long encode-init stalls), an un-timed-out
    // `await obs.stopStreaming()` / `await obs.disconnect()` would hang the
    // whole orchestrator forever and the LaunchStatusScreen would sit on
    // "Cleaning up…" with no way out. The 5s budget is generous enough that
    // a healthy OBS always finishes inside it, and short enough that a
    // frozen OBS doesn't pin the user.
    const CLEANUP_TIMEOUT_MS = 5000;
    if (obsProgress === 'streaming') {
      // H3 / M4: always issue an unconditional StopStream + disconnect.
      // `obs.stopStreaming()` is guarded on `status.state === 'streaming'`,
      // so in the race window where (a) StartStream was accepted by OBS but
      // (b) our local status hasn't yet flipped to 'streaming' (the
      // StreamStateChanged event is still in flight or the verify-loop
      // timed out optimistically), the guarded call would no-op and the
      // subsequent disconnect would sever the WebSocket while OBS pushed
      // RTMP to a tombstoned broadcast for 10–30 s. `forceStopStream`
      // bypasses the guard so we cleanly tear down whichever side of the
      // race actually won.
      log('launch-cleanup: obsProgress="streaming" after a failed launch — force-stopping and disconnecting OBS');
      await obs.forceStopStream(CLEANUP_TIMEOUT_MS).catch((stopErr) =>
        console.warn(
          '[launch] cleanup forceStopStream:',
          stopErr instanceof Error ? stopErr.message : stopErr,
        ),
      );
      // Always follow with disconnect so OBS doesn't sit configured for a
      // deleted broadcast.
      await Promise.race<unknown>([
        obs.disconnect(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('disconnect timed out')), CLEANUP_TIMEOUT_MS),
        ),
      ]).catch((discErr) =>
        console.warn(
          '[launch] cleanup disconnect:',
          discErr instanceof Error ? discErr.message : discErr,
        ),
      );
    } else if (obsProgress === 'connected' || obsProgress === 'configured') {
      const obsState = obs.getStatus().state;
      if (obsState === 'connected' || obsState === 'connecting') {
        log(`launch-cleanup: forcing OBS disconnect (obsProgress="${obsProgress}", obsState="${obsState}")`);
        await Promise.race<unknown>([
          obs.disconnect(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('disconnect timed out')), CLEANUP_TIMEOUT_MS),
          ),
        ]).catch((disconnectErr) =>
          console.warn('[launch] failed to disconnect OBS during cleanup:', disconnectErr),
        );
      }
    }

    throw err;
  }
}

// ---- validation ----

const PRIVACY_VALUES = ['public', 'unlisted', 'private'] as const;

function validateSettings(settings: StreamSettings): void {
  const title = settings.title.trim();
  if (!title) {
    throw new Error('Stream title is required.');
  }
  if (title.length > 100) {
    throw new Error(`Stream title is ${title.length} characters — YouTube allows at most 100.`);
  }
  if (settings.description.length > 5000) {
    throw new Error(`Description is ${settings.description.length} characters — YouTube allows at most 5000.`);
  }
  if (!settings.obsPassword.trim()) {
    throw new Error('OBS WebSocket password is required.');
  }
  if (!PRIVACY_VALUES.includes(settings.privacy)) {
    throw new Error(`Invalid privacy value "${settings.privacy}".`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
