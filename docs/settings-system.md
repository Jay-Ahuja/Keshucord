# Settings System

> User-preference persistence. Loaded once at boot, written optimistically
> on every change, encrypted at rest.

## 1. Persistence architecture

```
┌─ Renderer ──────────────────────────────────────────────────────┐
│                                                                 │
│  React tree                                                     │
│    SettingsProvider (src/utils/settingsContext.tsx)             │
│      useState<UserSettings>                                     │
│      load() on mount                                            │
│      save() optimistic w/ rollback                              │
│      reset()                                                    │
│        │                                                        │
│        └──► useSettings() hook                                  │
│                  consumed by App, SettingsScreen,               │
│                  CreateScreen, Sidebar                          │
│                                                                 │
│    settingsService (src/services/settingsService.ts)            │
│      load   → window.keshucord.settings.load()                  │
│      save   → window.keshucord.settings.save(settings)          │
│      reset  → window.keshucord.settings.reset()                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │ IPC (preload bridge)
                           ▼
┌─ Main process ──────────────────────────────────────────────────┐
│                                                                 │
│  electron/ipc.ts                                                │
│    'settings:load'   → settingsStore.load()                     │
│    'settings:save'   → settingsStore.save(payload)              │
│    'settings:reset'  → settingsStore.reset()                    │
│                                                                 │
│  electron/settingsStore.ts                                      │
│    load:  fs.readFile → safeStorage.decryptString → JSON.parse  │
│           → merge with DEFAULT_PERSISTED_SETTINGS               │
│    save:  sanitize → JSON.stringify → safeStorage.encryptString │
│           → fs.writeFile (mode 0o600)                           │
│    reset: fs.unlink → return DEFAULT_PERSISTED_SETTINGS         │
│                                                                 │
│      file: <app.getPath('userData')>/settings.enc               │
└─────────────────────────────────────────────────────────────────┘
```

Two TypeScript shapes — they're intentionally kept in lock-step:

| Where | Type | File |
|---|---|---|
| Renderer | `UserSettings` | [`src/types/settings.ts`](../src/types/settings.ts) |
| IPC payload | `UserSettings` (declared in `global.d.ts`) | [`src/types/global.d.ts`](../src/types/global.d.ts) |
| Preload bridge | `PersistedSettingsPayload` | [`electron/preload.ts`](../electron/preload.ts) |
| Main process | `PersistedSettings` | [`electron/settingsStore.ts`](../electron/settingsStore.ts) |

All four share the same fields and TypeScript union literals (e.g.
`Privacy = 'public' | 'unlisted' | 'private'`). When adding a field,
update all four places + the `DEFAULT_*` constants.

## 2. Local storage strategy

### File

`<app.getPath('userData')>/settings.enc`

- Windows: `%APPDATA%\Keshucord\settings.enc`
- macOS: `~/Library/Application Support/Keshucord/settings.enc`
- Linux: `~/.config/Keshucord/settings.enc`

File mode is `0o600` (owner read/write only) so even on shared systems
the file isn't readable by other accounts at the FS layer. The encrypted
content provides an additional defense if the file is moved or copied.

### Encryption

Electron's [`safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage):

| Platform | Backed by |
|---|---|
| Windows | DPAPI bound to the OS user account |
| macOS | Keychain (`com.apple.security.SecCodeRequirement`) |
| Linux | libsecret (gnome-keyring / KWallet) |

`safeStorage.encryptString(json)` and `safeStorage.decryptString(buf)`.
Both refuse to operate if `safeStorage.isEncryptionAvailable()` is false.
The `save()` path throws "OS-level encryption is unavailable; refusing
to write settings in plaintext." in that case — we never silently degrade.

### Schema migration

There is **no** schema version field. Migration is purely additive: the
load path merges what's on disk with the current default constants:

```ts
const parsed = JSON.parse(safeStorage.decryptString(encrypted)) as Partial<PersistedSettings>;
return { ...DEFAULT_PERSISTED_SETTINGS, ...parsed };
```

This means:

- Adding a new field: existing payloads silently pick up the default
  value the next time they're loaded. Safe.
- Removing a field: existing payloads still contain the obsolete key,
  but no code reads it. Safe.
- Changing a field's type: **not safe** — would require a real schema
  version + migration. We haven't done this.

