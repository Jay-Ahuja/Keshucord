# Known Issues

> Curated inventory of current bugs, quirks, intentional limitations,
> and technical debt. Updated when issues are found or resolved.
>
> Legend: **[bug]** = incorrect behavior | **[debt]** = known suboptimal
> implementation | **[stub]** = not implemented | **[ui]** = UI-only gap
> (no backend work needed) | **[limitation]** = intentional constraint
> with a documented rationale

## 1. Dead code

### `src/utils/delay.ts` — unused module [debt]

```
File: src/utils/delay.ts
```

Exports a `delay(ms)` promise helper. Was used during mock-API development.
No current code imports it. Safe to delete.

### `YouTubeUser.avatarColor` — produced but never consumed [debt]

```
Field: src/types/youtube.ts → YouTubeUser.avatarColor
Code:  src/services/youtubeService.ts → decorate()
```

`youtubeService.decorate()` hashes the user id to a CSS gradient string and
attaches it as `avatarColor`. The only historical consumer (`UserChip`
component) was deleted. The Sidebar's avatar uses a CSS `.avatar` gradient
directly. This field can be removed from the type and the `decorate()` call.

### `tailwind.config.js` brand/ink palette — dead tokens [debt]

All consumers migrated to oklch tokens in `keshucord.css`. Tailwind purges
unused classes, so there is no bundle impact, but the config block
misleads future readers.

## 2. Appearance settings — persisted but not applied

### `appearanceDensity` — no CSS implementation [stub]

```
Field:  src/types/settings.ts → UserSettings.appearanceDensity
UI:     SettingsScreen → Appearance → Density control
Status: Saves to disk, no visual effect
```

The `compact` density variant does not exist in `keshucord.css`. Adding it
would require defining a second set of spacing/size overrides under a
`.app[data-density="compact"]` selector.

### `appearanceReduceMotion` — no CSS gate [stub]

```
Field:  src/types/settings.ts → UserSettings.appearanceReduceMotion
UI:     SettingsScreen → Appearance → Reduce motion toggle
Status: Saves to disk, no visual effect
```

`keshucord.css` has `.fadein` keyframes and the ring's stroke-dashoffset
transition but no selector that disables them. The fix is a
`.app[data-reduce-motion]` block that sets `animation: none; transition: none`
on all animation hooks. A `@media (prefers-reduced-motion)` approach would
also work.

### Window glass — disabled UI with no implementation [stub]

```
UI: SettingsScreen → Appearance → Window glass toggle (renders as disabled)
Status: UI-only placeholder; no implementation
```

## 3. UI gaps

### No toast on "Open in YouTube" / "Copy share link" [ui]

```
File: src/screens/LaunchStatusScreen.tsx
```

The "Open in YouTube" and "Copy share link" buttons execute their
actions (open external URL, write to clipboard) but give no feedback.
The user has no confirmation that the copy succeeded or that the browser
opened. A brief inline toast or chip state flip would fix this.

### No event feed in DashScreen [stub]

```
File: src/screens/DashScreen.tsx
```

The `.event-feed` card renders an empty-state "No events yet" message.
Populating it requires a renderer-side event log that subscribes to
`launchService` events + OBS WebSocket events over time. No such log
store exists.

### No bandwidth / CPU probing [stub]

```
File: src/screens/CreateScreen.tsx, src/screens/DashScreen.tsx
```

CreateScreen and DashScreen have placeholder rows for "Upload speed" and
"CPU usage" that show "Not measured". There is no implementation behind
these. CPU probing would require a new IPC channel (Node's
`os.loadavg()` or a platform-specific API); bandwidth probing would
require an upload speed test to an external endpoint.

### No "Reset stream settings to defaults" button on CreateScreen [ui]

```
File: src/screens/CreateScreen.tsx
```

The form can become inconsistent with `userSettings` defaults after
manual edits. The user can navigate away and back, but the form is
preserved (intentionally). There is no explicit "reset to defaults"
affordance on the create screen itself. The only reset path is
Settings → Advanced → Reset to defaults (which wipes all settings).

### Stream key clipboard — no OS paste protection [limitation]

```
File: src/components/IngestionInfoCard.tsx → SecretValue
```

`navigator.clipboard.writeText` is called directly in the renderer on
user click. The clipboard is a shared OS resource; there's no auto-clear
timer. This is accepted for a desktop app but documented as a gap for
security-conscious users.

## 4. Authentication

### Single-account OAuth [limitation]

```
File: electron/auth.ts, electron/tokenStore.ts
UI:   SettingsScreen → YouTube Account → Connect channel (disabled)
```

`tokenStore.ts` holds one flat set of tokens. Multi-account switching
requires changing the token schema to `Record<accountId, StoredTokens>`
plus an `activeAccountId` pointer and new UI. The "Connect channel"
button in Settings is disabled with a tooltip to that effect.

### No network-level retry for OAuth token exchange [limitation]

If the POST to `oauth2.googleapis.com/token` gets a transient 5xx during
sign-in, the exchange fails and the user must click "Sign in" again. No
automatic retry.

## 5. OBS integration

### OBS host/port not configurable [limitation]

```
Constant: src/services/obsService.ts → OBS_URL = 'ws://localhost:4455'
UI:       SettingsScreen → Connections → Host (read-only display)
```

The WebSocket URL is hardcoded. The Settings UI shows it as a read-only
field. Supporting a custom host or port requires:
1. Adding `obsHost`/`obsPort` fields to `UserSettings`.
2. Reading them in `obsService.ts` instead of the constant.
3. Making the Settings → Connections fields editable.

