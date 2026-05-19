# Testing

> Current testing posture, known gaps, and recommended testing strategy
> for the Keshucord codebase.

## 1. Current state

Vitest 2.x is installed and configured. Two service-layer test suites exist:

| File | Coverage area |
|---|---|
| `src/services/__tests__/launchService.test.ts` | 10-step orchestrator, mutex serialization, abort propagation, cleanup branches |
| `src/services/__tests__/obsService.test.ts` | OBS WebSocket state machine, poll-verify, health polling, `probe()` |

CI runs `npm run test` on every push across ubuntu/windows/macos (`node 22`).

**What is not covered:**
- All Electron main-process code: `electron/auth.ts`, `electron/youtube.ts`, `electron/tokenStore.ts`, `electron/settingsStore.ts`, `electron/obsProcess.ts`
- All React screens (`src/screens/`)
- All React components (`src/components/`)
- Utilities: `settingsContext.tsx`, `useObsStatus.ts`, `useStreamHealth.ts`, `useBitrateHistory.ts`, `applyAccent.ts`, `format.ts`

Coverage reporting is scoped to `src/services/**/*.ts`. Run `npm run test:coverage` to generate an HTML report in `coverage/`.

## 2. What TypeScript gives us today

TypeScript `strict: true` provides:
- Type-level contracts on all IPC payloads, service return types,
  and component props.
- Catch-at-compile-time: wrong argument types, missing fields in
  interface implementations, misused discriminated unions.

This is meaningful coverage but validates types, not behavior. Side effects,
async flows, and cross-system integration are not covered by the type system alone.

## 3. Test targets by priority

### Priority 1 — `launchService.ts` ✅ Done

`src/services/__tests__/launchService.test.ts`

Both services (`obsService`, `youtubeService`) are mocked via `vi.mock`. The
`beforeEach` restores all default stubs; `afterEach` drains the module-level
mutex via a pre-aborted launch so no state leaks between tests.

**What is covered:**

| Suite | Tests |
|---|---|
| `validateSettings` | empty title, 101-char title, 5001-char description, empty OBS password, invalid privacy enum, valid settings (no throw) |
| `runLaunchSequence happy path` | all 10 step events in order, `broadcast-created` after step 3, `ingestion-ready` after step 6, `complete` with `status: 'live'` after step 10, mutex re-entry after completion |
| `failure & cleanup` | step 3 fail → no delete called, step 5 fail → both broadcast and stream deleted + `cleanup` event emitted, `obsProgress="configured"` → `obs.disconnect()` only, `obsProgress="streaming"` → `obs.stopStreaming()` + `obs.disconnect()`, disconnect error during cleanup is swallowed |
| `mutex & abort` | two concurrent calls → second awaits first settlement, pre-aborted signal → throws `AbortError` on first step, mid-launch abort → cleanup runs + `youtube.cancel()` called |

### Priority 2 — `obsService.ts` ✅ Done

`src/services/__tests__/obsService.test.ts`

`obs-websocket-js` is mocked via `vi.hoisted` + `vi.mock`; the mock exposes
`__fire(event, ...args)` to drive OBS events from tests. `beforeEach` resets
mock call queues and calls `obsService.disconnect()` to return to a
`disconnected` baseline.

**What is covered:**

| Suite | Tests |
|---|---|
| `connect` | success → `connected` + listener notified, code 4009 → `error` + password message, ECONNREFUSED → `error` + localhost message, attempt while streaming → throw |
| `configureStreamService` | refuses when disconnected, refuses when streaming, refuses on empty rtmpUrl, refuses on empty streamKey, happy path → `SetStreamServiceSettings` with `rtmp_custom`, poll-verify timeout on `rtmp_common` type → YouTube-account-locked message, poll-verify timeout on server mismatch, poll-verify timeout on key mismatch |
| `assertActiveStreamServiceSettings` | type mismatch → throw, server mismatch → throw, key mismatch → throw, all match → resolves |
| `startStreaming` | `outputActive` flips true on second poll → `streaming`, never true within 5 s → throws modal-blocking message |
| `OBS event handlers` | `ConnectionClosed` from `connected` → `disconnected`, `ConnectionClosed` from `streaming` → `disconnected`, `StreamStateChanged(true)` → `streaming`, `StreamStateChanged(false)` → `connected`, `StreamStateChanged(true)` from `disconnected` → no-op |
| `health polling lifecycle` | starts on `streaming` transition (GetStreamStatus called), stops on exit from `streaming` + null notified to health listeners, bitrate ring buffer caps at 64 samples |
| `probe` | resolves `true` on WebSocket open, resolves `false` on timeout + closes socket, resolves `false` on error + closes socket |

