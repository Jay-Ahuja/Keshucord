# Changelog

All notable changes to Keshucord are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

> Changes on the current branch not yet on `main`.

### Documentation
- Added `docs/electron-ipc.md` — complete IPC channel registry and security model.
- Added `docs/design-system.md` — token system, component classes, accent architecture.
- Added `docs/development.md` — onboarding, local setup, debugging workflow.
- Added `docs/known-issues.md` — curated technical debt and known gaps.
- Added `docs/error-catalog.md` — centralized error message reference.
- Added `docs/testing.md` — recommended testing strategy and manual checklist.
- `docs/launch-flow.md` already existed as an untracked file.

---

## [0.1.0] — Initial release

> Committed as "Initial commit: Keshucord desktop app". Everything below
> describes the state of the app at that commit.

### Added

#### Core app shell
- Electron 31 desktop shell with `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`. No Node access in the renderer.
- Vite 5 + React 18 + TypeScript 5 renderer build pipeline.
- Custom CSS design system (`src/styles/keshucord.css`) with oklch design
  tokens, dark-only theme, and Geist/Geist Mono typography.
- CSS grid app shell: 36 px TitleBar + 232 px Sidebar + 1fr main content.
- Sidebar compact mode (64 px) toggled by `sidebarCompact` setting or ⌘\.
- No router — navigation is a `Screen` union in `App.tsx` state.
- No state library — state is lifted to `App.tsx` or held in `SettingsProvider`.
- Keyboard shortcuts: ⌘1 (Home), ⌘N (Create), ⌘H (Dashboard), ⌘, (Settings),
  ⌘\ (toggle sidebar). Disabled when focus is in an input.

#### Authentication
- OAuth 2.0 for Installed Apps — PKCE + loopback HTTP server on random port.
- Scopes: `openid`, `email`, `profile`, `youtube.force-ssl`.
- `prompt=consent` forced on every auth request to guarantee a refresh token.
- `state` parameter validated to protect against CSRF on the callback.
- 5-minute timeout on the loopback server before failing gracefully.
- Access tokens encrypted at rest via Electron `safeStorage` (DPAPI on
  Windows, Keychain on macOS, libsecret on Linux).
- Per-request token refresh: access token silently refreshed when within
  60 seconds of expiry. On refresh failure, tokens cleared → user logged out.
- Sign-out revokes the refresh token on Google's servers (best-effort).

#### Settings system
- `settings.enc` — JSON blob encrypted via `safeStorage`, merged with
  `DEFAULT_USER_SETTINGS` on load (safe additive migration).
- `tokens.enc` — same encryption mechanism, separate file.
- Optimistic save model: React context state updates synchronously,
  disk write follows, rollback on failure.
- Auto-save on every control change in `SettingsScreen` — no explicit Save button.
- `SyncStatusChip` in the Settings header shows "Saved · just now" / error state.
- Settings → Advanced → Reset to defaults: unlinks `settings.enc`, reverts
  context to defaults. Does not affect `tokens.enc`.

#### Settings fields
- `obsPassword` — OBS WebSocket password (encrypted at rest).
- `defaultTitle`, `defaultDescription`, `defaultPrivacy`, `defaultCategory` —
  seeded into the launch form once on boot.
- `appearanceAccent` — one of `purple` (default), `cobalt`, `ember`, `mono`.
  Runtime-swappable via CSS variable writes.
- `appearanceDensity` — persisted, not yet applied to CSS.
- `appearanceReduceMotion` — persisted, not yet applied to CSS.
- `sidebarCompact` — wired to the `.compact` class on the app shell.

#### YouTube Data API integration
- `electron/youtube.ts` — plain `fetch` against `googleapis.com/youtube/v3`.
  No `googleapis` SDK dependency.
- `createBroadcast`: `liveBroadcasts.insert` + best-effort `videos.update`
  for `categoryId` / `tags`. `isReusable: false` — fresh stream per launch.
- `createLiveStream`: `liveStreams.insert`.
- `bindBroadcastToStream`: `liveBroadcasts.bind` with triple identity assertion.
- `getStreamIngestionInfo`: `liveStreams.list?part=cdn` with item-ID assertion.
  Prefers RTMPS over plain RTMP.
- `getStreamStatus`: `liveStreams.list?part=status`.
- `transitionToLive`: `liveBroadcasts.transition?broadcastStatus=live`.
- `deleteBroadcast` / `deleteLiveStream`: cleanup on launch failure.
- `explainError`: maps all known YouTube API error reason strings to
  actionable user-facing messages.

#### OBS WebSocket integration
- `src/services/obsService.ts` — module-scoped `OBSWebSocket` instance
  (browser-compatible; runs in the renderer, not main).
- 5-state connection machine: `disconnected` → `connecting` → `connected`
  → `streaming` / `error`.
- `connect(password, { attempts, retryDelayMs })` — retry loop with 3
  attempts + 1.5 s spacing during launch.
- `configureStreamService` — writes `rtmp_custom` service settings + poll-
  verifies via `GetStreamServiceSettings` for up to 3 s.
- `assertActiveStreamServiceSettings` — final immutable read before
  `StartStream`. Two-layer defense against YouTube-account-linked OBS override.
