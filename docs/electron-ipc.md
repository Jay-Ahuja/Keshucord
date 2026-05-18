# Electron IPC Architecture

> Complete reference for the IPC channel system. Read
> [`architecture.md`](./architecture.md) §3 for the process-boundary
> overview first.

## 1. Layer stack

```
Renderer (React, sandboxed Chromium)
  │
  │  window.keshucord.{auth,youtube,settings,obs}.*()
  │  Typed as KeshucordAPI in src/types/global.d.ts
  │
  ▼
Preload script (electron/preload.ts)
  │
  │  contextBridge.exposeInMainWorld('keshucord', api)
  │  api.*() calls ipcRenderer.invoke('<channel>', ...args)
  │
  ▼
Main process (electron/ipc.ts)
  │
  │  ipcMain.handle('<channel>', handler)
  │
  ▼
Implementation modules
  electron/auth.ts          (auth channels)
  electron/settingsStore.ts (settings channels)
  electron/youtube.ts       (youtube channels)
  electron/obsProcess.ts    (obs channels — OS-process detection + spawn)
```

All IPC is **request/response** via `ipcMain.handle` + `ipcRenderer.invoke`.
There are no one-way channels (`ipcMain.on` / `ipcRenderer.send`). Every
call returns a `Promise`.

Sandboxing: `contextIsolation: true`, `nodeIntegration: false`, `sandbox:
true` in `electron/main.ts`. The renderer never accesses `ipcRenderer`
directly — only the `window.keshucord` object exposed by the preload.

## 2. Channel registry

### 2.1 Auth namespace

| Channel | Preload call | Main handler | Returns |
|---|---|---|---|
| `auth:sign-in` | `window.keshucord.auth.signIn()` | `auth.signIn()` | `AuthUserPayload` |
| `auth:sign-out` | `window.keshucord.auth.signOut()` | `auth.signOut()` | `void` |
| `auth:get-current-user` | `window.keshucord.auth.getCurrentUser()` | `auth.getCurrentUser()` | `AuthUserPayload \| null` |

### 2.2 Settings namespace

| Channel | Preload call | Main handler | Returns |
|---|---|---|---|
| `settings:load` | `window.keshucord.settings.load()` | `settingsStore.load()` | `PersistedSettingsPayload` |
| `settings:save` | `window.keshucord.settings.save(s)` | `settingsStore.save(s)` | `void` |
| `settings:reset` | `window.keshucord.settings.reset()` | `settingsStore.reset()` | `PersistedSettingsPayload` |

### 2.3 YouTube namespace

| Channel | Preload call | Main handler | Returns |
|---|---|---|---|
| `youtube:create-broadcast` | `window.keshucord.youtube.createBroadcast(input)` | `youtube.createBroadcast(input)` | `YouTubeBroadcastPayload` |
| `youtube:create-stream` | `window.keshucord.youtube.createLiveStream(input)` | `youtube.createLiveStream(input)` | `YouTubeLiveStreamPayload` |
| `youtube:bind` | `window.keshucord.youtube.bindBroadcastToStream(broadcastId, streamId)` | `youtube.bindBroadcastToStream(…)` | `{ broadcastId, streamId }` |
| `youtube:get-ingestion` | `window.keshucord.youtube.getStreamIngestionInfo(streamId)` | `youtube.getStreamIngestionInfo(streamId)` | `StreamIngestionInfoPayload` |
| `youtube:get-stream-status` | `window.keshucord.youtube.getStreamStatus(streamId)` | `youtube.getStreamStatus(streamId)` | `string` |
| `youtube:transition-live` | `window.keshucord.youtube.transitionToLive(broadcastId)` | `youtube.transitionToLive(broadcastId)` | `YouTubeBroadcastPayload` |
| `youtube:delete-broadcast` | `window.keshucord.youtube.deleteBroadcast(broadcastId)` | `youtube.deleteBroadcast(broadcastId)` | `void` |
| `youtube:delete-stream` | `window.keshucord.youtube.deleteLiveStream(streamId)` | `youtube.deleteLiveStream(streamId)` | `void` |
| `youtube:cancel` | `window.keshucord.youtube.cancel()` | `youtube.cancelAllInFlight()` | `void` |

`youtube:cancel` is the renderer-driven abort path. An `AbortSignal` cannot
cross the IPC boundary, so when the launch orchestrator aborts mid-flight
the renderer fires this channel to interrupt every in-flight YouTube fetch
on the main side.

### 2.4 OBS namespace

