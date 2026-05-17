# Testing

> Current testing posture, known gaps, and recommended testing strategy
> for the Keshucord codebase.

## 1. Current state

**There are no automated tests.** The project has no test runner, no
test files, and no testing packages in `package.json`. TypeScript
compilation (`tsc --noEmit`) and the Vite dev server are the only
automated quality checks that currently run.

This is a known gap. The sections below document the recommended strategy
for introducing tests to the codebase.

## 2. What TypeScript gives us today

TypeScript `strict: true` provides:
- Type-level contracts on all IPC payloads, service return types,
  and component props.
- Catch-at-compile-time: wrong argument types, missing fields in
  interface implementations, misused discriminated unions.

This is meaningful coverage but tests behavior, not types. Side effects,
async flows, and cross-system integration are not covered.

## 3. Highest-value test targets

Ranked by return on investment — the areas most likely to regress
silently without test coverage:

### Priority 1 — `launchService.ts` (unit/integration)

```
src/services/launchService.ts
```

The 10-step orchestrator is the most critical, most complex, and most
likely to break subtly. Key behaviors to test:

| Behavior | Test approach |
|---|---|
| All 10 steps run in order on success | Mock all service dependencies; assert step events in order |
| Step failure triggers cleanup of created resources | Mock steps 3–4 to succeed, step N to throw; assert `deleteBroadcast`/`deleteLiveStream` called |
| Abort mid-launch triggers cleanup | Start launch, abort signal; assert cleanup ran |
| Module-level mutex — second call awaits first | Start two concurrent launches; assert only one broadcast created |
| `broadcast-created` event emitted exactly once after step 3 | Assert event trace |
| `ingestion-ready` event emitted exactly once after step 6 | Assert event trace |
| `complete` event carries `status === 'live'` | Assert final broadcast shape |
| Validation rules (step 1) | Unit test `validateSettings()` directly |

**Recommended**: Vitest with manual mocks for `youtubeService` and
`obsService`. The services are imported as named exports from
`../services`, so they can be mocked with `vi.mock('../services')`.

### Priority 2 — `obsService.ts` (unit)

```
src/services/obsService.ts
```

The OBS service holds the most complex internal state machine. Key
behaviors:

| Behavior | Test approach |
|---|---|
| `connect()` → `connected` state on success | Mock `OBSWebSocket`, assert `status.state` |
| `connect()` → `error` state on fail | Assert `status.state` + error mapping |
| `configureStreamService()` poll-verify succeeds | Mock `obs.call` to return matching settings |
| `configureStreamService()` poll-verify times out | Mock `obs.call` to always return stale settings; assert timeout throw |
| `assertActiveStreamServiceSettings()` mismatch → throw | Mock `GetStreamServiceSettings` to return wrong values |
| `startStreaming()` `outputActive` poll succeeds | Mock `GetStreamStatus.outputActive: true` on second tick |
| `startStreaming()` `outputActive` never true → throw | Mock always returning `false`; assert timeout throw |
| Health polling starts when state → `streaming` | Assert `setInterval` called; assert health listeners notified |
| Health polling stops when state → not `streaming` | Assert `clearInterval` called; assert `notifyHealth(null)` |
| `ConnectionClosed` event → `disconnected` state | Fire event; assert status |
| `StreamStateChanged(true)` → `streaming` state | Fire event; assert status |

**Challenge**: `OBSWebSocket` from `obs-websocket-js` is instantiated at
module scope. Testing requires either mocking the module or testing via
the exported service functions only (preferred — avoids testing internals).

### Priority 3 — `electron/youtube.ts` (unit)

```
electron/youtube.ts
```

The API client has complex error mapping and identity assertions. Key
behaviors:

| Behavior | Test approach |
|---|---|
| `explainError` maps all known reason strings | Unit test with mock `Response` objects |
| `bindBroadcastToStream` — `boundStreamId` mismatch throws | Unit test with mock fetch returning wrong ID |
| `getStreamIngestionInfo` — item ID mismatch throws | Same |
| `createBroadcast` — best-effort `videos.update` failure doesn't fail the broadcast | Mock `videos.update` to throw; assert broadcast still returned |
| `waitForStreamActive` (in `youtubeService.ts`) — `active` status returns | Mock `getStreamStatus` to return `'active'` on second tick |
| `waitForStreamActive` — `error` status throws immediately | Mock `getStreamStatus` to return `'error'` |
| `waitForStreamActive` — timeout after 90 s throws | Use fake timers |

**Challenge**: `electron/youtube.ts` uses `auth.getAccessToken()` for
every call. Tests need to mock the `auth` module or use a test token.

### Priority 4 — `electron/auth.ts` (integration, optional)

The OAuth flow depends on external HTTP servers. A full integration test
is impractical without a test Google OAuth account + environment.
Candidate unit tests:

- PKCE verifier/challenge generation is correctly base64url-encoded.
- State generation produces a non-empty, URL-safe string.
- `explainError` (token refresh path) handles non-OK responses.

### Priority 5 — `settingsStore.ts` + `settingsContext.tsx` (unit)

| Behavior | Test approach |
|---|---|
| `load()` merges disk payload with defaults | Mock `safeStorage.decryptString`; assert merged output |
| `save()` sanitizes invalid field values | Call with bad values; assert normalized output |
| `SettingsProvider` optimistic save rollback | Mock `settingsService.save` to reject; assert context reverts |

## 4. Recommended toolchain

### Test runner — Vitest

```bash
npm install -D vitest @vitest/coverage-v8
```

Vitest integrates directly with the Vite config, requires no separate
babel transform, and shares TypeScript config with the renderer build.
Add to `package.json`:

```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage"
}
```

### Electron main process

Main-process code (`electron/`) cannot run inside Vitest's JSDOM or
happy-dom environments. Options:

1. **Refactor to pure functions**: Extract `explainError`, `maskKey`,
   validation helpers, and identity assertion logic into framework-free
   modules that can be tested without Electron APIs. This is the
   recommended path — these are the most valuable tests.
2. **Mock Electron**: Use `vi.mock('electron', ...)` to stub `safeStorage`,
   `app.getPath`, etc. Viable but requires careful maintenance.
3. **Skip electron/ tests initially**: Focus first on the renderer
   services which have no Electron dependency.

### OBS WebSocket

```bash
npm install -D @types/ws
```

For `obsService` tests, mock `obs-websocket-js` entirely:

```ts
vi.mock('obs-websocket-js', () => ({
  default: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    call: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  })),
}));
```

### Component tests — React Testing Library (optional)

```bash
npm install -D @testing-library/react @testing-library/user-event jsdom
```

Component tests are lower priority than service/logic tests. The main
value would be testing screen-level integration: e.g., that
`LaunchStatusScreen` correctly updates the ring and checklist given a
sequence of `LaunchEvent`s.

## 5. What not to test

- `delay.ts` — dead code, slated for deletion.
- `applyAccent.ts` — pure function that writes CSS variables; test only
  if the oklch triplets change.
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

Until automated tests exist, verify the following before significant
changes:

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