`save()` also re-sanitizes every field through type guards (`normalizePrivacy`, `normalizeAccent`, `normalizeDensity`, `Boolean`,
`String`) so a malformed value from a tampered file or older payload can
never silently propagate.

## 3. OBS password handling

`obsPassword` is treated as a credential. It lives in the same
`settings.enc` blob as everything else, encrypted via the same
`safeStorage` mechanism — there is **no separate "secrets" file** for it.

The reason: we never write it to disk in any other form. The renderer
reads it via `useSettings()`, the launch flow passes it into
`obs.connect(password)`, and `obs-websocket-js` uses it for the
challenge/response handshake. Once we hand off to the WebSocket library,
the password's only further memory presence is whatever the library
retains.

### UI handling

In `SettingsScreen` → Connections tab:

```jsx
<input
  type={showPassword ? 'text' : 'password'}    // toggles via Eye icon button
  value={settings.obsPassword}
  onChange={(e) => update('obsPassword', e.target.value)}
  spellCheck={false}
  autoComplete="off"
/>
```

The `Test connection` button reads the *current* value from settings (not
the in-flight typed value) and calls `obsService.testConnection(password)`. Because typing triggers optimistic save on every keystroke, the
two are always in sync.

### Logging

We never log the password. The OBS service logs everything else but
never the password — and the password never appears in the YouTube
flow at all.

## 4. Default stream settings logic

Five "default" fields on `UserSettings`:

| Field | Type | Used as |
|---|---|---|
| `defaultTitle` | `string` | seed for `StreamSettings.title` |
| `defaultDescription` | `string` | seed for `StreamSettings.description` |
| `defaultPrivacy` | `Privacy` | seed for `StreamSettings.privacy` |
| `defaultCategory` | `string` | seed for `StreamSettings.category` |
| `obsPassword` | `string` | passed directly into the launch flow |

These are seeded into `streamSettings` (the live launch form) by
`App.tsx`'s mount effect (`toStreamSettings(userSettings)`), and **only
once** — controlled by the `seededFromUserDefaults` boolean. Subsequent
changes to `userSettings` do NOT auto-overwrite an in-progress form. The
user's manual edits on the Create screen win until they explicitly
"reset" or close + reopen the app.

### Re-seed points

| Trigger | Effect |
|---|---|
| App boot, both auth + settings loaded | First seed (`toStreamSettings(userSettings)`) |
| User signs out | `setStreamSettings(toStreamSettings(userSettings))` — reset to current defaults |
| LaunchStatusScreen "Plan another stream"-equivalent path | Currently the launch flow only navigates **forward** from launch (Back to setup → 'create' uses existing settings; Open dashboard → 'dash'). There is no "reset settings to defaults" button on the create screen today. Users can use the **Reset to defaults** button in Settings → Advanced to wipe everything. |

### Migration knob

When we change defaults (e.g. shipping a new "default category"), existing
users keep their saved defaults via the `{ ...defaults, ...parsed }`
merge. New users get whatever `DEFAULT_USER_SETTINGS` says.

## 5. Settings injection into stream creation

This is the join between the persisted-defaults world and the
live-launch world. Visualized:

```
   UserSettings  (persisted, mutable via Settings screen)
        │
        │  toStreamSettings(u: UserSettings): StreamSettings = {
        │    title:       u.defaultTitle,
        │    description: u.defaultDescription,
        │    privacy:     u.defaultPrivacy,
        │    category:    u.defaultCategory,
        │    obsPassword: u.obsPassword,
        │  }
        │
        ▼ (seed once on boot, plus after sign-out)
   streamSettings  (App state, mutable via Create form)
        │
        │  CreateScreen renders controlled inputs against streamSettings
        │  Every input change → setStreamSettings({ ...prev, [key]: value })
        │
        ▼ submit
   onSubmit(streamSettings)
        │
        ▼ launch
   runLaunchSequence({ settings: streamSettings, … })
        │
        ├─ validateSettings(streamSettings)
        │    · title required, ≤ 100 chars
        │    · description ≤ 5000 chars
        │    · obsPassword required
        │    · privacy ∈ { 'public', 'unlisted', 'private' }
        │
        └─ … rest of the 10-step flow
```

