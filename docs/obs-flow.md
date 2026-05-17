# OBS WebSocket Integration

> All OBS code lives in [`src/services/obsService.ts`](../src/services/obsService.ts) — the renderer process. See `architecture.md` §5 for why.

## 1. Architecture

A **single module-scoped `OBSWebSocket` instance** owns the connection. All
state — connection status, latest health snapshot, bitrate ring buffer — is
held in module-level `let`s and exposed via subscribe-pattern functions.

```
┌─────────────────────────────────────────────────────────────────────┐
│ obsService module                                                   │
│                                                                     │
│  const obs = new OBSWebSocket()           // single instance        │
│                                                                     │
│  let status: OBSConnectionStatus = …                                │
│  let lastHealth: StreamHealth | null = null                         │
│  let bitrateHistory: number[] = []                                  │
│  let healthPollTimer: Interval | null = null                        │
│  let prevBytes, prevTimestampMs   // for bitrate Δ                  │
│                                                                     │
│  const listeners               = new Set<StatusListener>()          │
│  const healthListeners         = new Set<HealthListener>()          │
│  const bitrateHistoryListeners = new Set<BitrateHistoryListener>()  │
│                                                                     │
│  obs.on('ConnectionClosed', …)                                      │
│  obs.on('StreamStateChanged', …)                                    │
│  obs.on('CurrentProgramSceneChanged', …)                            │
└─────────────────────────────────────────────────────────────────────┘
                          │
                          ▼ subscribe(...) → () => unsubscribe
            ┌────────────────────────────┐
            │ Renderer hooks             │
            │  - useObsStatus()          │
            │  - useStreamHealth()       │
            │  - useBitrateHistory()     │
            └────────────────────────────┘
                          │
                          ▼
                React components (DashScreen, Sidebar,
                LaunchStatusScreen, CreateScreen pre-flight, …)
```

Why renderer rather than main:

- `obs-websocket-js` v5 is browser-compatible (uses native `WebSocket`).
- The connection is pure loopback (`ws://localhost:4455`) — nothing crosses
  the public network.
- Routing every OBS call through IPC would add latency, double the
  serialization surface, and require event-forwarding plumbing for the
  three OBS events we subscribe to.

Tradeoff: anyone with code execution in the renderer could call OBS. We
accept this — the renderer is sandboxed (`sandbox: true`, `contextIsolation:
true`, `nodeIntegration: false`) and we control all renderer code. There's
no untrusted content boundary.

## 2. Connection lifecycle

States are enumerated in `src/types/obs.ts`:

```ts
type OBSConnectionState =
  | 'disconnected' | 'connecting' | 'connected' | 'streaming' | 'error';
```

```
disconnected  ──[connect()]──►  connecting  ──[handshake OK]──►  connected
     ▲                              │                                 │
     │                              │                                 │ [StartStream]
     │                       [handshake fail]                         ▼
     │                              │                            streaming
     │                              ▼                                 │
     └──────────────────────────  error                               │
              ▲                     ▲                                 │ [StopStream]
              │                     │ [ConnectionClosed event,        │
              │                     │  while connected/streaming]     │
              │                     │                                 │
              └─────────────────────┴─────────────────────────────────┘
                                    [disconnect()]
```

`setStatus(next)` is the single canonical writer. It:

1. Updates module-level `status`.
2. Notifies every status listener.
3. **Drives the health poller**: on a `streaming` ↔ non-`streaming` edge
   it starts or stops the 1.5 s poll loop. This is the single funnel for
   poller lifetime — there is no other code path that starts/stops it.

## 3. Authentication

Single field: `obsPassword` from `UserSettings`. Set in OBS Studio → Tools →
WebSocket Server Settings → Show Connect Info, then pasted into the app's
Settings → Connections tab.

The password is stored at rest in `settings.enc` (encrypted via Electron's
`safeStorage`). The renderer reads it through `useSettings()` and passes
it directly to `obs.connect()` from `obs-websocket-js`, which implements
OBS's challenge/response handshake.

If the password is wrong, `obs-websocket-js` throws with error code 4009,
which our `explainObsError` maps to "OBS rejected the password. Open OBS →
Tools → WebSocket Server Settings → Show Connect Info to copy the correct
password."

If OBS isn't running at all, the WebSocket fails to connect; the error
gets mapped to "Could not reach OBS at ws://localhost:4455. Make sure OBS
Studio is open and that Tools → WebSocket Server Settings has the server
enabled on port 4455."

## 4. Stream configuration flow

