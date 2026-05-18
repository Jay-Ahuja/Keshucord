# Development Guide

> Local setup, build pipeline, debugging workflow, and dev conventions
> for Keshucord. Start here for onboarding.

## 1. Prerequisites

| Tool | Minimum version | Purpose |
|---|---|---|
| Node.js | 20 LTS | Runtime for build toolchain + Electron |
| npm | Ships with Node | Package manager |
| OBS Studio | 28+ | Target WebSocket server (port 4455). WebSocket server is enabled by default in v28+. |
| A Google account | n/a | For YouTube OAuth sign-in during development |

**Windows is the primary target.** macOS works. Linux works if `libsecret`
is installed (provides the `safeStorage` backend for `settings.enc` and
`tokens.enc`). iOS / Android are not targets.

## 2. Google Cloud setup

Before the app will authenticate, you need a Google Cloud OAuth 2.0
**Desktop app** client. Full instructions are in
[`docs/oauth-setup.md`](./oauth-setup.md). Short version:

1. Create a project at <https://console.cloud.google.com>.
2. Enable the **YouTube Data API v3**.
3. Create an OAuth 2.0 client ID for a **Desktop app**.
4. Copy the `client_id` and `client_secret` — you'll put them in `.env`.
5. Under "OAuth consent screen → Test users", add your Google account.
   While the app is in "Testing" mode only listed accounts can sign in.

## 3. Environment file

Create a `.env` file at the project root (same directory as `package.json`):

```
GOOGLE_CLIENT_ID=your_client_id_here.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret_here
```

This file is `.gitignore`d and never committed. It is read by `dotenv`
in the main process (`import 'dotenv/config'` at the top of
`electron/main.ts`). The renderer never sees these values.

If either variable is missing at sign-in time, `electron/auth.ts` throws:
```
Google OAuth is not configured. Create a Desktop OAuth client in Google
Cloud Console and set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in
Keshucord/.env. See docs/oauth-setup.md.
```

## 4. Install and start

```bash
npm install
npm run dev
```

`npm run dev` runs two processes concurrently (via the `concurrently`
package):

| Process | Command | What it does |
|---|---|---|
| `vite` | `npm run dev:vite` | Starts the Vite dev server on `http://localhost:5173` (HMR enabled) |
| `electron` | `npm run dev:electron` | Waits for port 5173 to be ready (`wait-on`), compiles `electron/*.ts` → `dist-electron/*.js`, then launches `electron .` |

The window opens automatically. DevTools open in a detached window
(`openDevTools({ mode: 'detach' })`).

**Hot reload**: The renderer (React) gets HMR from Vite. Changes to
`electron/` require restarting the `electron` process — the `concurrently`
`-k` flag kills both on `Ctrl+C`, then re-run `npm run dev`.

## 5. Build

```bash
npm run build          # renderer (Vite) + electron (tsc)
npm run build:renderer # just the Vite bundle → dist/
npm run build:electron # just the electron tsc → dist-electron/
```

Two tsconfig files:
- `tsconfig.json` — renderer (React + DOM libs, includes `src/`)
- `tsconfig.electron.json` — main process + preload (Node libs, includes
  `electron/`, targets `dist-electron/`)

No packaging step is wired up yet (no electron-builder or electron-forge
config). To run a production build locally:

```bash
npm run build
npm start           # runs electron . which loads dist/index.html
```

### Running tests

```bash
npm run test            # one-shot Vitest run (used in CI)
npm run test:watch      # interactive watch mode
npm run test:coverage   # one-shot run + v8 coverage report (text + html)
```

Vitest reads `tsconfig.json` directly and runs under jsdom. See
[`docs/testing.md`](./testing.md) for the current test inventory and
recommended targets for new suites.

## 6. Project structure (quick map)

```
Keshucord/
├── electron/            Main process source (TypeScript)
│   ├── main.ts          Window creation, app lifecycle
│   ├── ipc.ts           ipcMain.handle registrations
│   ├── preload.ts       contextBridge → window.keshucord
│   ├── auth.ts          PKCE + loopback OAuth, token refresh
│   ├── tokenStore.ts    tokens.enc read/write/clear
│   ├── settingsStore.ts settings.enc read/write/reset
│   └── youtube.ts       YouTube Data API v3 client
├── src/                 Renderer source (React + TypeScript)
│   ├── App.tsx          Root state machine + routing
│   ├── main.tsx         React entry point
│   ├── components/      Shared UI primitives
│   ├── screens/         One file per screen
│   ├── services/        Renderer-side service layer
│   ├── types/           Pure type declarations
│   └── utils/           Hooks + small helpers
├── docs/                Engineering documentation
├── dist/                Vite output (renderer bundle)
├── dist-electron/       tsc output (main process + preload)
├── .env                 Local secrets (not committed)
├── index.html           HTML shell
├── package.json
├── tsconfig.json        Renderer tsconfig
├── tsconfig.electron.json  Electron tsconfig
└── vite.config.ts       Vite bundler config
```

## 7. OBS setup for development

1. Install OBS Studio 28+.
2. Open OBS → Tools → WebSocket Server Settings.
3. Enable the WebSocket server (default: port 4455).
4. Copy the password shown in "Show Connect Info".
5. Paste the password into Keshucord's Settings → Connections →
   WebSocket password field.
6. Optionally: create a scene named something recognizable — Keshucord
   shows the current scene name in the sidebar status footer.

