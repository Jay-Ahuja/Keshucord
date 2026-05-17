# Launch Flow

> The canonical "how going live works" document. Read this first when
> debugging the launch sequence, modifying step semantics, or
> reasoning about a stuck/failed broadcast.
>
> Companion docs:
> [`obs-flow.md`](./obs-flow.md) for OBS WebSocket detail,
> [`youtube-flow.md`](./youtube-flow.md) for YouTube Data API detail.

## 1. Source files

| Concern | File |
|---|---|
| Orchestrator + mutex + step constants | [`src/services/launchService.ts`](../src/services/launchService.ts) |
| Renderer-side OBS service | [`src/services/obsService.ts`](../src/services/obsService.ts) |
| Renderer-side YouTube facade | [`src/services/youtubeService.ts`](../src/services/youtubeService.ts) |
| Main-process YouTube client | [`electron/youtube.ts`](../electron/youtube.ts) |
| UI: the launch screen | [`src/screens/LaunchStatusScreen.tsx`](../src/screens/LaunchStatusScreen.tsx) |
| Ingestion info display | [`src/components/IngestionInfoCard.tsx`](../src/components/IngestionInfoCard.tsx) |
| Step types | [`src/types/launch.ts`](../src/types/launch.ts) |

## 2. Lifecycle at a glance

```
User clicks "Go Live" on CreateScreen
   │
   ▼
App.tsx → setStreamSettings(form) + setScreen('launch')
   │
   ▼
LaunchStatusScreen mounts
   │
   ├─ useState: statuses, details, broadcast, ingestion, fatalError, cleanedUp
   ├─ useEffect:
   │    const controller = new AbortController()
   │    runLaunchSequence({ settings, signal, onEvent })
   │    return () => controller.abort()
   │
   ▼
runLaunchSequence (PUBLIC, in launchService.ts)
   │
   ├─ while (activeLaunch) { activeAbort.abort(); await activeLaunch.catch(); }
   │     ◄── module-level mutex (see §11)
   │
   ├─ activeAbort = new AbortController()
   ├─ merged = merge(opts.signal, activeAbort.signal)
   ├─ activeLaunch = _runLaunchSequence({ ...opts, signal: merged })
   └─ return activeLaunch
   │
   ▼
_runLaunchSequence (PRIVATE)
   │
   ├─ try {
   │     for each of the 10 steps:
   │       run(stepId, work)
   │         ├─ if signal.aborted → throw DOMException('Aborted', 'AbortError')
   │         ├─ onEvent({ type: 'step:start', stepId })
   │         ├─ await work()
   │         ├─ if signal.aborted (post-work) → throw
   │         ├─ onEvent({ type: 'step:done', stepId })
   │         └─ catch → onEvent({ type: 'step:error', … }) + rethrow
   │   } catch (err) {
   │     cleanup orphan broadcast + stream (Promise.allSettled)
   │     onEvent({ type: 'cleanup', deleted })
   │     throw err
   │   }
   │
   ▼
LaunchStatusScreen receives events
   │
   ├─ step:start → statuses[stepId] = 'active'
   ├─ step:done → statuses[stepId] = 'done'
   ├─ step:error → statuses[stepId] = 'error' + fatalError = message
   ├─ step:detail → details[stepId] = message  (live sub-line text)
   ├─ broadcast-created → broadcast = …      (after step 3 succeeds)
   ├─ ingestion-ready → ingestion = …        (after step 6 succeeds)
   ├─ cleanup → cleanedUp = [...ids]          (after a failure)
   └─ complete → broadcast = liveBroadcast    (after step 10 succeeds)
```

## 3. The ten steps

The canonical list lives in `LAUNCH_STEPS` (exported from `launchService.ts`,
consumed by `LaunchStatusScreen` to render the checklist). Each step has
an `id`, a `label` shown on the row, and a default `detail` shown below
the label when active.