| Channel | Preload call | Main handler | Returns |
|---|---|---|---|
| `obs:is-running` | `window.keshucord.obs.isRunning()` | `obsProcess.isObsRunning()` | `boolean` |
| `obs:launch` | `window.keshucord.obs.launch()` | `obsProcess.launchObs()` | `{ ok: true } \| { ok: false, reason: string }` |

These two channels back the OBS pre-flight gate that runs **before**
`runLaunchSequence` is invoked (see `src/screens/CreateScreen.tsx` and
`src/components/ObsLaunchDialog.tsx`). They are deliberately distinct from
the renderer-side OBS WebSocket — see §9 below — and only deal with the OS
process: is the `obs64.exe` / `OBS` / `obs` process alive, and if not, can
we spawn it?

- `obs:is-running` shells out to `tasklist` (Windows), `pgrep -x OBS`
  (macOS), or `pgrep -x obs` (Linux). Detection is bounded by a 2-second
  hard timeout; any error or timeout is treated as "not running" because
  the safe fall-through is a follow-up `obs:launch` call.
- `obs:launch` spawns OBS detached + `unref`-ed so quitting Keshucord does
  not also kill OBS. On Windows it resolves the install path via
  `HKLM\SOFTWARE\OBS Studio` with a `C:\Program Files\obs-studio` fallback
  and sets `cwd` to `bin/64bit/` (OBS crashes silently otherwise). On
  macOS it delegates to `open -a OBS`. On Linux it assumes `obs` is on
  `PATH`. The renderer must NOT use this to decide that OBS is ready —
  spawn returns as soon as the OS hand-off succeeds; reachability is
  the renderer's responsibility (see `obsService.launchAndWait`).

**Total: 17 channels.** 3 auth + 3 settings + 9 YouTube + 2 OBS.

## 3. Payload types

All payload interfaces live in `electron/preload.ts` (preload-side) and
are mirrored as domain types in `src/types/` (renderer-side). The preload
owns the serialization contract; the renderer types own the domain model.

### Auth

```ts
// electron/preload.ts
interface AuthUserPayload {
  id: string;
  name: string;
  email: string;
  channel: string;
  avatarUrl?: string;
  channelId?: string;
  channelThumbnailUrl?: string;
}

// src/types/youtube.ts  (renderer domain type)
interface YouTubeUser {
  id: string;
  name: string;
  email: string;
  channel: string;
  avatarUrl?: string;
  avatarColor?: string;   // client-side hash — not from the IPC payload
  channelId?: string;
  channelThumbnailUrl?: string;
}
```

`avatarColor` is added client-side by `youtubeService.decorate()`. It is
not part of the IPC payload.

### YouTube broadcast

```ts
// electron/preload.ts
interface YouTubeBroadcastPayload {
  id: string;
  title: string;
  description: string;
  privacy: 'public' | 'unlisted' | 'private';
  category: string;
  status: string;
  watchUrl: string;
  scheduledStartTime: string;
  boundStreamId?: string;
}
```

### Stream ingestion

```ts
// electron/preload.ts
interface StreamIngestionInfoPayload {
  streamId: string;
  streamKey: string;
  rtmpUrl: string;
  backupRtmpUrl?: string;
}
```

### OBS launch result

```ts
// electron/preload.ts
type ObsLaunchResultPayload =
  | { ok: true }
  | { ok: false; reason: string };
```