The split matters: `userSettings` is the *durable* preferences object;
`streamSettings` is the *transient* per-launch form. Confusing them
would mean the user's defaults change every time they tweak a single
field on a stream, which is the opposite of what "defaults" means.

## 6. Validation flow

Two validation points:

### 1. Per-control UI validation (SettingsScreen)

Each input has `maxLength` set on the native element. Privacy is a
`.seg` of three buttons so it's structurally impossible to set a bad
value. Accent / Density similarly use enumerated UI controls.

The free-form `defaultCategory` field accepts any string — YouTube
category mapping happens at launch time in `inferCategoryId`.

### 2. Final pre-launch validation

`validateSettings()` in `launchService.ts`. Runs as the first orchestrator
step (`'validate'`). Throws `Error("Stream title is required.")` /
`Error("Stream title is N characters — YouTube allows at most 100.")` /
etc. as appropriate. The launch screen surfaces these as red banners.

CreateScreen *also* gates the Go Live button locally:

```ts
const blockReason: string | null = !titleValid
  ? 'Add a title to continue.'
  : !passwordSet
  ? 'Set the OBS WebSocket password in Settings → Connections first.'
  : isStreaming
  ? 'OBS is already streaming — stop it before launching a managed broadcast.'
  : schedule === 'later'
  ? 'Scheduling lands in a follow-up — switch to "Start now" to launch.'
  : null;
```

Both layers are kept because:

- The CreateScreen gate prevents the user from even trying to launch.
- The `launchService` validation is the canonical check — defends against
  programmatic callers or schema drift.

## 7. Settings UI structure

[`src/screens/SettingsScreen.tsx`](../src/screens/SettingsScreen.tsx).
Tabbed layout matching the design's `.settings` rule.

```
.settings (grid: 200px sticky tabs | content)
├─ .set-tabs (column of buttons)
│    Connections | Stream defaults | YouTube account | Appearance | Shortcuts | Advanced
└─ .set-section
     One .card.padL per tab, containing .set-row's (label.info | control)
```

| Tab | Sections | Real / placeholder |
|---|---|---|
| Connections | host/port (read-only), WebSocket password (real + Test connection), Scene collection (read-only display) | **2 real + 1 read-only** |
| Stream defaults | default title, description, privacy, category | **4 real** |
| YouTube account | Connected channel + Sign out, Connect channel | **1 real, 1 disabled (multi-account)** |
| Appearance | Accent swatches, Density, Reduce motion, Window glass | **3 real, 1 disabled (window glass)** |
| Shortcuts | Static list of ⌘1/⌘N/⌘H/⌘,/⌘\ | **read-only** |
| Advanced | Telemetry, Experimental, Log level, Reset to defaults | **1 real (reset), 3 disabled placeholders** |

### Auto-save model

Every interactive control calls `update(key, value)` which calls
`save({ ...settings, [key]: value })`. There is no explicit "Save" button.

```ts
const update = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
  setSaveError(null);
  save({ ...settings, [key]: value })
    .then(() => setSavedAt(Date.now()))
    .catch((err) => setSaveError(err instanceof Error ? err.message : 'Failed to save settings.'));
};
```

`save()` is optimistic — UI updates first, disk write follows. On failure
the context re-loads canonical state from disk and re-throws so this
`.catch` block can render the error.

### `SyncStatusChip`

The header's small chip in `.actions`:

- No save yet this session → `Local · encrypted`
- After a successful save → `Saved · just now` (auto-ticks `just now` →
  `5s ago` → `1m ago` via a 60-second `setInterval`)
- After a save error → red `Save failed` with the message in the
  `title` attribute

### Reset

Lives in the Advanced tab. Calls `useSettings().reset()` which calls the
main process's `settings:reset` IPC handler which `fs.unlink`s
`settings.enc` and returns `DEFAULT_PERSISTED_SETTINGS`. The context then
fires through `setSettings(fresh)`.

Tokens (`tokens.enc`) are **not** touched — users sign out from the
Account tab separately.

## 8. Future extensibility

Adding a new setting is a four-file change with no migration:

1. **`src/types/settings.ts`** — add to `UserSettings` interface + add a
   default in `DEFAULT_USER_SETTINGS`.
2. **`electron/settingsStore.ts`** — add to `PersistedSettings` +
   `DEFAULT_PERSISTED_SETTINGS`. Add a normalize-on-save guard for the
   new field if the type is constrained.