### No auto-reconnect after OBS disconnect [limitation]

If OBS disconnects mid-stream (`ConnectionClosed` event), the app
transitions to `disconnected` state and stops health polling. It does
not attempt to reconnect. This is intentional — a silent reconnect
after an interruption would be misleading. The user must end the stream
from DashScreen and re-launch.

### OBS launch on Linux assumes `obs` is on `PATH` [limitation]

```
File: electron/obsProcess.ts → launchLinux()
```

The Linux launch branch unconditionally spawns `obs` from `PATH`. Distro
packages and the Flatpak wrapper script both satisfy this, but if a user
installed OBS into a non-`PATH` location (custom build, AppImage left in
`~/Downloads`, etc.) the spawn fails with `ENOENT` and the dialog shows
"Failed to launch OBS". There is no registry/Info.plist analogue we could
read to discover an alternate location, so this is documented as a
limitation rather than a bug. The Windows branch in contrast queries the
registry and falls back to the canonical Program Files install path.

### OBS pre-flight uses `tasklist` / `pgrep` rather than a port probe for detection [limitation]

```
File: electron/obsProcess.ts → isObsRunning()
```

`obs:is-running` checks the OS process table. It does NOT verify that the
OBS WebSocket server is enabled or listening on 4455. A user who has OBS
open but disabled the WebSocket server in Tools → WebSocket Server
Settings will pass the pre-flight check, then fail at step 7 (connect-obs)
with the canonical "Could not reach OBS at ws://localhost:4455" error.
The launch-OBS dialog won't re-open in that case because OBS *is* running
— it just isn't reachable. (The renderer-side `obsService.probe()` does
use a port probe; the OS-process check is intentionally cheaper and only
answers "should we offer to launch OBS?".)

## 6. YouTube integration

### Scheduling not implemented [stub]

```
UI:   CreateScreen → Schedule mode (date/time inputs disabled, Go Live gated)
File: src/services/launchService.ts → step 3 always uses now + 30s
```

The CreateScreen has a "Schedule" mode but the form is disabled and the
Go Live button refuses to submit when `schedule === 'later'`. Wiring
requires passing the user-selected `scheduledStartTime` into
`createBroadcast`, plus deciding on the transition-to-live timing.

### Tags and thumbnail upload not implemented [stub]

```
UI:   CreateScreen → Tags input (placeholder only), Thumbnail dropzone (placeholder)
```

Both inputs are present in the UI but not wired to any API call. Tags
could be added to the `videos.update` call already made for category.
Thumbnail requires `thumbnails.set` with a multipart upload — more
involved.

### Category update is best-effort only [limitation]

```
File: electron/youtube.ts → createBroadcast()
```

The `videos.update` call that sets `categoryId` is wrapped in
`try/catch`. If it fails (which can happen for some account/broadcast
states), the broadcast is still created with YouTube's default category.
Only a `console.warn` is emitted — the user sees no error.

### Orphan cleanup is best-effort [limitation]

```
File: src/services/launchService.ts → catch block
```

If a launch fails after creating a broadcast and/or stream, the cleanup
`Promise.allSettled` deletes them. If deletion itself fails, the
resource remains on the user's YouTube channel as an orphaned broadcast.
There is no "list orphans" surface or retry path. Users would need to
clean up from YouTube Studio.

### No subscriber / viewer count [stub]

DashScreen's preview overlay has placeholder slots for live viewer count
and subscriber count. Neither `channels.list?part=statistics` nor
`videos.list?part=liveStreamingDetails` is fetched.

### `monitorStream` not supported [limitation]

All broadcasts are created with `monitorStream: { enableMonitorStream: false }`. The OBS "testing" → "live" two-stage workflow that
monitor-stream enables is not implemented.

### No stream history persistence [stub]

There is no storage for past broadcasts. The Overview and History screens
are placeholder empty states. Adding history would require at minimum a
local JSON or SQLite file updated on each successful launch.

## 7. Performance / correctness

### `applyAccent` fires after first paint [bug, cosmetic]

```
File: src/App.tsx → useEffect(() => applyAccent(...))
```

The accent application runs in a `useEffect`, which fires after the
first paint. Users with a non-default accent stored in settings will
briefly see the default purple before the stored accent is applied. Fix:
call `applyAccent` synchronously before the React tree renders, or in
`src/main.tsx` after settings are loaded.

### Settings save does not debounce [debt]

```
File: src/utils/settingsContext.tsx → save()
```

Every keystroke in a Settings text input triggers a full optimistic
save + `safeStorage.encryptString` + `fs.writeFile` round-trip. In
practice this is fast (sub-ms disk write), but it's architecturally
wasteful. A 300–500 ms debounce on the text inputs in `SettingsScreen`
would be more elegant.

### No crash recovery on bootstrap failure [limitation]

If `auth.getCurrentUser()` rejects during bootstrap, the app silently
falls through to the login screen without telling the user why. If
`settingsStore.load()` throws (e.g. a corrupted `settings.enc`), the
app falls back to defaults silently. Both are reasonable defaults but
unannounced to the user.

## 8. Platform

### No packager configured [limitation]

There is no `electron-builder` or `electron-forge` config. The app runs
in development mode (`npm run dev`) and can be started from a built state
(`npm run build && npm start`), but there is no `.exe` installer or
auto-update mechanism.

### No code signing [limitation]

Unsigned builds will show an OS security warning on Windows ("Windows
protected your PC") and macOS (Gatekeeper). Not relevant during
development but required before distributing to end users.