The app will fail at the `connect-obs` launch step (step 7) if OBS is
not running or the password is wrong. Run the full launch in dev to
exercise the OBS path; use "Test connection" in Settings to sanity-check
the WebSocket password independently.

## 8. Data locations

All persistent data is encrypted via Electron's `safeStorage`:

| File | Location (Windows) | Location (macOS) |
|---|---|---|
| `tokens.enc` | `%APPDATA%\Keshucord\tokens.enc` | `~/Library/Application Support/Keshucord/tokens.enc` |
| `settings.enc` | `%APPDATA%\Keshucord\settings.enc` | `~/Library/Application Support/Keshucord/settings.enc` |

To fully reset the app state during development:
1. Sign out from Settings → YouTube Account → Sign out (clears
   `tokens.enc` + revokes the refresh token).
2. Reset settings from Settings → Advanced → Reset to defaults (clears
   `settings.enc`).
3. Or: delete the files directly from the filesystem while the app is
   closed. On next launch the app treats it as a fresh install.

**Warning**: `safeStorage`-encrypted blobs are bound to the OS user
account and machine key derivation. A blob copied to another machine
will not decrypt.

## 9. Debugging workflows

### Console logs

The app uses namespace-prefixed `console.info` for all service logs:

| Prefix | Where | What |
|---|---|---|
| `[launch]` | `src/services/launchService.ts` | Step lifecycle, broadcast/stream IDs |
| `[obs]` | `src/services/obsService.ts` | WebSocket calls, stream service state, health polling |
| `[youtube]` | `electron/youtube.ts` (main process) | API calls, masked stream keys |

OBS and launch logs appear in the **renderer DevTools** console (the
detached window). YouTube logs appear in the **main process terminal**
(the `npm run dev` terminal window).

### Diagnosing a failed launch

1. Open the detached DevTools (opens automatically in dev).
2. Look for the last `[launch] step:start <stepId>` without a matching
   `step:done` — that's the failing step.
3. For `configure-obs` / `start-stream` failures, find the `pre-StartStream
   OBS state:` log line and compare `keyTail` vs `expectedKeyTail`. A
   mismatch means OBS's YouTube account integration is overriding the
   stream key. Fix: OBS → Settings → Stream → disconnect YouTube account.
4. For `go-live` failures, check the YouTube API error reason in the main
   process terminal.

See [`launch-flow.md`](./launch-flow.md) §14 for the full canonical log
trace.

### Testing OBS independently

Settings → Connections → Test connection triggers `obsService.testConnection(password)` — a single-attempt connect (no retries) that
immediately disconnects on success. Useful for validating the password
without going through a full launch.

### Testing YouTube sign-in

Sign out from Settings → YouTube Account → Sign out, then sign back in
from the Login screen. This exercises the full PKCE loopback OAuth flow.
Watch the main process terminal for `[youtube]` logs confirming the
token exchange.

## 10. TypeScript configuration

Two tsconfig targets:

**`tsconfig.json`** (renderer):
- `target: "ES2020"`, `module: "ESNext"`
- `lib: ["ES2020", "DOM", "DOM.Iterable"]`
- Includes: `src/`

**`tsconfig.electron.json`** (main process + preload):
- `target: "ES2022"`, `module: "CommonJS"`
- `lib: ["ES2022"]`
- Outdir: `dist-electron/`
- Includes: `electron/`

Both have `strict: true`. New code should compile with zero TypeScript
errors. There is no `ts-ignore` in the current codebase.

## 11. Adding a new screen

1. Create `src/screens/YourScreen.tsx`. Default export a React component.
2. Add the screen's key to the `Screen` union in `src/types/app.ts`.
3. Add the `case 'yourscreen': return <YourScreen … />;` branch in
   `App.tsx`'s main render switch.
4. Add a nav item in `Sidebar.tsx`'s `NAV_ITEMS` array if it needs
   sidebar navigation.
5. Optionally: wire a keyboard shortcut in `App.tsx`'s `useEffect`
   shortcut handler.

No router is needed — navigation is purely `setScreen(key)` calls.

## 12. Adding a new IPC channel

See [`electron-ipc.md`](./electron-ipc.md) §8 for the four-file checklist.

## 13. Adding a new settings field

See [`settings-system.md`](./settings-system.md) §8 for the four-file
checklist and merge strategy.

## 14. Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| App opens but shows "Google OAuth is not configured" | `.env` missing or wrong variable names | Create/fix `.env` — see §3 |
| Sign-in opens browser but never returns | Loopback server blocked by firewall or antivirus | Temporarily disable AV; the loopback is `127.0.0.1:<random port>` |
| Sign-in succeeds in browser but app shows error | Google OAuth consent screen not past "Testing" status, or your account not in Test users | Add account to Test users in Google Cloud Console |
| OBS test connection fails with "Could not reach OBS" | OBS not running or WebSocket server not enabled | Open OBS, enable WebSocket server (Tools → WebSocket Server Settings) |
| OBS test connection fails with "OBS rejected the password" | Password mismatch | Copy password from OBS → Tools → WebSocket Server Settings → Show Connect Info |
| Renderer DevTools not opening | `openDevTools` is only called in dev mode | Make sure `NODE_ENV=development` is set — `npm run dev` sets it via `cross-env` |
| `settings.enc` decryption failure after reinstalling the app | DPAPI key changed (Windows: new user profile or OS reinstall) | Delete `settings.enc` manually; app falls back to defaults |
| `npm run dev` hangs waiting for port 5173 | Vite process failed to start | Check the `vite` concurrent output for a compilation error |
