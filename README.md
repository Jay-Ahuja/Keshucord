# Keshucord

Launch a YouTube live stream in one click. A Windows-first Electron desktop
app that automates the "go live on YouTube via OBS" workflow: sign into your
Google account, fill out a stream form, click **Go Live**, and the app
provisions the YouTube broadcast, configures OBS Studio over its WebSocket,
starts the RTMP push, waits for YouTube to receive video, and transitions
the broadcast to LIVE.

A live dashboard surfaces OBS telemetry while streaming. Settings persist
locally and encrypted (Electron `safeStorage` / OS keychain).

## Stack
- Electron 34 (main process owns OAuth, secrets, YouTube API client)
- React 18 + TypeScript 5 (renderer)
- Vite 5 (bundler)
- Vitest 2 + jsdom (tests; CI runs on Linux / macOS / Windows, Node 22)
- `obs-websocket-js` v5 (OBS WebSocket from the renderer)
- Hand-written CSS design system (`src/styles/keshucord.css`) + Tailwind preflight

## Prerequisites
- Node.js 20–22 (per `package.json` `engines`)
- OBS Studio with the built-in WebSocket Server enabled on port 4455
- A Google Cloud project with the YouTube Data API v3 enabled and a Desktop
  OAuth client. See [`docs/oauth-setup.md`](docs/oauth-setup.md) for the full
  step-by-step. Copy `.env.example` to `.env` and fill in
  `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

## Develop

```bash
npm install
npm run dev
```

`npm run dev` runs Vite on `localhost:5173` and launches Electron pointed at
it. The renderer hot-reloads; the main process rebuilds on demand.

## Build

```bash
npm run build           # tsc + vite build (renderer + main)
npm start               # launch the built app via Electron
npm run build:installer # produce a distributable via electron-builder
```

## Test

```bash
npm run test            # run all suites once (CI mode)
npm run test:watch      # re-run on file changes
npm run test:coverage   # HTML coverage report in coverage/
```

Test posture, coverage matrix, and known gaps:
[`docs/testing.md`](docs/testing.md).

## Screens
- **Login** — `src/screens/LoginScreen.tsx`
- **Create** (stream setup) — `src/screens/CreateScreen.tsx`
- **Launch status** — `src/screens/LaunchStatusScreen.tsx`
- **Dashboard** (live telemetry) — `src/screens/DashScreen.tsx`
- **Settings** — `src/screens/SettingsScreen.tsx`

## Documentation
- [`docs/architecture.md`](docs/architecture.md) — canonical architecture
  reference (main/preload/renderer split, lifecycle, services). Updated in
  the same commit as any subsystem change.
- [`docs/launch-flow.md`](docs/launch-flow.md) — the 10-step orchestrator.
- [`docs/obs-flow.md`](docs/obs-flow.md) — OBS WebSocket subsystem.
- [`docs/youtube-flow.md`](docs/youtube-flow.md) — YouTube Data API client.
- [`docs/electron-ipc.md`](docs/electron-ipc.md) — IPC channel reference.
- [`docs/settings-system.md`](docs/settings-system.md) — settings persistence.
- [`docs/oauth-setup.md`](docs/oauth-setup.md) — Google Cloud setup.
- [`docs/error-catalog.md`](docs/error-catalog.md) — user-facing error
  messages and their causes.
- [`docs/known-issues.md`](docs/known-issues.md) — current bugs, stubs,
  intentional limitations.
- [`docs/development.md`](docs/development.md) — onboarding and contributor
  guide.
- [`docs/testing.md`](docs/testing.md) — current test coverage and gaps.

## License
MIT
