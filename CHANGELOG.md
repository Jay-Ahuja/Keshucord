# Changelog

All notable changes to Keshucord are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

> Changes on the current branch not yet on `main`.

### Added
- Settings → Stream defaults gains a "Prepend today's date to stream
  title" toggle. When on, CreateScreen prepends `M/D/YYYY - ` to the
  title on mount (with a duplicate-prefix guard so re-mounting doesn't
  stack the date, and a `useRef` guard so React StrictMode's dev-only
  double-mount doesn't apply it twice). The inserted prefix is editable
  plain text — once seeded it behaves like any other characters in the
  title. New `UserSettings.titleDatePrefix` field flows through all four
  schema files (renderer type, main-process `PersistedSettings`, preload
  `PersistedSettingsPayload`, and the `normalize()` Boolean coercion);
  new `formatDatePrefix()` helper in `src/utils/format.ts` uses Date
  builtins rather than `Intl.DateTimeFormat` so the M/D/YYYY contract
  doesn't drift in non-en-US locales.
- OBS pre-flight: clicking Go Live now detects whether OBS Studio is
  running via a fast WebSocket probe before the launch sequence starts.
  If OBS isn't reachable, a dialog offers to launch OBS automatically
  (cross-platform — Windows registry lookup with `bin/64bit/` cwd
  handling, macOS `open -a OBS`, Linux PATH lookup); the dialog polls
  for reachability and proceeds to the launch flow once OBS is up. New
  IPC channels: `obs:is-running`, `obs:launch`. New main-process module:
  `electron/obsProcess.ts`. New renderer component:
  `src/components/ObsLaunchDialog.tsx`. New `obsService` exports:
  `probe()`, `launchAndWait()`, `ObsLaunchError`.

### Fixed
- OAuth sign-in can now be cancelled. Previously, closing the browser
  tab without completing consent left the app stuck on "Waiting for
  browser…" for the full 5-minute server timeout, and the timeout
  itself surfaced as a generic red error banner. `electron/auth.ts` now
  throws a typed `AuthCancelledError` on both the timeout and a new
  `cancelSignIn()` path; the renderer detects it via
  `err.name === 'AuthCancelledError'` and resets silently. New IPC
  channel: `auth:cancel-sign-in`. The existing single-flight signIn
  coalesce is preserved — accidental double-clicks still de-dupe onto
  one loopback server.
- LoginScreen pairs with the auth-cancel work above: a Cancel ghost
  button appears below the "Waiting for browser…" copy and calls
  `youtubeService.cancelSignIn()`. The in-flight signIn rejects with
  `AuthCancelledError`, which the catch branch detects via `err.name`
  (with an `AuthCancelledError:` message-prefix fallback for cross-IPC
  reliability) and silently resets the UI — no error banner. The
  now-unreachable timeout branch in `mapGoogleError` is removed.
- Defense-in-depth hardening (audit M1, H9). Added a strict
  Content-Security-Policy <meta> to index.html — script-src 'self', no
  eval, connect-src locked to localhost (OBS WS + Vite HMR), object-src
  'none'. Expanded CI to a [ubuntu, windows, macos] matrix on Node 22 so
  Windows-only code paths in electron/obsProcess.ts (tasklist, reg query)
  are no longer invisible to CI. engines.node widened to <23.0.0 since
  Node 20 has reached EOL.
- Settings persistence error handling (audit H4/H5). A failed
  `settings.enc` load no longer silently overwrites the file with blanks
  on the first save — `SettingsProvider` now exposes a `loadFailed`
  flag, `save`/`reset` reject when set, and `SettingsScreen` shows a
  non-dismissible banner explaining the state. The `save()` catch path
  no longer overwrites a newer queued save's optimistic state — the
  disk-rollback only fires when the failed save was still the latest.
- Sign-out and launch-lifecycle handoffs (audit H2/H3/H6/H7).
  `handleSignOut` now aborts any in-flight launch and awaits its cleanup
  before clearing tokens, so the launch's `deleteBroadcast` /
  `deleteLiveStream` calls don't race the token wipe and orphan resources
  on the user's YouTube channel; it also disconnects OBS so the next
  session doesn't inherit a `streaming` state from the previous user's
  broadcast. `launchService` now sets `obsProgress='streaming'` BEFORE
  `obs.startStreaming()` so a verify-loop timeout still routes through the
  cleanup branch's `stopStreaming`+`disconnect`, instead of leaving OBS
  silently pushing RTMP to a deleted broadcast endpoint; the cleanup
  branch's `'streaming'` arm now always attempts both even when our
  internal state never observed the live state. The `propagate` listener
  (which fires `youtube.cancel()` on abort) now detaches at the top of
  the cleanup branch so a user-initiated Cancel during cleanup can't
  abort the cleanup's own `deleteBroadcast` / `deleteLiveStream` calls.
  Two new internal `launchService` exports — `abortActiveLaunch()` and
  `awaitActiveLaunchSettled()` — exist solely for the App-level sign-out
  drain, not for per-step abort use within a launch.
- CreateScreen no longer blocks the Go Live click when the OBS WebSocket
  password isn't set — the new pre-flight dialog needs to surface
  BEFORE asking the user to set credentials for a service they haven't
  opened yet. The orchestrator still validates the password as step 1
  of the launch sequence, so missing-password is still caught (just
  after OBS is up). The pre-flight side panel still surfaces the
  missing-password state informationally.
- App.tsx now injects the live `userSettings.obsPassword` into the
  settings handed to LaunchStatusScreen at handoff time, so a password
  set in Settings between Go Live attempts actually reaches the
  orchestrator. `streamSettings` is seeded from `userSettings` exactly
  once at boot for form-edit-preservation reasons; the password is not
  a form field so it shouldn't share that seeding lifecycle.
- App.tsx memoizes the launch-settings object handed to
  LaunchStatusScreen. Without memoization a fresh object literal was
  allocated on every App render, which — combined with the launch-firing
  useEffect in LaunchStatusScreen depending on `settings` — caused a
  feedback loop: each OBS status change at step 7 re-rendered App, re-fired
  the effect, aborted and restarted the launch, which disconnected OBS
  during cleanup, which fired another status change. Visible as steps
  1–5 re-running while stuck on step 7 and OBS oscillating
  connected/disconnected. The launchService mutex's serial cleanup
  prevented orphan broadcasts, but the sheer API-call volume tripped
  YouTube's `userRateLimitExceeded`.
- LaunchStatusScreen now captures the `settings` prop via a ref and
  uses `[]` deps on the launch-firing useEffect. Defense-in-depth: even
  if a future contributor passes a non-memoized settings prop from App,
  the launch can no longer be re-triggered mid-flight by an upstream
  prop identity change.
- `electron/youtube.ts` `explainError` now maps `userRateLimitExceeded`
  to the same friendly "rate-limit hit, wait a minute" message that
  `rateLimitExceeded` already had. The two reasons are siblings (both
  403 rate-limit — project quota vs per-user quota), but only the
  latter was previously mapped; the per-user variant fell through to
  the raw API string.
- Sidebar no longer surfaces a "Going Live" entry for the `launch`
  screen — the launch screen is a transient state in the Create → Launch
  → Dash flow, not a destination the user navigates to (clicking it
  mid-stream would have dropped the user back into a stale orchestrator
  view). The `'launch'` member of the `Screen` union is intentionally
  preserved so `App.tsx`'s route guards keep working; the Sidebar's
  `active = page === item.key` lookup safely degrades to no-match (all
  rows render inactive) while `screen === 'launch'`. Paired with this,
  `App.tsx`'s `handleBroadcastLive` now auto-advances to Dash on
  successful launch by also calling `setScreen('dash')`. The transition
  is guarded by a `screenRef.current === 'launch'` check (mirroring
  `screen` into a ref via a small `useEffect`) so we don't yank the
  user to Dash if they navigated away from the launch screen mid-flight.
  The guard MUST stay — `handleBroadcastLive`'s `useCallback` deps
  array must remain `[]` to preserve stable identity for
  LaunchStatusScreen's launch-firing useEffect, so reading `screen`
  directly isn't an option. Don't delete it thinking it's dead code.
- DashScreen's End stream button now also transitions the YouTube
  broadcast to `complete` after stopping OBS — previously it only
  stopped OBS, which left the broadcast in `live` on YouTube's side
  until the ingest timeout fired (~minutes later) and forced YouTube
  to auto-end it. App.tsx lifts the live broadcast out of
  LaunchStatusScreen via a stable `onBroadcastLive` callback (fired
  from the `complete` event so we only surface the actually-live
  broadcast), keeps it in app state, and hands `broadcastId` to
  DashScreen. The new prop / callback in LaunchStatusScreen is
  captured via a ref (same defense as `settingsRef`) so it can never
  re-fire the launch-firing useEffect. OBS-stop failure aborts before
  calling YouTube; YouTube-transition failure surfaces a retry-friendly
  message without reversing the OBS stop.
- DashScreen's End stream button was permanently disabled after a
  YouTube `transitionToComplete` failure: OBS had already stopped so
  `isStreaming` was false, the `!isStreaming || endStreamBusy` disable
  rule latched on, and the error banner had no dismiss control — the
  copy promised "you can retry" but no retry surface existed. The
  button now stays clickable while a stale `broadcastId` +
  `endStreamError` pair both exist, and that retry path skips the OBS
  stop step (OBS is already stopped) and only retries the YouTube
  transition. The button label switches to "Retry ending broadcast" in
  this state. `endStreamError` clears on a fresh click and via a
  `useEffect` when `broadcastId` becomes null (a new launch is
  starting; the prior error is no longer relevant).

### Documentation
- Added `docs/electron-ipc.md` — complete IPC channel registry and security model.
- Added `docs/design-system.md` — token system, component classes, accent architecture.
- Added `docs/development.md` — onboarding, local setup, debugging workflow.
- Added `docs/known-issues.md` — curated technical debt and known gaps.
- Added `docs/error-catalog.md` — centralized error message reference.
- Added `docs/testing.md` — recommended testing strategy and manual checklist.
- `docs/launch-flow.md` already existed as an untracked file.
- Updated `docs/electron-ipc.md` for the new `obs:*` channels, the
  `youtube:cancel` channel that was in the code but not documented, the
  17-channel total, and the `ObsLaunchResultPayload` type.
- Updated `docs/architecture.md`: documented the pre-flight gate in §9
  (without inflating the canonical 10-step sequence), added the
  `electron/obsProcess.ts` module + `ObsLaunchDialog` component to §3 /
  §4, added the OBS OS-process row to §5, and removed the
  `obsService.launchObs()` stub entries from §11 and §12 (the stub has
  been replaced with the real `probe()` + `launchAndWait()`
  implementation).
- Updated `docs/known-issues.md`: removed the `obsService.launchObs()`
  stub entries from §1 and §5; documented two minor remaining gaps in
  the new code (Linux `PATH`-only OBS launch; `obs:is-running` is a
  process-table check, not a WebSocket-enabled check).

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
