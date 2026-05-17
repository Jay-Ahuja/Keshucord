# Electron IPC Architecture

> Complete reference for the IPC channel system. Read
> [`architecture.md`](./architecture.md) §3 for the process-boundary
> overview first.

## 1. Layer stack

```
Renderer (React, sandboxed Chromium)
  │
  │  window.keshucord.{auth,youtube,settings}.*()
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

**Total: 14 channels.** 3 auth + 3 settings + 8 YouTube.

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
| `youtube` | `create-broadcast`, `create-stream`, `bind`, `get-ingestion`, `get-stream-status`, `transition-live`, `delete-broadcast`, `delete-stream` |

When adding a new channel:
1. Add `ipcMain.handle('<ns>:<verb>', …)` in `electron/ipc.ts`.
2. Add `ipcRenderer.invoke('<ns>:<verb>', …)` in `electron/preload.ts`
   under the appropriate namespace object.
3. Add the TypeScript signature to `KeshucordAPI` in `src/types/global.d.ts`.
4. Add or update the renderer-side facade in `src/services/`.

## 9. What is NOT over IPC

OBS WebSocket communication is **entirely renderer-side**. `obsService`
(`src/services/obsService.ts`) connects directly to `ws://localhost:4455`
using the browser's native `WebSocket`. No OBS calls touch the main
process. See [`obs-flow.md`](./obs-flow.md) for why.