Returned by `obs:launch`. On success the renderer knows the spawn was
handed off to the OS — it must still poll `obs:is-running` (or, in
practice, the OBS WebSocket port via `obsService.probe()`) to confirm
reachability before treating OBS as ready. On failure the `reason` is a
user-displayable string suitable for rendering directly in the
launch-OBS dialog (e.g. "OBS Studio is not installed at the expected
location"). No further mapping is needed.

### Settings

```ts
// electron/preload.ts
interface PersistedSettingsPayload {
  obsPassword: string;
  defaultTitle: string;
  defaultDescription: string;
  defaultPrivacy: 'public' | 'unlisted' | 'private';
  defaultCategory: string;
  appearanceAccent: 'purple' | 'cobalt' | 'ember' | 'mono';
  appearanceDensity: 'comfortable' | 'compact';
  appearanceReduceMotion: boolean;
  sidebarCompact: boolean;
}
```

When adding a new settings field: update `PersistedSettingsPayload` in
`preload.ts` **and** `UserSettings` in `src/types/settings.ts` **and**
`PersistedSettings` in `electron/settingsStore.ts` **and** the two
`DEFAULT_*` constants. See [`settings-system.md`](./settings-system.md) §8.

## 4. Renderer-side facades

The renderer never calls `window.keshucord.*` directly. It calls
service-layer facades that wrap the bridge:

| Facade | File | Wraps |
|---|---|---|
| `youtubeService` | `src/services/youtubeService.ts` | `window.keshucord.auth` + `window.keshucord.youtube` |
| `settingsService` | `src/services/settingsService.ts` | `window.keshucord.settings` |

`SettingsProvider` (`src/utils/settingsContext.tsx`) is the only code that
calls `settingsService`. All other renderer code gets settings through
`useSettings()`.

`youtubeService` is called by `launchService` (during launch steps 2–6 +
10) and directly by screens (sign-in, sign-out, test connection).

## 5. Security model

```
┌─ Main process ────────────────────────────────────────────────────┐
│  OAuth access tokens — NEVER cross the bridge                     │
│  OAuth refresh tokens — NEVER cross the bridge                    │
│  .env secrets (CLIENT_ID, CLIENT_SECRET) — never in renderer      │
└───────────────────────────────────────────────────────────────────┘
          │
          │ Only these cross the bridge:
          │   - YouTubeUser (profile info, no tokens)
          │   - YouTubeBroadcast (metadata, watch URL)
          │   - StreamIngestionInfo (RTMP URL + stream key)
          │   - PersistedSettings (includes obsPassword — a known tradeoff)
          │
┌─ Renderer (sandboxed) ────────────────────────────────────────────┐
│  OBS password lives here at runtime (needed for WebSocket auth)   │
│  Stream key lives here at runtime (needed to show to user)        │
│  No Node access, no raw ipcRenderer access                        │
└───────────────────────────────────────────────────────────────────┘
```

The OBS password arriving in the renderer is a known tradeoff — the OBS
WebSocket library needs it for the challenge/response handshake and lives
in the renderer. The password is never logged by `obsService`.

Stream keys arrive in the renderer because the UI needs to display them
(with masking) in `IngestionInfoCard`. They're masked in all console logs.

## 6. Error propagation

Errors thrown inside `ipcMain.handle` handlers propagate as rejected
Promises to the caller's `ipcRenderer.invoke`. Electron serializes the
error message (not the full Error object — only `.message` survives).

The renderer-side facades receive a string-messaged `Error` from IPC.
They re-throw it. The launch orchestrator or screen catches and surfaces
it as a red banner.

**Known gap**: if a main-process handler throws an `Error` with a non-string
or non-serializable `message`, the renderer gets a generic `"An error
occurred in the main process"` message. The current handlers all throw
plain `Error` instances with string messages, so this doesn't bite in
practice.

## 7. Registration order

`registerIpcHandlers()` is called once, before `createWindow()`, inside
`app.whenReady()`. All handlers are registered before the renderer's
first script execution. There is no lazy registration.

```ts
// electron/main.ts
app.whenReady().then(() => {
  registerIpcHandlers();   // ← must come first
  createWindow();
  …
});
```

## 8. Naming convention

```
<namespace>:<verb>[-<noun>]
```

| Namespace | Verbs used |
|---|---|
| `auth` | `sign-in`, `sign-out`, `get-current-user` |
| `settings` | `load`, `save`, `reset` |
| `youtube` | `create-broadcast`, `create-stream`, `bind`, `get-ingestion`, `get-stream-status`, `transition-live`, `delete-broadcast`, `delete-stream`, `cancel` |
| `obs` | `is-running`, `launch` |

When adding a new channel:
1. Add `ipcMain.handle('<ns>:<verb>', …)` in `electron/ipc.ts`.
2. Add `ipcRenderer.invoke('<ns>:<verb>', …)` in `electron/preload.ts`
   under the appropriate namespace object.
3. Add the TypeScript signature to `KeshucordAPI` in `src/types/global.d.ts`.
4. Add or update the renderer-side facade in `src/services/`.

## 9. What is NOT over IPC

OBS **WebSocket** communication is entirely renderer-side. `obsService`
(`src/services/obsService.ts`) connects directly to `ws://localhost:4455`
using the browser's native `WebSocket`. No OBS WebSocket calls touch the
main process. See [`obs-flow.md`](./obs-flow.md) for why.

The `obs:is-running` / `obs:launch` IPC channels added in 0.2.0 are NOT a
deviation from this rule — they deal with the OS-level OBS *process* (is
the executable running? can we spawn it?), which inherently requires
Node's `child_process` and a Windows registry read, both main-process-only
capabilities. The renderer's WebSocket layer is unchanged.