### Priority 3 — `electron/youtube.ts` (open)

Key behaviors worth testing:

| Behavior | Test approach |
|---|---|
| `explainError` maps all known reason strings | Unit test with mock `Response` objects |
| `bindBroadcastToStream` — `boundStreamId` mismatch throws | Mock fetch returning wrong ID |
| `getStreamIngestionInfo` — item ID mismatch throws | Same |
| `createBroadcast` — best-effort `videos.update` failure doesn't fail the broadcast | Mock `videos.update` to throw; assert broadcast still returned |
| `waitForStreamActive` (in `youtubeService.ts`) — `active` status returns | Mock `getStreamStatus` to return `'active'` on second tick |
| `waitForStreamActive` — `error` status throws immediately | Mock returning `'error'` |
| `waitForStreamActive` — 90 s timeout throws | Fake timers |

**Challenge**: `electron/youtube.ts` calls `auth.getAccessToken()` on every
request. Tests need to `vi.mock('./auth', ...)` and stub `getAccessToken`.

### Priority 4 — `electron/auth.ts` (open)

The OAuth flow depends on external HTTP servers; full integration testing is
impractical. Candidate unit tests:

- PKCE verifier/challenge generation produces valid base64url output.
- State generation produces a non-empty, URL-safe string.
- `getAccessToken` dedup: two concurrent calls in the refresh window POST to
  the token endpoint exactly once.
- `refresh` response: `invalid_grant` → `tokenStore.clear()` called; `503` → cached tokens preserved, error thrown.
- `hasRequiredYouTubeScope` correctly handles missing, empty, and multi-scope strings.
- `callbackPage` HTML-escapes `error_description` before rendering it.

### Priority 5 — `settingsStore.ts` + `settingsContext.tsx` (open)

| Behavior | Test approach |
|---|---|
| `load()` merges disk payload with `DEFAULT_USER_SETTINGS` | Mock `safeStorage.decryptString`; assert merged output |
| `save()` round-trips through `safeStorage` | Assert `encryptString` called with serialized JSON |
| `SettingsProvider` optimistic save rollback | Mock `settingsService.save` to reject; assert context reverts to prior value |

### Priority 6 — `LaunchStatusScreen.tsx` (open)

The screen owns meaningful state (statuses map, details, fatalError,
cleanedUp) driven by `LaunchEvent`s from the orchestrator. A React Testing
Library suite that renders the screen with mock `runLaunchSequence` calls and
asserts UI state transitions would close the largest gap in the renderer layer.

## 4. Toolchain

Vitest and all required packages are already installed. No `npm install` is needed.

```
npm test                # run all tests once (CI mode)
npm run test:watch      # re-run on file changes
npm run test:coverage   # run + generate coverage report in coverage/
```

**`vitest.config.ts` key settings:**
- `environment: 'jsdom'` — gives renderer tests a browser-like DOM.
- `globals: true` — `vi`, `describe`, `it`, `expect` etc. are available without imports.
- `exclude: ['.claude/**']` — prevents agent worktrees from being collected.
- Coverage `include: ['src/services/**/*.ts']` — scoped to the service layer.

### Electron main process

Main-process code (`electron/`) uses Node-only APIs (`safeStorage`, `app.getPath`,
`crypto`, `http`) that are unavailable in jsdom. Options:

1. **Mock Electron**: `vi.mock('electron', () => ({ safeStorage: { ... }, app: { ... } }))`.
   Viable for unit tests of `tokenStore` and `settingsStore`.
2. **Extract pure functions**: Move `explainError`, `maskKey`, validation helpers,
   and identity assertions into framework-free modules. Recommended for `youtube.ts`.
3. **Skip initially**: The renderer services (already tested) are the higher-value
   targets; main-process unit tests are incremental.

### OBS WebSocket mocking pattern

The actual pattern used in `obsService.test.ts` — use `vi.hoisted` to expose
the mock instance before module load, then drive events via `__fire`:

```ts
const holder = vi.hoisted(() => ({ instance: null as MockObsHandle | null }));
vi.mock('obs-websocket-js', () => ({
  default: vi.fn().mockImplementation(() => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const handle = {
      connect: vi.fn(), call: vi.fn(), disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event, handler) => handlers.set(event, handler)), off: vi.fn(),
      __fire: (event, ...args) => handlers.get(event)?.(...args),
    };
    holder.instance = handle;
    return handle;
  }),
}));
```

### Component tests — React Testing Library (optional)

```bash
npm install -D @testing-library/react @testing-library/user-event
```

`jsdom` is already a devDependency. Component tests are lower priority than
service/logic tests. The main value is testing screen-level integration —
e.g., that `LaunchStatusScreen` correctly updates the ring and checklist given
a sequence of `LaunchEvent`s.

## 5. What not to test

- `applyAccent.ts` — pure function that writes CSS variables; only worth
  testing if the oklch triplets or token names change.
- `format.ts` — `capitalize`, `initialsOf`, `formatDuration` are simple
  enough to validate by inspection.
- Tailwind CSS output — tested by visual inspection.

## 6. E2E testing (future consideration)

[Playwright for Electron](https://playwright.dev/docs/api/class-electron)
supports testing the full packaged application including the main process.
An E2E test for the happy-path launch would require:
- A real YouTube test account with live streaming enabled.
- OBS running with a known configuration.
- A Google Cloud project in "Testing" mode.

This is high-cost / low-practical-value for the current team size. Skip
until the app ships to more than a handful of users.

## 7. Manual test checklist

Use this checklist for changes that touch auth, the launch flow, or OBS integration —
areas not yet covered by automated tests.

**Authentication:**
- [ ] Sign in (full OAuth flow, opens browser, returns to app)
- [ ] Sign out (removes user, returns to login screen)
- [ ] Token refresh (let the access token expire by manipulating `expiresAt` in `tokens.enc`, relaunch — should work without re-login)

**Launch flow:**
- [ ] Happy path: full 10-step launch with real YouTube + OBS
- [ ] Step 1 validation: try to launch with empty title, empty OBS password, >100 char title
- [ ] Step 7 fail: launch with wrong OBS password; verify cleanup emitted
- [ ] Step 8 fail: launch with YouTube account linked in OBS; verify error message
- [ ] Cancel mid-launch: start launch, click Back to setup; verify cleanup and no orphan broadcast on YouTube
- [ ] Double-click Go Live rapidly; verify only one broadcast created

**Settings:**
- [ ] Change each field; verify persists on relaunch
- [ ] Change accent; verify immediate visual update
- [ ] Toggle sidebar compact; verify sidebar collapses
- [ ] Reset to defaults; verify form resets

**OBS connection:**
- [ ] Test connection with correct password; verify success chip
- [ ] Test connection with wrong password; verify error message
- [ ] Test connection with OBS not running; verify error message

**Dashboard:**
- [ ] Bitrate chart fills while streaming
- [ ] End stream button stops OBS and updates status

**Keyboard shortcuts:**
- [ ] ⌘1 → Home, ⌘N → Create, ⌘H → Dashboard, ⌘, → Settings, ⌘\ → toggle sidebar
- [ ] Shortcuts don't fire when typing in an input field
