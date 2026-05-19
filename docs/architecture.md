# Architecture

> Living document. When you change the shape of a subsystem in code, change
> this file in the same commit.

## 1. App overview

Keshucord is a Windows-first Electron desktop application that automates the
"go live on YouTube via OBS" workflow. The user signs into YouTube (OAuth), fills
out a stream form, clicks **Go Live**, and the app:

1. Provisions a real YouTube broadcast + live stream pair via the YouTube
   Data API v3.
2. Configures OBS Studio's stream service over OBS WebSocket so OBS knows
   exactly where to push video.
3. Starts OBS streaming.
4. Waits for YouTube to confirm the stream is receiving video and transitions
   the broadcast to **live**.

A separate Stream Health screen surfaces live OBS telemetry while broadcasting.
A Settings screen persists per-user preferences locally and encrypted.

The design system, brand, and visual language are referred to as "Keshucord"
throughout — see [`src/styles/keshucord.css`](../src/styles/keshucord.css).

## 2. Technology stack

| Layer | Choice | Why |
|---|---|---|
| Desktop shell | Electron 34 | Cross-platform shell; needed for OS-level integrations (file system, network, OS keychain). |
| UI framework | React 18 + TypeScript 5 | Standard for typed component-driven UIs. |
| Bundler | Vite 5 | Fast dev server, simple Electron-renderer config. |
| Styling | Hand-written CSS design system (`keshucord.css`) + Tailwind preflight | The design ships as a CSS file with oklch tokens. Tailwind is loaded for preflight + a couple of utility classes used by the bootstrap spinner. Component classes are written as plain CSS, not Tailwind utilities. |
| OBS integration | `obs-websocket-js` v5 | Talks to OBS Studio's built-in WebSocket Server (port 4455). |
| YouTube integration | `fetch` against `https://www.googleapis.com/youtube/v3` | Native fetch is enough; the official `googleapis` package is ~60 MB and overkill. |
| OAuth | Custom loopback + PKCE in the main process | OAuth 2.0 for Installed Apps. No client_secret in renderer code. |
| Secrets at rest | Electron `safeStorage` | OS keychain (DPAPI on Windows, Keychain on macOS, libsecret on Linux). |
| Env loading | `dotenv` | `.env` read on main-process boot. |
| Fonts | Geist + Geist Mono (Google Fonts) | Matches the design's `--font-sans` / `--font-mono` tokens. |

No state-management library (Redux, Zustand, etc.) is used. State is lifted to
`App.tsx`, or held in a React Context (`SettingsProvider`), or module-scoped
inside a service.

No router (React Router etc.) is used. Navigation is a string-typed `Screen`
union in App state plus a sidebar component that calls `setScreen`.

## 3. Electron process architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Main process            (Node.js, full OS access, has secrets)      │
│  - Electron app lifecycle (electron/main.ts)                         │
│  - Loads .env at boot (dotenv/config)                                │
│  - safeStorage-encrypted persistence                                 │
│    · electron/tokenStore.ts  (OAuth tokens → tokens.enc)             │
│    · electron/settingsStore.ts (user settings → settings.enc)        │
│  - OAuth loopback + PKCE flow      (electron/auth.ts)                │
│  - YouTube Data API client         (electron/youtube.ts)             │
│  - OBS OS-process detection + spawn (electron/obsProcess.ts)         │
│  - IPC handler registration        (electron/ipc.ts)                 │
└──────────────────────────────────────────────────────────────────────┘
                ▲
                │ IPC channels (ipcMain.handle / ipcRenderer.invoke)
                │   auth:sign-in / auth:sign-out / auth:get-current-user
                │   settings:load / settings:save / settings:reset
                │   youtube:create-broadcast / :create-stream / :bind / …
                │   youtube:cancel
                │   obs:is-running / obs:launch
                │
┌──────────────────────────────────────────────────────────────────────┐
│  Preload script          (Bridge, sandboxed)                         │
│  - electron/preload.ts                                               │
│  - Exposes `window.keshucord.{auth, youtube, settings, obs}` via     │
│    contextBridge.exposeInMainWorld()                                 │
│  - Renderer never sees ipcRenderer directly                          │
└──────────────────────────────────────────────────────────────────────┘
                ▲
                │ window.keshucord.* (typed in src/types/global.d.ts)
                │