| # | id | Where the work happens | One-line description |
|---|---|---|---|
| 1 | `validate` | `validateSettings(settings)` in launchService.ts | Local sanity-check of the form (title, description length, OBS password presence, privacy). |
| 2 | `auth` | `youtubeService.getCurrentUser()` → IPC → `auth.getCurrentUser()` | Confirms a YouTube user is signed in. **Does not** re-prompt OAuth. |
| 3 | `broadcast` | `youtubeService.createBroadcast(settings)` → IPC → YouTube `liveBroadcasts.insert` + best-effort `videos.update` | Creates the YouTube broadcast (the "event"). |
| 4 | `stream` | `youtubeService.createLiveStream(settings)` → IPC → YouTube `liveStreams.insert` | Creates a fresh, non-reusable live-stream resource (the ingestion endpoint). |
| 5 | `bind` | `youtubeService.bindBroadcastToStream(broadcastId, streamId)` → IPC → YouTube `liveBroadcasts.bind` | Links broadcast ↔ stream. Asserts `boundStreamId === streamId`. |
| 6 | `ingestion` | `youtubeService.getStreamIngestionInfo(streamId)` → IPC → YouTube `liveStreams.list?part=cdn` | Pulls the RTMP URL + stream key. Asserts `items[0].id === streamId`. |
| 7 | `connect-obs` | `obs.connect(password, { attempts: 3, retryDelayMs: 1500 })` (WebSocket Identify handshake) | Opens the WebSocket to OBS. Retries 3× to absorb OBS still-starting state. |
| 8 | `configure-obs` | `obs.configureStreamService({ rtmpUrl, streamKey })` (OBS `SetStreamServiceSettings`) | Writes the YouTube ingest URL + stream key into OBS as a `rtmp_custom` service. Poll-verifies via `GetStreamServiceSettings` for up to 3 s. |
| 9 | `start-stream` | `obs.assertActiveStreamServiceSettings(...)` + `obs.startStreaming()` (OBS `StartStream` + poll `GetStreamStatus.outputActive` for 5 s) | Final immutable read of OBS service settings, then `StartStream`, then verify OBS actually started pushing. |
| 10 | `go-live` | `youtubeService.waitForStreamActive(streamId)` (polls YouTube every 2 s for 90 s) + `youtubeService.transitionToLive(broadcast)` (YouTube `liveBroadcasts.transition?broadcastStatus=live`) | Wait for YouTube to confirm it's receiving video, then flip the broadcast to live. |

Each step is wrapped in the `run(stepId, work)` helper which:

1. Aborts immediately if `signal.aborted`.
2. Emits `step:start`.
3. Awaits the work function.
4. Aborts again post-work (so a long-running call doesn't slip past abort).
5. Emits `step:done` on success, `step:error` on throw.
6. Re-throws so the outer try/catch can run cleanup.

## 4. Per-step contracts and side effects

### Step 1 — `validate`

```ts
validateSettings(settings)        // src/services/launchService.ts
await sleep(250)                  // intentional UI delay so the row visibly turns green
```

Validation rules:

| Rule | Throws |
|---|---|
| `title.trim()` is empty | "Stream title is required." |
| `title.length > 100` | "Stream title is N characters — YouTube allows at most 100." |
| `description.length > 5000` | "Description is N characters — YouTube allows at most 5000." |
| `obsPassword.trim()` is empty | "OBS WebSocket password is required." |
| `privacy` not in `{ 'public', 'unlisted', 'private' }` | `Invalid privacy value "X".` |

The CreateScreen Go-Live button gates on the same rules so users rarely
hit this — but it's the canonical gate.

### Step 2 — `auth`

```ts
const user = await youtubeService.getCurrentUser();
if (!user) throw new Error('You are not signed in to YouTube. …');
```

This step **inspects stored tokens only**. It does not open the browser
or run OAuth. If `tokens.enc` is missing/decryption-failed, `getCurrentUser` returns null and this throws.

Token refresh (if the access token is within 60 s of expiry) is delegated
to `auth.getAccessToken()` at the per-API-call level, not this step.

### Step 3 — `broadcast`

```ts
broadcast = await youtubeService.createBroadcast(settings);
onEvent({ type: 'broadcast-created', broadcast });
```

This is the **first irreversible side effect** of the launch. Once this
step succeeds:

- A real broadcast exists on the user's YouTube channel.
- If anything later fails, the catch block calls
  `youtube.deleteBroadcast(broadcast.id)` for cleanup.
- The `broadcast-created` event lets `LaunchStatusScreen` populate
  `IngestionInfoCard` with the watch URL immediately (without waiting
  for ingestion info).

Best-effort `videos.update` to set `categoryId` + `tags` follows the
insert inside `electron/youtube.ts` — if it fails, the broadcast is
still good, just with the default category.

### Step 4 — `stream`

```ts
stream = await youtubeService.createLiveStream(settings);
```

Second irreversible side effect. Cleanup mirror for failure:
`youtube.deleteLiveStream(stream.id)`. The stream is provisioned with
`isReusable: false` so each launch gets a fresh stream key.

### Step 5 — `bind`

```ts
await youtubeService.bindBroadcastToStream(broadcast.id, stream.id);
```

Triple-asserted on the main process side:

- Response's `data.id === broadcastId`
- Response's `data.contentDetails.boundStreamId` is present
- `boundStreamId === streamId`

Any disagreement throws "Aborting to avoid streaming to the wrong destination."

### Step 6 — `ingestion`

```ts
const ingestion = await youtubeService.getStreamIngestionInfo(stream.id);
if (ingestion.streamId !== stream.id) throw …;     // belt-and-suspenders check
onEvent({ type: 'ingestion-ready', ingestion });
```

The orchestrator does its own `ingestion.streamId === stream.id` check
*on top of* the assertion already baked into `electron/youtube.ts`. This
is because the next step sends `ingestion.rtmpUrl` + `ingestion.streamKey`
to OBS — a wrong stream id here means OBS gets the wrong key.

After this step the IngestionInfoCard renders fully (broadcast watch URL
+ RTMP URL + masked stream key with Show/Copy controls).

### Step 7 — `connect-obs`

```ts
await obs.connect(settings.obsPassword, { attempts: 3, retryDelayMs: 1500 });
```

WebSocket handshake. Three attempts at 1.5 s spacing absorbs:
- OBS still finishing its startup.
- A transient socket failure.

Hardcoded `ws://localhost:4455` in `obsService.ts`. After this step:
- `status.state` is `connected`.
- Health polling is **not** running yet (it starts on `streaming` only).
- Subsequent OBS calls in the launch chain will use this connection.

Failure modes:
- Wrong password → "OBS rejected the password…"
- OBS not running → "Could not reach OBS at ws://localhost:4455. …"
- Already streaming → "Stop the stream before reconnecting to OBS."

### Step 8 — `configure-obs`

```ts
await obs.configureStreamService({
  rtmpUrl: ingestion.rtmpUrl,
  streamKey: ingestion.streamKey,
});
```

Four-phase implementation inside `obsService.configureStreamService`:

1. **Pre-checks**: must be `connected` (not `streaming`, not `connecting`,
   not `disconnected`). `rtmpUrl` + `streamKey` must be non-empty.
2. **Read current state**: `GetStreamServiceSettings` and log it. Detect
   YouTube-managed mode (rtmp_common + service name containing "youtube")
   and emit a `[obs] WARNING:` log line. This is the canonical reason
   OBS will reject our subsequent write.
3. **Write**: `SetStreamServiceSettings({ streamServiceType: 'rtmp_custom',
   streamServiceSettings: { server: rtmpUrl, key: streamKey, use_auth: false } })`.
4. **Poll-verify**: every 200 ms for up to 3 s, read `GetStreamServiceSettings` and compare `streamServiceType`, `server`, `key`. The OBS frontend
   persists service config asynchronously; this catches that without an
   arbitrary `sleep`.

Failure modes:

- OBS rejects the write → throws with the OBS message.
- Verification times out at 3 s → throws with the precise drift
  (`service type is still "rtmp_common"` / `server is "X" but we wanted "Y"` / `key didn't change`) + the YouTube-Account-disconnect fix.

### Step 9 — `start-stream`

```ts
await obs.assertActiveStreamServiceSettings({
  rtmpUrl: ingestion.rtmpUrl,
  streamKey: ingestion.streamKey,
});
return obs.startStreaming();
```

Two-phase. The **assertion** is the final defense in depth:

- Single immutable read of `GetStreamServiceSettings`.
- Required: `streamServiceType === 'rtmp_custom'`, `server === ingestion.rtmpUrl`, `key === ingestion.streamKey`. Any mismatch throws
  with the exact drift named.
- Catches the case where OBS's account-linked YouTube integration
  asynchronously mutates the active service between step 8's verify
  and now.

Then `startStreaming`:

- `obs.call('StartStream')`.
- Poll `GetStreamStatus.outputActive` every 250 ms for up to 5 s.
- If `outputActive` never flips true, throw "OBS accepted the StartStream
  command but is not actually streaming. … 'You must select a broadcast
  first.' …".

On success, `status.state` flips to `streaming`. The
`StreamStateChanged` listener in `obsService` and `setStatus`'s state-change
funnel both detect this — `startHealthPolling()` begins, the bitrate ring
buffer starts filling, the TitleBar's LIVE chip appears.

### Step 10 — `go-live`

Two phases inside the single step:

```ts
const liveBroadcast = await run('go-live', async () => {
  onEvent({ type: 'step:detail', stepId: 'go-live',
            detail: 'Waiting for YouTube to receive video from OBS…' });

  await youtubeService.waitForStreamActive(stream.id, {
    signal,
    onTick: ({ status, elapsedSeconds }) => {
      onEvent({ type: 'step:detail', stepId: 'go-live',
                detail: `YouTube reports stream "${status}" — waiting (${elapsedSeconds}s)…` });
    },
  });

  onEvent({ type: 'step:detail', stepId: 'go-live',
            detail: 'Transitioning broadcast to live…' });

  return youtubeService.transitionToLive(broadcast);
});
```

`waitForStreamActive` (in `src/services/youtubeService.ts`, renderer side):

- Calls `youtubeService.getStreamStatus(streamId)` every 2 s (default).
- Each tick fires the `step:detail` event with the current status + elapsed
  seconds — drives the live "YouTube reports stream "ready" — waiting
  (8s)…" text in the checklist row.
- Returns when status flips to `'active'`.
- Throws "YouTube reports the stream is in an error state. …" if status is
  `'error'`.
- Throws "Timed out waiting for YouTube to receive video from OBS. …" after
  90 s.

`transitionToLive(broadcast)`:

- Calls IPC `youtube:transition-live`.
- Main process POSTs to `liveBroadcasts.transition?broadcastStatus=live`.
- Merges the response's new status into the local broadcast object and
  returns it.

After this returns successfully, the orchestrator emits the **`complete`**
event with the live broadcast — `LaunchStatusScreen` flips into the
celebration state (LIVE chip, "You are live on YouTube", Copy/Open/Stream
Health footer buttons).

## 5. LaunchEvent type, in order of expected emission

```ts
type LaunchEvent =
  | { type: 'step:start'; stepId: LaunchStepId }
  | { type: 'step:done'; stepId: LaunchStepId }
  | { type: 'step:error'; stepId: LaunchStepId; error: Error }
  | { type: 'step:detail'; stepId: LaunchStepId; detail: string }
  | { type: 'broadcast-created'; broadcast: YouTubeBroadcast }
  | { type: 'ingestion-ready'; ingestion: StreamIngestionInfo }
  | { type: 'cleanup'; deleted: string[] }
  | { type: 'complete'; broadcast: YouTubeBroadcast };
```

A typical happy-path event trace:

```
step:start validate
step:done  validate
step:start auth
step:done  auth
step:start broadcast
step:done  broadcast
broadcast-created (broadcast: {…})
step:start stream
step:done  stream
step:start bind
step:done  bind
step:start ingestion
step:done  ingestion
ingestion-ready (ingestion: {…})
step:start connect-obs
step:done  connect-obs
step:start configure-obs
step:done  configure-obs
step:start start-stream
step:done  start-stream
step:start go-live
step:detail go-live "Waiting for YouTube to receive video from OBS…"
step:detail go-live "YouTube reports stream "ready" — waiting (2s)…"
step:detail go-live "YouTube reports stream "ready" — waiting (4s)…"
…
step:detail go-live "Transitioning broadcast to live…"
step:done  go-live
complete (broadcast: {…, status: 'live'})
```

A failure path (e.g. wrong OBS password):

```
step:start validate
step:done  validate
step:start auth
step:done  auth
step:start broadcast
step:done  broadcast
broadcast-created (broadcast: {…})
step:start stream
step:done  stream
step:start bind
step:done  bind
step:start ingestion
step:done  ingestion
ingestion-ready (ingestion: {…})
step:start connect-obs
step:error connect-obs (error: "OBS rejected the password. …")
cleanup (deleted: ['broadcast bc_xxxxx', 'stream lstream_yyyyy'])
                  ◄── then the runLaunchSequence promise rejects with the
                       original error so the caller's `.catch` runs
```

## 6. LaunchStatusScreen state model

```ts
const [statuses,   setStatuses]   = useState<StatusMap>(initialStatuses);
//   ^ Record<LaunchStepId, 'pending' | 'active' | 'done' | 'error'>
const [details,    setDetails]    = useState<Partial<Record<LaunchStepId, string>>>({});
//   ^ live override text for the active row's sub-line
const [broadcast,  setBroadcast]  = useState<YouTubeBroadcast | null>(null);
const [ingestion,  setIngestion]  = useState<StreamIngestionInfo | null>(null);
const [fatalError, setFatalError] = useState<string | null>(null);
const [cleanedUp,  setCleanedUp]  = useState<string[]>([]);
const obsStatus  = useObsStatus();
const health     = useStreamHealth();
```

Derived UI state:

```ts
const done = broadcast?.status === 'live';          // celebration mode
const totalSteps = LAUNCH_STEPS.length;             // 10
const { doneCount, activeStepIdx, pct, progressDescription } = useMemo(…);

const ringDashOffset = RING_CIRC - (RING_CIRC * pct) / 100;
const focusStep      = LAUNCH_STEPS[activeStepIdx];
const inProgress     = !done && !fatalError;
const liveDuration   = isStreaming && health?.outputDurationMs
                          ? formatDuration(health.outputDurationMs) : '00:00:00';
```

`useMemo` derivation of progress:

```ts
const dones    = LAUNCH_STEPS.filter(s => statuses[s.id] === 'done').length;
const activeI  = LAUNCH_STEPS.findIndex(s => statuses[s.id] === 'active');
const errorI   = LAUNCH_STEPS.findIndex(s => statuses[s.id] === 'error');
const focusIdx = errorI !== -1 ? errorI : activeI !== -1 ? activeI : dones;
const pct      = Math.round((dones / 10) * 100);
```

The focus index is what the ring text + sub-line refer to. On error, the
focus jumps to the failing step (so "Launch failed" + the step's detail
shows). On normal progress, focus is the active step (sub-line shows
live `step:detail`). When no step is running (just before step 1 or
between steps) focus falls through to `dones` (the next step to run).

## 7. Cancellation flow

```
LaunchStatusScreen unmounts (user clicks Cancel / Back to setup /
                              sidebar nav / window close)
   │
   ▼
useEffect cleanup runs
   │
   ▼
controller.abort()              ◄── the AbortController created in useEffect
   │
   ▼ AbortSignal propagates through opts.signal → merged signal
   │
   ▼
Inside _runLaunchSequence:
   - if signal.aborted at start of next step → throw DOMException('Aborted', 'AbortError')
   - if signal.aborted after step's work resolves → same throw
   - if currently inside obs.call() or fetch() → in-flight; the throw happens
     once that promise resolves and run()'s next abort check fires
   │
   ▼
Catch block in _runLaunchSequence:
   - run cleanup on any broadcast / stream that was already created
   - re-throw the AbortError
   │
   ▼
runLaunchSequence (PUBLIC) finally block:
   - if (activeLaunch === myPromise) activeLaunch = null
   - if (activeAbort === myAbort) activeAbort = null
   - opts.signal.removeEventListener('abort', propagate)
   │
   ▼ A new launch can now start cleanly
```

**Important constraint**: in-flight `obs.call()` and `fetch()` operations
do **not** honor `AbortSignal` (obs-websocket-js's API doesn't accept one,
and our YouTube fetch wrappers don't thread it through either). So an
abort fired during a mid-step `obs.call` doesn't cancel the WebSocket
request — we wait for it to resolve, then the next `run()` abort check
catches us. This is fine functionally but means abort latency is
bounded by the slowest in-flight call.

`waitForStreamActive` is the one place that *does* honor the signal,
because it's a renderer-side polling loop we wrote.

## 8. Cleanup flow

Triggered by **any** throw inside the orchestrator (including the abort).
Implemented as the outer try/catch in `_runLaunchSequence`:

```ts
} catch (err) {
  const deleted: string[] = [];
  const tasks: Promise<unknown>[] = [];

  if (broadcast) {
    const id = broadcast.id;
    tasks.push(
      youtubeService.deleteBroadcast(id).then(
        () => deleted.push(`broadcast ${id}`),
        (cleanupErr) => console.warn('[launch] failed to delete orphan broadcast', id, cleanupErr),
      ),
    );
  }
  if (stream) {
    const id = stream.id;
    tasks.push(
      youtubeService.deleteLiveStream(id).then(
        () => deleted.push(`stream ${id}`),
        (cleanupErr) => console.warn('[launch] failed to delete orphan stream', id, cleanupErr),
      ),
    );
  }

  if (tasks.length > 0) {
    await Promise.allSettled(tasks);          // both run, neither blocks the other
    if (deleted.length > 0) {
      onEvent({ type: 'cleanup', deleted });   // UI shows "Cleaned up orphan broadcast bc_xxx, stream lstream_yyy"
    }
  }

  throw err;                                   // original error wins
}
```

Cleanup invariants:

- **Best-effort**: a cleanup failure logs `console.warn` and is swallowed
  — the user sees the original error, not the cleanup error.
- **Parallel**: `Promise.allSettled` so a hanging delete doesn't block
  the other.
- **Order-independent**: deleting the stream first vs broadcast first
  doesn't matter to YouTube — `bind` is automatically severed when
  either side is deleted.
- **No "I already started OBS streaming" cleanup**: if step 9
  (`start-stream`) succeeded but step 10 (`go-live`) fails, OBS is
  still pushing RTMP. We do NOT call `obs.stopStreaming()` in the
  cleanup branch. The user has to manually End Stream from DashScreen
  or stop OBS from inside OBS. This is intentional — auto-stopping a
  live broadcast on a flaky `go-live` step would be the wrong default
  if the stream is actually live but YouTube just lagged.

## 9. Failure handling per step

| Step | Most common failure | Side effect of failure | UI surface |
|---|---|---|---|
| `validate` | Missing title / OBS password | None | Red banner under checklist (rare — CreateScreen gates) |
| `auth` | Not signed in / tokens expired + refresh failed | None | Red banner. User signs back in from Login. |
| `broadcast` | YouTube `liveStreamingNotEnabled`, `quotaExceeded`, `insufficientPermissions` | None (no resource created yet) | Red banner with the API-mapped message |
| `stream` | Quota exhausted (less common) | Broadcast created → cleanup deletes it | Red banner + "Cleaned up orphan broadcast …" |
| `bind` | `liveBroadcastBindingNotAllowed`, or identity assertion fails | Broadcast + stream both exist → both cleaned up | Red banner |
| `ingestion` | "Stream does not have ingestion info available yet" (rare race) | Same as bind — both cleaned up | Red banner |
| `connect-obs` | Wrong password, OBS not running, already streaming | Broadcast + stream → cleanup | Red banner |
| `configure-obs` | YouTube-managed override, OBS rejects, verify timeout | Broadcast + stream → cleanup. **OBS settings may be in an unknown state** | Red banner naming the drift |
| `start-stream` | Assertion fails, `outputActive` never flips, OBS modal blocks | Broadcast + stream → cleanup | Red banner. **If OBS modal is up, user must dismiss + disconnect YouTube account in OBS** |
| `go-live` | `errorStreamInactive`, `waitForStreamActive` timeout, transition rejected | Broadcast + stream → cleanup. **Note: at this point OBS may be actively streaming**. Manual cleanup of OBS may be needed | Red banner with the YouTube-mapped message |

## 10. Retry behavior

| Where | Retries | Spacing |
|---|---|---|
| `obs.connect(password, { attempts: 3, retryDelayMs: 1500 })` | 3 total | 1.5 s |
| `configureStreamService` poll-verify loop | Loops every 200 ms | Up to 3 s deadline |
| `startStreaming` post-`StartStream` poll | Loops every 250 ms | Up to 5 s deadline |
| `waitForStreamActive` | Loops every 2 s | Up to 90 s deadline |
| YouTube API calls | **None** — single attempt; transient 5xx fails the launch | n/a |
| Step-level retry (re-run the whole launch) | **None** — user clicks Go Live again, which starts a fresh launch | n/a |

There is no "retry this step" affordance. The orchestrator is single-pass.

## 11. Race-condition prevention (module-level mutex)

This is the most important subtle behavior in the file. It exists because
the original implementation had a real bug — see
[`obs-flow.md` §10](./obs-flow.md#10-common-failure-cases).

```ts
let activeLaunch: Promise<YouTubeBroadcast> | null = null;
let activeAbort: AbortController | null = null;

export async function runLaunchSequence(opts) {
  // Wait out any prior launch
  while (activeLaunch) {
    activeAbort?.abort();
    try { await activeLaunch; } catch {}
  }

  // Set up our own controllers + merged signal
  const myAbort = new AbortController();
  activeAbort = myAbort;
  const mergedController = new AbortController();
  const propagate = () => mergedController.abort();
  if (opts.signal) {
    if (opts.signal.aborted) mergedController.abort();
    else opts.signal.addEventListener('abort', propagate, { once: true });
  }
  myAbort.signal.addEventListener('abort', propagate, { once: true });

  // Start the actual work
  let myPromise!: Promise<YouTubeBroadcast>;
  myPromise = (async () => {
    try {
      return await _runLaunchSequence({ ...opts, signal: mergedController.signal });
    } finally {
      if (activeLaunch === myPromise) activeLaunch = null;
      if (activeAbort === myAbort) activeAbort = null;
      opts.signal?.removeEventListener('abort', propagate);
    }
  })();

  activeLaunch = myPromise;
  return myPromise;
}
```

What this prevents:

| Scenario | Without the mutex | With the mutex |
|---|---|---|
| React StrictMode dev double-mount | Two `runLaunchSequence` calls in parallel; two broadcasts created; two OBS configures racing | Second call aborts the first, awaits its cleanup, then starts. Single broadcast. |
| User clicks Cancel then Go Live again before cleanup finishes | Two launches; OBS may end up with the *first* launch's stream key while video is sent to the *second* (now-deleted) broadcast | Second call awaits first's cleanup before starting |
| User double-clicks Go Live on Create | Two launches | Same — second awaits first |

What the mutex does **not** prevent:

- Mid-step abort latency. An in-flight `obs.call()` from the prior
  launch continues to completion before the next step's abort check
  triggers. The new launch has to wait for that, which is the cost.
- Cleanup failures. If `youtube.deleteBroadcast` fails during a
  prior-launch cleanup, the new launch still starts. The orphan
  remains.

## 12. Invariants

- **Exactly one launch is in flight at any time** (module-level mutex).
- **The `broadcast` and `stream` variables in `_runLaunchSequence`'s
  outer scope are the only references to the YouTube resources** the
  catch block can clean up. Don't return early from a step without
  assigning them.
- **`broadcast-created` is emitted exactly once, after step 3 succeeds.**
  `ingestion-ready` is emitted exactly once, after step 6 succeeds.
  `complete` is emitted exactly once, after step 10 succeeds.
  `cleanup` is emitted **at most** once, after a failure that produced
  at least one deletable resource.
- **The ingestion handed to `configureStreamService` is the ingestion
  fetched for `stream.id`.** Verified by the explicit
  `ingestion.streamId === stream.id` check in the orchestrator and
  by `electron/youtube.ts`'s own identity assertions.
- **The OBS stream service active at `StartStream` time has exactly the
  `rtmpUrl` and `streamKey` we configured.** Verified by
  `assertActiveStreamServiceSettings` immediately before the call.
- **OBS state is `streaming` only after `StartStream` + outputActive
  verification.** Health polling starts only on this state edge.
- **Cleanup runs on the SAME launch's resources, never another's.**
  `broadcast` and `stream` are closures local to the call, not module
  state.

## 13. Known edge cases

| Edge case | Current behavior |
|---|---|
| Network drops between `bind` and `ingestion` | `ingestion` fetch fails → cleanup deletes both resources → user retries |
| OBS quits while `configure-obs` is verifying | `obs.call` throws → step fails → cleanup runs |
| User closes the app window mid-launch | `LaunchStatusScreen` unmounts → abort → cleanup → app closes after cleanup awaits (briefly) |
| User signs out from sidebar while on launch screen | `handleSignOut` clears `user` state → routes to login. `LaunchStatusScreen` unmounts → abort → cleanup. OAuth tokens already revoked. **Edge**: in-flight youtube API calls in the cleanup may fail because tokens are gone — they're swallowed in `Promise.allSettled` so the unmount still completes. |
| User submits Go Live, then settings change before launch is wired up | Settings change updates `userSettings`, not `streamSettings`. Launch uses captured `streamSettings`. New settings take effect on the *next* launch. |
| OBS is already streaming when launch begins | `obs.connect` throws "Stop the stream before reconnecting to OBS." → step 7 fails → cleanup of broadcast + stream. |
| YouTube returns 503 mid-launch | Step fails → cleanup → user retries. No automatic retry. |
| User clicks "Open dashboard" while still in `go-live` waiting | `LaunchStatusScreen` unmounts via `setScreen('dash')` → abort → cleanup. **The just-created broadcast gets deleted.** This is a UX flaw — users may not expect this. The button is only rendered after `complete` so this is hard to trigger; included for completeness. |
| Two LaunchStatusScreen mounts in quick succession (e.g. Sidebar Going Live → New Stream → Going Live) | Mutex serializes — second mount's launch awaits first's cleanup |
| Cleanup partially succeeds (broadcast deleted, stream delete failed) | `cleanup` event lists only what succeeded. The orphan stream remains on YouTube. User would need to delete from YouTube Studio. |

## 14. Reading log lines while debugging

Look for the `[launch]`, `[obs]`, and `[youtube]` log prefixes. The
canonical happy-path trace:

```
[launch] runLaunchSequence requested
[launch] step:start validate
[launch] step:done  validate
[launch] step:start auth
[launch] step:done  auth
[launch] step:start broadcast
[youtube] createBroadcast → returned broadcast id bc_xxxxx
[launch] step:done  broadcast
[launch] broadcast id: bc_xxxxx
[launch] step:start stream
[youtube] createLiveStream → returned stream id lstream_yyyyy
[launch] step:done  stream
[launch] stream id: lstream_yyyyy
[launch] step:start bind
[youtube] bindBroadcastToStream: broadcast=bc_xxxxx stream=lstream_yyyyy
[youtube] bindBroadcastToStream → broadcast=bc_xxxxx boundStreamId=lstream_yyyyy
[launch] step:done  bind
[launch] step:start ingestion
[youtube] getStreamIngestionInfo: streamId=lstream_yyyyy
[youtube] getStreamIngestionInfo → { streamId: 'lstream_yyyyy', rtmpUrl: 'rtmps://…', streamKey: '<28-char key ending …xxxx>' }
[launch] step:done  ingestion
[launch] ingestion ready: { streamId: 'lstream_yyyyy', rtmpUrl: 'rtmps://…', streamKey: '<28-char key ending …xxxx>' }
[launch] step:start connect-obs
[obs] connect attempt 1/3 → ws://localhost:4455
[obs] connected (OBS WebSocket v5.x.x, scene "Dev Cave")
[launch] step:done  connect-obs
[launch] step:start configure-obs
[obs] current stream service before change: {…}
[obs] setting service to rtmp_custom (server="rtmps://…", key="<redacted>")
[obs] stream service settings verified
[launch] step:done  configure-obs
[launch] step:start start-stream
[obs] asserting OBS stream service matches expected ingestion
[obs] pre-StartStream OBS state: { type: 'rtmp_custom', server: '…', keyTail: '…xxxx', keyLen: 28, expectedServer: '…', expectedKeyTail: '…xxxx', expectedKeyLen: 28 }
[obs] pre-StartStream check passed — OBS is configured for our broadcast
[obs] calling StartStream
[obs] stream is active
[launch] step:done  start-stream
[launch] step:start go-live
[obs] starting stream health polling
… polling continues from here forever as long as streaming
[launch] step:done  go-live
[launch] launch complete — broadcast is live
```

If something goes wrong, the last `step:start <stepId>` without a matching
`step:done <stepId>` (or with a `step:error <stepId>`) points to the
failing step. For `configure-obs` or `start-stream` failures, compare
the `keyTail` / `expectedKeyTail` log line — a mismatch is the smoking
gun for OBS account-linked override.

## 15. Reference: minimum changes to add a new step

If you ever need to add a step (e.g. an extra YouTube call between `bind`
and `ingestion`):

1. Add the step's `id` to the `LaunchStepId` union in
   [`src/types/launch.ts`](../src/types/launch.ts).
2. Add the row to `LAUNCH_STEPS` in `launchService.ts` at the correct
   position.
3. Add the `await run('your-step', () => yourWork())` call in
   `_runLaunchSequence` in the correct position.
4. If the step produces an orphanable resource, capture it in the outer
   scope (`let myThing: … | null = null`) and add a cleanup branch in
   the catch block.
5. If the step needs special UI text, emit `step:detail` events from
   inside the work function.
6. The ring auto-scales (`pct = done / total`), so no UI adjustment
   needed.
7. Update this document.