This is the part of the integration most prone to bugs — see [the historical
bug](#10-historical-bug-stream-key-mismatch) at the bottom for context. The
current flow has three layers of guard:

### Step 8 — `configureStreamService({ rtmpUrl, streamKey })`

Called by `launchService.ts` after `getStreamIngestionInfo` returns. The
function:

1. **Pre-check**: refuses unless `status.state === 'connected'`. Throws
   if streaming (refusing to change service mid-stream).
2. **Inspect current state**: reads `GetStreamServiceSettings` and logs
   it. Detects YouTube-managed mode (`rtmp_common` with a service name
   containing "youtube") and warns in the log — this is the canonical
   reason `SetStreamServiceSettings` will fail to take effect.
3. **Apply**: `obs.call('SetStreamServiceSettings', { streamServiceType:
   'rtmp_custom', streamServiceSettings: { server, key, use_auth: false }
   })`.
4. **Poll-verify**: reads `GetStreamServiceSettings` in a 200 ms loop for
   up to 3 seconds, comparing `streamServiceType`, `server`, and `key`
   against what we sent. The OBS frontend persists service config
   asynchronously after `SetStreamServiceSettings` returns — verifying in
   a tight loop catches this without an arbitrary sleep.
5. **On mismatch**, throws with the specific drift named and the
   YouTube-managed-mode fix as the most-likely cause.

### Step 9 — `assertActiveStreamServiceSettings({ rtmpUrl, streamKey })`

Called by `launchService.ts` immediately before `StartStream`. Single,
immutable read of `GetStreamServiceSettings` + match check. No polling.
If anything has drifted between configure-verify (a few seconds ago) and
now, this catches it before any video is pushed.

The two-stage approach (poll-verify after write + single check before
StartStream) is intentional defense in depth. The first catches OBS's
async persistence; the second catches asynchronous mutations from
account-linked YouTube integration.

### Step 9 — `startStreaming()`

After `assertActiveStreamServiceSettings` returns, `launchService` calls
`obs.startStreaming()`. This:

1. Calls `obs.call('StartStream')`.
2. **Verifies it actually started**: polls `GetStreamStatus.outputActive`
   for up to 5 seconds in 250 ms ticks. `StartStream` can succeed at the
   protocol level while OBS displays a modal that blocks the stream from
   actually starting — the canonical example is
   `"You must select a broadcast first."` shown when OBS has a YouTube
   account connected via Settings → Stream → Connect Account.
3. **On `outputActive` never flipping true**, throws with a message that
   names the popup verbatim and points to the disconnect-account fix.

## 5. Stream start / stop lifecycle

```
configureStreamService(ingestion)      ◄── only called by launchService
   │
   ▼ poll-verify passes
assertActiveStreamServiceSettings(ingestion)  ◄── only called by launchService
   │
   ▼ single check passes
startStreaming()
   │
   ├─ obs.call('StartStream')           // returns immediately
   │
   └─ poll GetStreamStatus.outputActive for up to 5 s
        │
        ├─ outputActive === true
        │   ├─ setStatus({ state: 'streaming', … })
        │   │   └─ side effect: startHealthPolling()
        │   └─ return new status
        │
        └─ deadline hit
            └─ throw "OBS accepted StartStream but is not actually streaming. …"

stopStreaming()                          ◄── called by:
   │                                          - DashScreen "End stream" button
   ├─ obs.call('StopStream')                  - SettingsScreen Connections (not currently)
   │                                          - end-of-app cleanup (implicit via disconnect)
   ├─ setStatus({ state: 'connected', … })
   │   └─ side effect: stopHealthPolling()
   │       └─ notifyHealth(null) + notifyBitrateHistory()
   └─ return new status
```

There is no programmatic launch of the OBS process. `obsService.launchObs()`
exists but is a 200 ms `sleep` stub — the launch flow does not call it.
If OBS isn't running, the `connect-obs` step fails with a clear error.

## 6. Health metrics

`pollHealth()` runs every 1.5 seconds (`HEALTH_POLL_MS`) while
`status.state === 'streaming'`. Each tick fires both calls in parallel:

```ts
const [streamStatus, stats] = await Promise.all([
  obs.call('GetStreamStatus'),
  obs.call('GetStats'),
]);
```

`StreamHealth` snapshot composition:

| Field | Source | Notes |
|---|---|---|
| `bitrateKbps` | `(outputBytes - prevBytes) × 8 / 1000 / Δt seconds` | `null` on the very first sample (no prior reading). |
| `fps` | `stats.activeFps` | OBS render FPS, not encode FPS. |
| `droppedFrames` | `streamStatus.outputSkippedFrames` | Count since stream started. |
| `droppedFramePercent` | `droppedFrames / outputTotalFrames × 100` | 0 when totalFrames is 0. |
| `congestion` | `streamStatus.outputCongestion` | 0–1 float. Used as a proxy for "latency" since OBS doesn't expose end-to-end RTT. |
| `renderTimeMs` | `stats.averageFrameRenderTime` | OBS render-pipeline latency. |
| `outputDurationMs` | `streamStatus.outputDuration` | Ticks while streaming; used by Title-bar + Launch + Dash duration chips. |
| `totalFrames` | `streamStatus.outputTotalFrames` | |
| `timestamp` | `Date.now()` at sample time | For caller debugging. |

After updating `lastHealth` + notifying health listeners, the poller also
pushes the new bitrate (if non-null) into the **bitrate ring buffer**:

```ts
bitrateHistory = [...bitrateHistory, bitrateKbps].slice(-BITRATE_HISTORY_MAX);  // 64 samples
notifyBitrateHistory();
```

DashScreen's bar chart consumes the buffer through `useBitrateHistory()`,
auto-scaling bars against `max(history)` so the chart auto-zooms.

### Polling lifecycle

```
state becomes 'streaming'
       │
       ▼
startHealthPolling()
       │
       ├─ reset prevBytes / prevTimestampMs / lastHealth / bitrateHistory
       ├─ pollHealth()                 ◄── immediate first sample
       └─ healthPollTimer = setInterval(pollHealth, 1500)


state leaves 'streaming'    (StreamStateChanged false, ConnectionClosed,
       │                     stopStreaming(), or any disconnect path)
       ▼
stopHealthPolling()
       │
       ├─ clearInterval(healthPollTimer)
       ├─ reset prevBytes / prevTimestampMs / lastHealth / bitrateHistory
       └─ notifyHealth(null) + notifyBitrateHistory()
            └─ subscribers get null / empty array → UI flips to idle state
```

There is exactly **one** canonical place that starts the poller and **one**
that stops it. Both are called only from `setStatus()`. This is intentional
— no other code path can leave the timer running.

## 7. Event handling

Three OBS WebSocket events are subscribed to during module load:

| Event | Effect |
|---|---|
| `ConnectionClosed` | If current state is neither `disconnected` nor `error`, `setStatus({ state: 'disconnected' })`. This handles OBS quitting, network blips, manual `disconnect()` (which already calls setStatus first), or any TCP-level drop. |
| `StreamStateChanged` | Flips state between `connected` ↔ `streaming` based on `outputActive`. This is how the UI reflects a user manually starting/stopping the stream from inside OBS, without going through our buttons. |
| `CurrentProgramSceneChanged` | Updates `status.currentScene` if we're already `connected`/`streaming`. Used by Sidebar's status footer + CreateScreen pre-flight + DashScreen preview-overlay subtitle. |

The handlers are registered at module import time, never re-bound, never
unregistered (the `obs` instance is module-scoped — it has the same
lifetime as the renderer process).

## 8. Retry / reconnect behavior

### Connect retry

`connect(password, opts)` accepts `{ attempts: number; retryDelayMs: number
}`. The launch flow calls it with `{ attempts: 3, retryDelayMs: 1500 }` —
total ~3 seconds of headroom, which is enough for an OBS Studio that's
still finishing its startup handshake.

The manual `testConnection` path (Settings → Test connection button) calls
`connect()` with no options → single attempt, fail fast.

### No auto-reconnect

If OBS disconnects mid-stream (`ConnectionClosed`), state flips to
`disconnected` and the health poller stops. We do **not** auto-reconnect.
The user has to fix OBS and re-run the launch.

Reasoning: a silent reconnect after the user's stream has been interrupted
is misleading. They need to know.

## 9. Important WebSocket APIs / events

### Requests (`obs.call(...)`)

| Request | Where | Purpose |
|---|---|---|
| `GetCurrentProgramScene` | `connect()` | Initial scene name for status. |
| `GetStreamStatus` | `connect()`, `pollHealth`, `startStreaming()` post-verify | Active scene + bytes + frames + congestion. |
| `GetStreamServiceSettings` | `configureStreamService` (before + poll-verify), `assertActiveStreamServiceSettings` | Read current service config. |
| `SetStreamServiceSettings` | `configureStreamService` | Write new service config. |
| `GetStats` | `pollHealth` | activeFps, averageFrameRenderTime. |
| `StartStream` | `startStreaming` | Begin RTMP push. |
| `StopStream` | `stopStreaming` | End RTMP push. |

### Subscriptions (`obs.on(...)`)

| Event | Purpose |
|---|---|
| `ConnectionClosed` | Detect disconnect. |
| `StreamStateChanged` | Track external start/stop. |
| `CurrentProgramSceneChanged` | Keep `status.currentScene` fresh. |

Other events the library exposes (`InputCreated`, `SceneItemEnableStateChanged`, etc.) are not subscribed to — we don't need that level of detail today.

## 10. Common failure cases

### Wrong password (code 4009)

`obs-websocket-js` rejects with error.code === 4009. `explainObsError`
maps it to "OBS rejected the password. Open OBS → Tools → WebSocket Server
Settings → Show Connect Info to copy the correct password."

### OBS not running (connection refused / 1006)

`obs-websocket-js` rejects with a WebSocket-level connection error.
`explainObsError` checks `lowered.includes('econnrefused' | 'connection
refused' | 'failed to connect' | …)` and maps to "Could not reach OBS at
ws://localhost:4455. Make sure OBS Studio is open and that Tools →
WebSocket Server Settings has the server enabled on port 4455."

### YouTube account linked in OBS — the silent stream-key override

**This is the canonical reason the launch fails with "you must select a
broadcast first" or the stream goes to the wrong destination.**

When OBS Studio has Settings → Stream → Connect Account linked to YouTube,
the account integration runs an extra workflow in front of `StartStream`:
it requires the user to pick a broadcast from the linked account's
dropdown before any RTMP push begins. `SetStreamServiceSettings` cannot
override this — OBS's account session is sticky and wins.

The defenses we layer against this:

1. `configureStreamService` reads `GetStreamServiceSettings` **before**
   writing and logs a warning if it sees the YouTube-managed
   configuration.
2. The post-write poll-verify catches drift if OBS quietly reverts our
   `rtmp_custom` switch.
3. `assertActiveStreamServiceSettings` catches drift just before
   `StartStream`.
4. `startStreaming`'s post-`StartStream` `outputActive` poll catches the
   case where OBS quietly *doesn't* start because of the modal.

All four throw with messages that name the disconnect-account fix.

### Already streaming when launch begins

`connect()` checks `if (status.state === 'streaming')` and throws "Stop
the stream before reconnecting to OBS." This prevents a launch from
silently rebinding OBS to a new key while OBS is already pushing to a
different destination.

### Concurrent launches (StrictMode dev, fast user clicks)

Module-level mutex in `launchService.ts` serializes these. The previous
launch's `runLaunchSequence` is aborted; the new call awaits its full
cleanup (including `youtube.deleteBroadcast/deleteLiveStream` of
orphaned resources) before starting. See [`architecture.md`](./architecture.md#9-stream-launch-flow).

### Stream goes "inactive" mid-launch (network blip)

`waitForStreamActive` (in `youtubeService.ts`) is the polling helper for
the `go-live` step. It checks YouTube's view of stream status, not OBS's.
If YouTube reports `error` it throws immediately; if it never reports
`active` within 90 s it throws a timeout error.

## 11. Debugging / logging strategy

All OBS calls log to the console via:

```ts
function log(...args: unknown[]) {
  console.info('[obs]', ...args);
}
```

Stream keys are masked in logs (length + last 4 chars). RTMP URLs are
shown in full.

Useful log breadcrumbs to look for when diagnosing:

```
[obs] starting stream health polling
[obs] StreamStateChanged outputActive= true
[obs] current stream service before change: { … }
[obs] setting service to rtmp_custom (server="rtmps://…", key="<redacted>")
[obs] stream service settings verified
[obs] asserting OBS stream service matches expected ingestion
[obs] pre-StartStream OBS state: { type: 'rtmp_custom', server: '…', keyTail: '…', keyLen: 28, expectedServer: '…', expectedKeyTail: '…', expectedKeyLen: 28 }
[obs] pre-StartStream check passed — OBS is configured for our broadcast
[obs] calling StartStream
[obs] stream is active
[obs] stopping stream health polling
[obs] connection closed
```

If the launch is failing, the first thing to check is whether the
`pre-StartStream OBS state` log line shows `keyTail` matching
`expectedKeyTail`. If not, the YouTube-managed override is the most
likely cause.

## 12. Constraints / assumptions

- **Loopback only.** `OBS_URL = 'ws://localhost:4455'` is a `const`. Custom
  hosts aren't supported; the Settings UI shows the values as disabled.
- **Single OBS instance.** No support for connecting to multiple OBS
  hosts. The module's WebSocket is a single, eager instance.
- **OBS WebSocket Server enabled.** This is OBS's default in v28+, but
  users with older OBS need to enable it manually. No detection — we
  fail at connect with the relevant error.
- **`rtmp_custom` only.** We never use `rtmp_common`. Even though the
  YouTube ingest URL we get back is well-known (`rtmps://a.rtmps.youtube.com/live2`), we always set it explicitly as `rtmp_custom` so OBS's
  built-in YouTube preset can't take over.
- **Bitrate buffer in-memory only.** Cleared on stream stop. Does not
  survive `App` restarts. The Dash chart label says "last N samples",
  not a misleading time window.