- `startStreaming` — `StartStream` + polls `outputActive` for 5 s.
- `stopStreaming` — `StopStream` + state transition.
- Stream health polling every 1.5 s while streaming: bitrate (Δ bytes),
  FPS, dropped frames, congestion, render time, output duration.
- Bitrate ring buffer (64 samples) for the DashScreen chart.
- Subscribe-pattern hooks: `useObsStatus`, `useStreamHealth`,
  `useBitrateHistory`.
- `explainObsError`: maps error codes and message patterns to user-readable
  messages. Stream keys masked in logs.

#### Launch orchestration
- `src/services/launchService.ts` — 10-step orchestrator.
- Module-level mutex (`activeLaunch` + `activeAbort`) — serializes
  concurrent calls (from React StrictMode double-mount or rapid user clicks).
  Aborts and awaits prior launch cleanup before starting a new one.
- `AbortSignal` propagation through all steps. `waitForStreamActive` polling
  is the only async operation that fully honors abort; OBS/fetch calls are
  interrupted at the next step boundary.
- On any step failure: best-effort parallel cleanup of `broadcast` +
  `stream` via `Promise.allSettled`. Emits `cleanup` event with list of
  deleted resource IDs.
- `LaunchEvent` event protocol consumed by `LaunchStatusScreen`.
- Step 1: local validation (title, description, OBS password, privacy).
  Intentional 250 ms delay so the row visibly turns green.
- Steps 2–6: YouTube API provisioning (auth, broadcast, stream, bind, ingestion).
- Steps 7–9: OBS configuration and stream start.
- Step 10: `waitForStreamActive` (90 s timeout, 2 s poll) + `transitionToLive`.

#### Screens
- **LoginScreen** — split-hero layout. "Continue with YouTube" button
  triggers full OAuth flow. Shows "Waiting for browser…" while in flight.
  Red error panel on failure with full message.
- **CreateScreen** — two-column form (title, description, privacy, category)
  + side panel (OBS status pre-flight, stream key preview placeholder).
  Preset bar and thumbnail dropzone are UI-only mocks. Tags input is
  UI-only. Schedule mode renders but is gated (Go Live disabled).
  Local gate checks before submission: empty title, missing OBS password,
  OBS already streaming, schedule mode.
- **LaunchStatusScreen** — animated ring (SVG stroke-dashoffset) + 10-step
  checklist. Real-time `step:detail` updates. `IngestionInfoCard` appears
  after step 6 (ingestion ready). Celebration state after step 10
  (broadcast live). "Back to setup" on failure, "Open dashboard" on success.
- **DashScreen** — live bitrate bar chart, KPI tiles (bitrate, FPS, dropped
  frames, latency), OBS/YouTube connection cards, End stream button.
  Event feed is an empty-state placeholder.
- **SettingsScreen** — 6-tab layout (Connections, Stream defaults, YouTube
  account, Appearance, Shortcuts, Advanced). Auto-save model.
- **PlaceholderScreen** — used for Home, History, Help routes (empty state).

#### Shared components
- `TitleBar` — 36 px bar: page title left, LIVE chip + duration + version right.
- `Sidebar` — brand area (click toggles compact), workspace nav, account nav,
  status footer (YouTube + OBS + scene name), avatar chip.
- `IngestionInfoCard` — broadcast watch URL, RTMP URL (copy), stream key
  (Show/Hide/Copy). Renders after ingestion info is ready.
- `Spinner` — loading indicator (only Tailwind-classed component).
- `PlaceholderScreen` — honest "Coming soon" empty state for unbuilt routes.
- `Icons.tsx` — all SVG icons in one file, stroke-based, `currentColor`.

#### IPC channel system
- 14 channels across 3 namespaces (`auth:*`, `settings:*`, `youtube:*`).
- All channels use `ipcMain.handle` + `ipcRenderer.invoke` (request/response).
- Preload exposes `window.keshucord.{auth, youtube, settings}` via
  `contextBridge.exposeInMainWorld`.
- Types for the full API surface in `src/types/global.d.ts`.

#### Documentation (initial)
- `docs/architecture.md` — process architecture, tech stack, lifecycle,
  state flow, 10 architectural decisions, technical debt table.
- `docs/frontend-system.md` — UI architecture, screen hierarchy, styling
  system, state management, loading/error patterns, animation philosophy.
- `docs/obs-flow.md` — OBS WebSocket integration, connection lifecycle,
  health metrics, common failure cases.
- `docs/youtube-flow.md` — OAuth flow, token storage, API client, broadcast
  and stream lifecycle, cleanup-on-failure, rate limits.
- `docs/settings-system.md` — persistence architecture, encryption,
  schema migration, OBS password handling, validation.
- `docs/oauth-setup.md` — Google Cloud Console setup guide.
- `docs/launch-flow.md` — canonical 10-step launch flow walkthrough.

### Known limitations at 0.1.0
- No automated tests.
- No packaging (no `.exe` installer or auto-update).
- No code signing.
- Single YouTube account only.
- Tags, thumbnail upload, stream scheduling not implemented.
- `appearanceDensity` and `appearanceReduceMotion` persisted but not
  applied to CSS.
- OBS host/port not configurable (hardcoded `ws://localhost:4455`).
- No stream history persistence.
- Event feed in DashScreen is an empty-state placeholder.