3. **`electron/preload.ts`** — add to `PersistedSettingsPayload`.
4. **`src/screens/SettingsScreen.tsx`** — add a `.set-row` in the
   appropriate tab.

The load path's `{ ...DEFAULT, ...parsed }` merge handles existing users
seamlessly. New users get the default.

### Categorizing settings

The existing tabs are a good mental model. When adding a new setting,
pick the tab whose name best fits and add a row. If a setting doesn't
fit cleanly, **don't add a tab** — refactor instead. The current tab
structure was chosen specifically to keep settings discoverable without
deep navigation.

## 9. Security considerations

| Concern | Mitigation | Confidence |
|---|---|---|
| **At-rest extraction** of OBS password / OAuth tokens | OS keychain encryption via `safeStorage` | High on platforms with a real keychain (Windows/macOS); medium on Linux (depends on libsecret backend). |
| **Token leak via renderer compromise** | OAuth tokens never sent to renderer; access tokens fetched per-call in main and only the bearer header crosses the network | High |
| **OBS password leak via renderer compromise** | OBS password DOES live in the renderer at runtime (needed for the WebSocket handshake). Renderer is sandboxed (`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`). | Medium — would require attacker code execution in the renderer. We control all renderer code; no untrusted content. |
| **OBS password leak via logging** | `obsService` never logs the password. YouTube flow doesn't touch it. | High |
| **Stream key leak via UI** | IngestionInfoCard masks stream keys; "Show" / "Hide" toggle requires user action. Logs mask the key to `<N-char key ending …xxxx>`. | High |
| **Stream key leak via clipboard** | `navigator.clipboard.writeText` writes plaintext to OS clipboard. We do this on user click. No clipboard auto-clear. | Low — OS clipboard is a shared resource by design. |
| **Bypassing save() validation** | Direct call to `settingsService.save` (skipping the React context) is possible but never done — `useSettings` is the only consumer of `settingsService`. The main process re-sanitizes regardless. | High |
| **Cross-user file access** | File mode 0o600 + OS-keychain-bound encryption. On Windows specifically, DPAPI binds to the OS user, so even root can't decrypt another user's blob without `setpriv`-like tricks. | High |
| **`.env` exposure** | `.env` is in `.gitignore`. Loaded only by the main process via `dotenv/config`. Never sent to renderer. | High |
| **Replay of stolen blob** | If `settings.enc` is copied to another machine, it won't decrypt (different keychain key). | High |

What we don't defend against:

- A malicious admin on the user's machine with full code execution as
  the user — they can read `safeStorage`-decryption results from a
  process they've injected into.
- Compromise of the user's Google account — sign out from inside the
  app + revoke at <https://myaccount.google.com/permissions>.
- Compromised OBS WebSocket Server password file leaked via OBS itself
  (e.g. user pasted it into chat). Not our problem.

## 10. Known limitations

- **No light theme.** `colorScheme: 'dark'` is fixed; we only ship dark
  variants. The accent swatches let users tune the accent oklch hue,
  but background ladder + text scale are not theme-able.
- **No export / import.** A user moving to a new machine has to re-fill
  Settings + re-sign-in. No "Export settings JSON" feature.
- **No per-account preferences.** The Settings file is global. Tokens
  are also global. If multi-account is added later, both would need
  re-keying by account id.
- **OBS host/port not editable.** Hardcoded loopback:4455. Surface in
  Settings is read-only with a tooltip.
- **`appearanceReduceMotion` not honored.** Persisted, editable, but
  nothing in keshucord.css gates on it. Wiring requires either a
  `.app[data-reduce-motion]` selector pass or a media-query approach.
- **`appearanceDensity` not honored.** Same as above — the `compact`
  variant doesn't exist yet in the CSS.
- **`save` doesn't debounce.** Every keystroke in a text input triggers
  an optimistic save + disk write. Disk writes are ~ms-cheap so this is
  fine in practice, but it's not the most elegant approach.
- **No "last opened" / activity tracking.** A real Overview screen
  would want this. Today there's no place to put it.
- **Settings UI doesn't preview before save.** Because the model is
  auto-save, a tentative "try this accent then revert" isn't possible
  without manually re-clicking the previous swatch.