┌──────────────────────────────────────────────────────────────────────┐
│  Renderer process        (Chromium, sandboxed, no Node)              │
│  - React app rooted at src/main.tsx → src/App.tsx                    │
│  - Services that wrap the bridge:                                    │
│    · src/services/youtubeService.ts  → window.keshucord.youtube      │
│    · src/services/settingsService.ts → window.keshucord.settings     │
│  - OBS WebSocket runs HERE (browser WebSocket → ws://127.0.0.1:4455) │
│    · src/services/obsService.ts                                      │
│  - Orchestrator that composes them:                                  │
│    · src/services/launchService.ts                                   │
└──────────────────────────────────────────────────────────────────────┘
```

Key security boundaries:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` in
  `electron/main.ts`. The renderer cannot `require()` Node modules.
- OAuth tokens never leave the main process. The renderer only receives a
  `YouTubeUser` (`{ id, name, email, channel, avatarUrl, … }`).
- The OBS WebSocket runs in the renderer because (a) `obs-websocket-js` is a
  browser-compatible library, (b) it's a pure local loopback connection, (c)
  the data isn't sensitive at the same level as OAuth tokens.
- A strict CSP `<meta>` in `index.html` is the renderer's last line of defense
  against XSS / credential exfil. `script-src 'self'` (no inline, no eval),
  `connect-src` is narrowed to `'self'` + the OBS WebSocket (`ws://localhost:4455`)
  + Vite HMR (dev-only `ws://localhost:5173`), and Google API origins are
  deliberately **absent** because all YouTube/OAuth fetches go through main
  via Node `fetch`, never the renderer. `frame-src` allows
  `youtube-nocookie.com` + `youtube.com` for DashScreen's live preview iframe;
  `frame-ancestors` is intentionally omitted because the directive is ignored
  when delivered via `<meta>` (Chromium warns about it) and is moot for
  Electron — the renderer is always loaded directly into a BrowserWindow,
  never as an iframe in another origin.

## 4. Folder structure

```
Keshucord/
├── electron/                      Main process + preload
│   ├── main.ts                    BrowserWindow + app lifecycle
│   ├── preload.ts                 contextBridge → window.keshucord
│   ├── ipc.ts                     ipcMain.handle wiring
│   ├── auth.ts                    PKCE + loopback OAuth, token refresh
│   ├── tokenStore.ts              tokens.enc read/write/clear
│   ├── settingsStore.ts           settings.enc read/write/reset
│   ├── obsProcess.ts              OS-process detection + spawn for the OBS pre-flight gate
│   └── youtube.ts                 fetch-based YouTube Data API client
├── src/
│   ├── App.tsx                    Top-level state machine + routing
│   ├── main.tsx                   React mount + SettingsProvider
│   ├── index.css                  Tailwind preflight + 4-line base
│   ├── styles/
│   │   └── keshucord.css          Full design system (oklch tokens + components)
│   ├── components/                Shared UI primitives
│   │   ├── Icons.tsx              All SVG icons in one file
│   │   ├── IngestionInfoCard.tsx  RTMP URL + stream-key reveal
│   │   ├── ObsLaunchDialog.tsx    Pre-flight launch-OBS modal (prompt/launching/error)
│   │   ├── PlaceholderScreen.tsx  "Coming soon" empty state
│   │   ├── Sidebar.tsx            Persistent left rail
│   │   ├── Spinner.tsx            Bootstrap loader (only Tailwind-classed component left)
│   │   └── TitleBar.tsx           36 px top bar
│   ├── screens/                   One file per route
│   │   ├── LoginScreen.tsx
│   │   ├── CreateScreen.tsx
│   │   ├── LaunchStatusScreen.tsx
│   │   ├── DashScreen.tsx
│   │   └── SettingsScreen.tsx
│   ├── services/                  Renderer-side service layer
│   │   ├── youtubeService.ts      Wraps window.keshucord.youtube
│   │   ├── settingsService.ts     Wraps window.keshucord.settings
│   │   ├── obsService.ts          Owns the OBS WebSocket
│   │   ├── launchService.ts       The 10-step orchestrator (the only file that calls every other service)
│   │   └── index.ts               Re-export barrel
│   ├── types/                     Pure type declarations
│   │   ├── app.ts                 Screen union
│   │   ├── stream.ts              StreamSettings + Privacy
│   │   ├── youtube.ts             YouTubeUser/Broadcast/LiveStream/Ingestion + inputs
│   │   ├── obs.ts                 OBSConnectionStatus + StreamHealth
│   │   ├── launch.ts              LaunchStep + LaunchStepId/Status
│   │   ├── settings.ts            UserSettings + appearance unions
│   │   ├── global.d.ts            Window augmentation
│   │   └── index.ts               Barrel
│   └── utils/                     Pure helpers + small hooks
│       ├── applyAccent.ts         Writes --acc-* CSS variables on :root
│       ├── format.ts              capitalize / initialsOf / formatDuration
│       ├── settingsContext.tsx    SettingsProvider + useSettings hook
│       ├── useObsStatus.ts        Subscribes to obsService status
│       ├── useStreamHealth.ts     Subscribes to obsService health
│       └── useBitrateHistory.ts   Subscribes to obsService bitrate ring buffer
├── docs/                          Engineering docs (this folder)
└── (root config: package.json, tsconfig.*.json, vite.config.ts, …)
```

Convention: one file per screen, one file per service, one file per logical
type domain. No deep nesting beyond two levels under `src/`.

## 5. Frontend / backend separation

There is no "backend" in the conventional sense — no server, no database.
"Backend" in this app means **the main process**.

| Concern | Lives where | Reason |
|---|---|---|
| OAuth flow | main | Needs `shell.openExternal`, loopback HTTP server, secret handling. |
| OAuth tokens at rest | main (`tokenStore.ts` → `tokens.enc`) | `safeStorage` is main-process-only. |
| YouTube Data API calls | main (`electron/youtube.ts`) | Token never crosses the bridge. |
| User settings persistence | main (`settingsStore.ts` → `settings.enc`) | Same `safeStorage` requirement. |
| OBS WebSocket | **renderer** (`obsService.ts`) | Pure WebSocket; browser-compatible. No reason to add an IPC hop. |
| OBS health polling, bitrate buffer | renderer (`obsService.ts` module scope) | Co-located with the WebSocket. |
| OBS OS-process detection + spawn | main (`electron/obsProcess.ts`) | Needs `child_process` (`tasklist` / `pgrep`, OBS spawn) + a Windows registry read. Distinct from the renderer-side WebSocket — this layer only answers "is the executable running?" and "can we launch it?". |
| Stream-launch orchestration | renderer (`launchService.ts`) | Combines YouTube IPC calls + OBS WebSocket calls + UI events. |
| Screen routing, form state, UI | renderer (`App.tsx` + screens) | Standard React. |

This split is unusual — OBS-side state lives in the renderer rather than being
proxied through main. The reasoning is documented in
[`obs-flow.md`](./obs-flow.md#1-architecture).

## 6. Major services / modules

| Service | File | Responsibility | Reachable from |
|---|---|---|---|
| `obsService` | `src/services/obsService.ts` | Owns the single `OBSWebSocket` instance, connection state, health poller, bitrate buffer, pre-StartStream assertion, and pub/sub for status/health/bitrate. | Renderer code only. |
| `youtubeService` | `src/services/youtubeService.ts` | Thin renderer-side facade over `window.keshucord.youtube`. Adds `decorate` (avatar color hash) and `waitForStreamActive` (renderer-side polling helper). | Renderer code only. |
| `settingsService` | `src/services/settingsService.ts` | Even thinner facade over `window.keshucord.settings`. | `SettingsProvider` only. |
| `launchService` | `src/services/launchService.ts` | The 10-step orchestrator. Module-level mutex serializes launches. Owns the `LaunchEvent` event protocol consumed by `LaunchStatusScreen`. | `LaunchStatusScreen`. |
| `auth` (main) | `electron/auth.ts` | OAuth loopback, PKCE, token exchange, silent refresh, sign-out + revoke. | IPC handlers in `electron/ipc.ts`. |
| `youtube` (main) | `electron/youtube.ts` | YouTube Data API v3 client. Adds identity assertions (bound stream id matches, returned stream id matches). | IPC handlers. |
| `settingsStore` (main) | `electron/settingsStore.ts` | `safeStorage`-encrypted JSON at `<userData>/settings.enc`. | IPC handlers. |
| `tokenStore` (main) | `electron/tokenStore.ts` | Same pattern as settingsStore, for `tokens.enc`. | `auth.ts` only. |

## 7. Application lifecycle

```
electron/main.ts
  ├─ import 'dotenv/config'                    (loads .env from CWD)
  ├─ app.whenReady()
  │    ├─ registerIpcHandlers()                (electron/ipc.ts)
  │    └─ createWindow()
  │         ├─ new BrowserWindow({ sandbox: true, contextIsolation: true })
  │         ├─ webPreferences.preload = dist-electron/preload.js
  │         └─ loadURL(dev) or loadFile(prod)
  └─ app.on('window-all-closed') → app.quit()  (except macOS)

src/main.tsx
  ├─ createRoot(#root).render(
  │    <StrictMode>
  │      <SettingsProvider>     ← starts loading settings.enc
  │        <App />              ← starts loading tokens.enc → user
  │      </SettingsProvider>
  │    </StrictMode>)

src/App.tsx (mount)
  ├─ useSettings().load           — settings.enc → DEFAULT_USER_SETTINGS merge
  ├─ youtubeService.getCurrentUser() — tokens.enc → YouTubeUser | null
  ├─ Bootstrap spinner shown until BOTH resolve
  ├─ When both ready:
  │    ├─ if user: setScreen('create')  (seeded with user defaults)
  │    └─ else:    setScreen('login')   (full-bleed, no sidebar)
  └─ Render
```

## 8. State flow overview

```
┌───────────────────────────────────────────────────────────────────────┐
│ SettingsProvider (src/utils/settingsContext.tsx)                      │
│   useState<UserSettings>     ◄── settingsService.load() on mount     │
│   save: optimistic update → background disk write → rollback on fail │
└───────────────────┬───────────────────────────────────────────────────┘
                    │ useSettings() context
                    ▼
┌───────────────────────────────────────────────────────────────────────┐
│ App.tsx                                                               │
│   useState<Screen>           — routing                                │
│   useState<YouTubeUser|null> — auth session                           │
│   useState<StreamSettings>   — controlled launch form (lifted)        │
│   useObsStatus()             — OBS connection state                   │
│   useStreamHealth()          — Latest health snapshot                 │
│                                                                       │
│   useEffect(() => applyAccent(userSettings.appearanceAccent))         │
│   useEffect(() => keyboard shortcuts)                                 │
└───────────────────┬───────────────────────────────────────────────────┘
                    │
                    ▼ props
┌───────────────────────────────────────────────────────────────────────┐
│ Screens                                                               │
│   - LoginScreen        : owns busy/error                              │
│   - CreateScreen       : controlled by App; owns mock UI state for    │
│                          preset/thumb/tags/schedule/advanced          │
│   - LaunchStatusScreen : owns statuses map, details, broadcast,       │
│                          ingestion, fatalError — driven by            │
│                          runLaunchSequence events                     │
│   - DashScreen         : zero local state aside from end-stream busy  │
│                          flag; everything from hooks                  │
│   - SettingsScreen     : owns tab, savedAt; pushes every change       │
│                          back through useSettings().save              │
└───────────────────────────────────────────────────────────────────────┘
```

Module-scope state (lives outside React, survives unmount/remount):

| Module | State | Used by hooks |
|---|---|---|
| `obsService` | `status`, `lastHealth`, `bitrateHistory`, listener `Set`s, poll timer | `useObsStatus`, `useStreamHealth`, `useBitrateHistory` |
| `launchService` | `activeLaunch` promise + `activeAbort` controller (the mutex) | None directly — the screen sees `LaunchEvent`s. |

## 9. Stream launch flow

`src/services/launchService.ts` exports two things:

- `LAUNCH_STEPS: readonly LaunchStep[]` — the canonical 10-step checklist data
  (used by `LaunchStatusScreen` to render the ring + checklist).
- `runLaunchSequence({ settings, onEvent, signal })` — the orchestrator.

The orchestrator is **wrapped in a module-level mutex**. At most one launch
runs at a time; a new call aborts the prior one and `await`s its full
settlement (including cleanup) before starting. This is the fix for the
stream-key race described in [`obs-flow.md`](./obs-flow.md) and
[`youtube-flow.md`](./youtube-flow.md).

**Pre-flight gate (added in 0.2.0).** Before `runLaunchSequence` is ever
invoked, `CreateScreen`'s Go Live handler runs a fast OBS reachability
probe via `obsService.probe()` (raw WebSocket open to `ws://localhost:4455`,
no Identify handshake, no module-state mutation). If OBS is reachable the
handoff to the orchestrator proceeds normally. If it isn't, the
`ObsLaunchDialog` opens and offers to spawn OBS via the `obs:launch` IPC
channel, then polls `probe()` until the port is up — at which point the
dialog calls back into CreateScreen, which then submits to the launch
flow. This pre-flight is **not** a new step in the 10-step sequence — the
orchestrator and its mutex are unchanged, the 10 steps still execute in
exactly the same order, and the existing step-1 password validation still
runs. The pre-flight only gates whether `runLaunchSequence` gets called
at all.

The 10 steps:

```
1. validate       — local check of StreamSettings (title/desc length, privacy, password)
2. auth           — youtube.getCurrentUser() must return a user
3. broadcast      — youtube.createBroadcast(settings) → real broadcast
4. stream         — youtube.createLiveStream(settings) → real live stream
5. bind           — youtube.bindBroadcastToStream(broadcastId, streamId)
                     · asserts boundStreamId matches what we sent
6. ingestion      — youtube.getStreamIngestionInfo(streamId)
                     · asserts item.id matches what we requested
                     · plus an extra ingestion.streamId === stream.id check
                       in the orchestrator
7. connect-obs    — obs.connect(password, { attempts: 3, retryDelayMs: 1500 })
8. configure-obs  — obs.configureStreamService({ rtmpUrl, streamKey })
                     · SetStreamServiceSettings to rtmp_custom
                     · poll-verifies via GetStreamServiceSettings for up to 3 s
9. start-stream   — obs.assertActiveStreamServiceSettings(...)    ← final pre-StartStream check
                     · obs.startStreaming()
                       · StartStream
                       · poll GetStreamStatus.outputActive for up to 5 s
10. go-live      — youtube.waitForStreamActive(streamId)
                     · polls every 2 s, 90 s timeout
                   youtube.transitionToLive(broadcast.id)
                     · POST /liveBroadcasts/transition?broadcastStatus=live
```

If any step throws, the orchestrator's `catch` block runs cleanup — `youtube.deleteBroadcast(id)` and/or `youtube.deleteLiveStream(id)` in
parallel via `Promise.allSettled`, then emits a `cleanup` event with the list
of deleted resources before re-throwing.

See [`youtube-flow.md`](./youtube-flow.md) and [`obs-flow.md`](./obs-flow.md)
for per-subsystem detail.

## 10. Key architectural decisions

### Decision: OBS WebSocket runs in the renderer, not main

OBS WebSocket is a browser-compatible library. Routing it through IPC would
add latency, double the surface area for serialization bugs, and require
forwarding every event back. The OBS service is module-scoped in
`src/services/obsService.ts`; its singleton state is preserved across screen
mounts via React subscribe-style hooks.

### Decision: YouTube API client lives in the main process

We never want OAuth access tokens in the renderer. All calls happen in
`electron/youtube.ts` behind IPC. The renderer only sees high-level results
(`YouTubeBroadcast`, `StreamIngestionInfo`, …).

### Decision: PKCE loopback OAuth in the main process

This is Google's recommended flow for installed apps. Implementation lives in
`electron/auth.ts` — it generates a code verifier, starts an HTTP server on a
random loopback port, opens the system browser via `shell.openExternal`, and
exchanges the resulting auth code for tokens. No client secret embedded in
the renderer.

### Decision: Encrypted-blob persistence (safeStorage)

Both `tokens.enc` and `settings.enc` are JSON blobs encrypted by Electron's
`safeStorage` (OS keychain on every platform we support). The load path
merges the parsed object with `DEFAULT_*` constants so adding new fields
doesn't break old payloads.

### Decision: Single-mount control of the launch flow + final assertion

The launch flow uses a module-level mutex (`activeLaunch` + `activeAbort`)
because React StrictMode double-mount and rapid user re-clicks were causing
two parallel `runLaunchSequence` calls to race over OBS state. The final
`obs.assertActiveStreamServiceSettings` immediately before `StartStream` is
defense-in-depth — see [`obs-flow.md`](./obs-flow.md).

### Decision: Design system is a plain CSS file, not Tailwind

The design ships as a 1274-line CSS file with oklch tokens and component
classes (`.btn`, `.card`, `.input`, `.checklist`, etc.). Trying to express
this as Tailwind config was producing drift; using it as plain CSS keeps
fidelity. Tailwind is still loaded for preflight + a handful of utility
classes (`flex`, `text-white/40`) on the bootstrap spinner — that's the only
remaining Tailwind consumer.

### Decision: No router, no state library

Three reasons:

1. The whole app is ~5 screens with linear-ish flow.
2. Lifting state to `App.tsx` + one context (settings) is enough.
3. Bringing in React Router or Redux would add 2× the integration surface
   for zero clarity gain.

If the app grows past ~10 screens or needs deep-linking, this decision should
be revisited.

### Decision: Optimistic settings save

`useSettings().save()` updates the in-memory state synchronously, then
awaits the disk write. On failure it re-loads from disk and re-throws. This
makes the sidebar-compact toggle and accent swatches feel instant.

## 11. Known technical debt / issues

| Item | Where | Notes |
|---|---|---|
| `userSettings.appearanceDensity`, `userSettings.appearanceReduceMotion` | `types/settings.ts` + Settings UI | Persisted and editable, but no CSS hooks consume them yet. |
| `YouTubeUser.avatarColor` + `youtubeService.decorate()` + the `AVATAR_PALETTE` constant | `types/youtube.ts`, `services/youtubeService.ts` | `decorate()` still hashes the user id to a CSS gradient string and attaches it as `avatarColor`, but the only consumer (`UserChip`) was deleted. The Sidebar's avatar uses a CSS `.avatar` gradient directly. Whole code path can be removed. |
| `applyAccent` writes are not persisted to `:root` early | `App.tsx` `useEffect` runs after first paint | The user might see a 1-frame flash of the default accent on first launch. Cosmetic. |
| `Open in YouTube` / `Copy share link` buttons | `LaunchStatusScreen.tsx` | No toast feedback after click. |
| Settings → Connections host/port | `SettingsScreen.tsx` | Hardcoded loopback:4455, read-only. Custom OBS endpoints not supported. |
| `IngestionInfoCard.SecretValue` clipboard | renderer | Uses `navigator.clipboard.writeText` directly; doesn't go through the main process. Fine for desktop, but means we don't have OS-level paste protection. |
| No event-feed plumbing | `DashScreen.tsx` | Renders an empty-state card. To populate it we'd need a renderer-side event log subscribing to OBS WebSocket events + launchService events. |
| No real "Reduce motion" honoring | keshucord.css `.fadein` + ring CSS transitions | The setting persists but no media-query / class gate exists. |
| No bandwidth / CPU probing | DashScreen / CreateScreen pre-flight | These rows render "not measured" placeholders. |
| Single-account OAuth | `electron/auth.ts` | Multi-account switching isn't implemented. The Settings tab disables the "Connect channel" button. |
| Stream history not persisted | n/a | The Overview, History, and parts of Dash (event feed) want this. There's no history store. |

## 12. Future scalability considerations

- **Stream-history persistence.** Even a small SQLite (or JSON file) for past
  broadcasts would unblock Overview, History, the event feed, and richer
  Dash-screen aggregations.
- **Multi-account OAuth.** Token store schema would have to become
  `Record<accountId, StoredTokens>` plus an `activeAccountId` pointer.
- **Custom OBS endpoint.** Surface host/port from `obsService.ts` into
  `UserSettings`. Right now `OBS_URL` is a `const` at the top of the file.
- **Stream-key rotation.** Currently we create a fresh `liveStream` for every
  launch and bind it. For users who stream often, supporting reusable streams
  (the `contentDetails.isReusable: true` path) would cut quota usage.
- **Real-time event log.** Plumb a unified event bus into a renderer-side
  store so DashScreen's event feed can show OBS state transitions, launch
  steps, and YouTube transitions. This would also benefit support/debugging.
- **Restoring "Reduce motion".** Need a CSS class gate (`.app[data-reduce-motion]`) and a corresponding media-query in keshucord.css. Mechanical change once we commit to it.
- **Internationalization.** All strings are inline literals. If we ever
  localize, the i18n insertion points are the screen files and a handful of
  service error messages.
- **Renderer crash recovery.** No bootstrap retry. If the auth `getCurrentUser` call rejects, we silently fall through to login. If the settings load
  rejects (corrupted blob), we fall back to defaults. Both are reasonable
  but undocumented to the user.
