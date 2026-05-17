# Keshucord

Launch a YouTube live stream in one click. Frontend-only prototype (no YouTube OAuth or OBS wiring yet — all interactions use mocked data and fake delays).

## Stack
- Electron
- React 18 + TypeScript
- Tailwind CSS
- Vite

## Develop

```bash
npm install
npm run dev
```

`npm run dev` runs Vite on `localhost:5173` and launches Electron pointed at it.

## Build

```bash
npm run build
npm start
```

## Screens
- **Login** — `src/screens/LoginScreen.tsx`
- **Stream setup** — `src/screens/StreamSetupScreen.tsx`
- **Launch status** — `src/screens/LaunchStatusScreen.tsx`
