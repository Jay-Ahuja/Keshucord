# Frontend System

> Renderer-process architecture. Read [`architecture.md`](./architecture.md)
> first for the main-process and IPC context.

## 1. UI architecture

The app is a single-window Electron renderer rendering one React tree. The
shell is a **CSS grid** matching the design's `.app` rule:

```
┌──────────────────────────────────────────────────────────────┐
│ TitleBar (36 px) — spans full width (grid-column: 1 / -1)    │
├──────────────────┬───────────────────────────────────────────┤
│                  │                                           │
│  Sidebar         │  Main                                     │
│  (232 px, 64 px  │  (1fr; .page or .login fills it)          │
│   when compact)  │                                           │
│                  │                                           │
└──────────────────┴───────────────────────────────────────────┘
```

The grid is declared in `src/styles/keshucord.css`:

```css
.app {
  display: grid;
  grid-template-columns: var(--sb-w) 1fr;
  grid-template-rows: 36px 1fr;
  height: 100vh;
}
.app.compact { --sb-w: var(--sb-w-compact); }   /* 232 px → 64 px */
```

`src/App.tsx` toggles the `.compact` class based on `userSettings.sidebarCompact`. When the user is signed-out (`screen === 'login'`) or the
app is still bootstrapping, the `<Sidebar />` is **not rendered** and the
`<main>` element gets `style={{ gridColumn: '1 / -1' }}` so the LoginScreen
gets the full viewport for its split-hero layout.

## 2. Screen hierarchy

```
App
├─ TitleBar                              (always — even login)
├─ Sidebar                               (only when signed in & not bootstrapping)
└─ main
   ├─ LoginScreen                        (.login full-bleed split)
   ├─ CreateScreen                       (.page two-col grid: form + side panel)
   ├─ LaunchStatusScreen                 (.page two-col grid: ring + checklist)
   ├─ DashScreen                         (.page two-col grid: preview/chart + KPIs)
   ├─ SettingsScreen                     (.page tabbed: .set-tabs + .set-section)
   ├─ PlaceholderScreen × 3              (home, history, help — empty-state cards)
   └─ Bootstrap spinner                  (during initial auth + settings load)
```

Every real screen except Login starts with a `.page-head` (title + sub +
right-side action buttons) and uses `.page`'s built-in `overflow-y: auto`
for internal scrolling. There is no global page scroll — the `.app` grid
locks the viewport height.

## 3. Routing / navigation

There is no router. Navigation is a `Screen` union in `App.tsx` state:

```ts
// src/types/app.ts
export type Screen =
  | 'login' | 'home' | 'create' | 'launch'
  | 'dash'  | 'history' | 'settings' | 'help';
```

| Trigger | Effect |
|---|---|
| Boot: `getCurrentUser()` resolves with a user | `setScreen('create')` |
| Boot: no user | `setScreen('login')` (default initial value) |
| LoginScreen success | `setScreen('create')` |
| CreateScreen submit | `setStreamSettings(next)` + `setScreen('launch')` |
| LaunchStatusScreen "Back to setup" / Cancel | `setScreen('create')` |
| LaunchStatusScreen "Open dashboard" | `setScreen('dash')` |
| Sidebar nav-item click | `setScreen(item.key)` |
| Sidebar `.acct` chip click | `handleSignOut()` → `setScreen('login')` |
| Keyboard shortcut ⌘1 / ⌘N / ⌘H / ⌘, | `setScreen('home' / 'create' / 'dash' / 'settings')` |
| Keyboard shortcut ⌘\ | `save({ sidebarCompact: !... })` — does not navigate |

Defensive route guards: `screen === 'create' && user` etc. — if `user` is
null, the screen renders nothing and `App.tsx`'s defensive fallback returns
`null`. In practice this shouldn't happen because the sidebar is hidden
when `user === null`.

### Keyboard shortcuts

Wired in `App.tsx`'s `useEffect`. The handler bails when the focused element
is an `<input>`, `<textarea>`, `<select>`, or `[contenteditable]`, so typing
a comma in a description doesn't open Settings. The one exception is `⌘\`,
which fires globally so the user can toggle the sidebar from anywhere.

## 4. Shared UI components

Everything in `src/components/`. None of these is large — each is
single-responsibility.

| Component | Used by | What it does |
|---|---|---|
| `TitleBar` | App (always) | 36 px top bar. Shows `Keshucord — <page>` left, LIVE chip + duration + version right. No traffic-light dots (Windows-first app). |
| `Sidebar` | App (when signed in) | Brand area (click toggles compact), Workspace nav, Account nav, status footer (YouTube + OBS + scene), avatar chip (click → sign out). |
| `IngestionInfoCard` | LaunchStatusScreen | Renders the broadcast watch URL, RTMP URL (Copy), and stream key (Show / Hide / Copy). Uses design's `.card.pad` shell. |
| `PlaceholderScreen` | App (home, history, help routes) | Honest empty state — `.page-head` + a `.card` with "Coming soon" copy. |
| `Spinner` | App bootstrap, SettingsScreen save indicator (none), CreateScreen test button | The **only** component still using Tailwind utility classes (`animate-spin`, sizing). Everything else is on the design CSS. |
| `Icons.tsx` | All screens | All SVG icons in one file. Stroke-based via the shared `strokeProps()` helper. Each icon takes a single `className` prop. |

There is **no** generic `Button` or `Card` wrapper. The design's
`.btn`/`.btn.primary`/`.btn.ghost`/`.btn.sm` etc. and `.card`/`.card.pad`/`.card.padL` are used directly via `className=`. This is intentional —
the abstraction wasn't earning its keep.

## 5. Responsive layout

The design's CSS handles breakpoints. The main `.create`, `.launch`, `.dash`,
and `.settings` grids all collapse from two columns to one below their
respective media-query thresholds (1000–1280 px depending on the screen).
The login splits → single pane below 1000 px.

There is no JS-side responsive logic. The shell layout is pure CSS Grid
and `@media` queries. The sidebar's compact mode is the **only** layout
state stored in React, and even that is just a `.compact` class on the
root element.

The bootstrap spinner is the one piece of layout that uses Tailwind utilities
(`flex flex-1 flex-col items-center justify-center gap-3 text-white/40`).
Everything else uses design CSS or inline `style={{}}` for one-off positioning.

## 6. Styling system

Loaded in this order (from `src/main.tsx`):

```ts
import './index.css';                  // Tailwind preflight + base anchors
import './styles/keshucord.css';       // Design tokens + component classes
```

Order matters — keshucord wins on any conflicting rule because it loads
last.

### `src/index.css`

About 25 lines. Tailwind preflight + utilities + a `:root` color-scheme +
the 100%-height anchors for `html / body / #root`. All the legacy
`.app-shell` / `.glass-card` / `.btn-primary` / `.field-*` rules from
earlier phases were stripped when the corresponding components migrated.

### `src/styles/keshucord.css`

1274 lines, ported verbatim from the design handoff. Imported once. Provides:

- `:root` oklch design tokens (see Theme below).
- Layout primitives: `.app`, `.titlebar`, `.sb`, `.main`, `.page`,
  `.page-head`, `.col`, `.row`, `.between`, `.flex1`, …
- Components: `.btn`, `.btn.primary`, `.btn.ghost`, `.btn.lg`, `.btn.sm`,
  `.btn.live-go`, `.card`, `.card.pad`, `.card.padL`, `.input`, `.textarea`,
  `.select`, `.seg`, `.switch`, `.chip`, `.chip.acc`, `.chip.ok`,
  `.chip.live`, `.kpi`, `.kpi.acc`, …
- Screen-specific: `.login`, `.create`, `.preset-bar`, `.thumb-drop`,
  `.privacy-radio`, `.launch`, `.launch-stage`, `.ring-*`, `.check-item`,
  `.dash`, `.preview-large`, `.bar-chart`, `.event-feed`, `.settings`,
  `.set-*`, `.theme-sw`, …
- Utilities: `.dot`, `.dot.ok`, `.dot.warn`, `.dot.err`, `.dot.live`,
  `.fadein`, `.fadein.d1`–`.d6`, `.mono`, `.dim`, `.gap-sm`, …

When you need a new component class, prefer adding to keshucord.css over
adding Tailwind utility soups. The CSS file is the source of truth for
visual styling.

## 7. Theme / color system

All colors are **oklch**. Defined as CSS variables on `:root`:

```css
--bg-0  ··· bg-4    Surface ladder (outer chrome → hover)
--fg / fg-mute / fg-dim / fg-ghost    Text scale
--acc / acc-hi / acc-lo               Wealthy purple accent
--acc-glow / acc-wash                 Translucent variants
--ok / warn / err / live              Semantic
--line-soft / line / line-strong      Border scale
```

The accent palette is runtime-swappable. `src/utils/applyAccent.ts` maps
`AppearanceAccent` ('purple' | 'cobalt' | 'ember' | 'mono') to oklch
triplets and writes them to `:root.style.--acc-*`. The Settings screen
calls this through `useSettings().save({ appearanceAccent: ... })`, and
`App.tsx`'s `useEffect` re-invokes `applyAccent` whenever
`userSettings.appearanceAccent` changes.

Every accent-aware class in keshucord.css uses `var(--acc)` /
`var(--acc-hi)` etc., so the swap propagates without re-render.

No light theme — the design is dark-only by spec. The `meta` color-scheme is
set in `:root { color-scheme: dark; }` so OS scrollbar dark-mode is honored.

## 8. Typography

Two fonts, both Google-hosted (preconnected in `index.html`):

- **Geist** — `--font-sans`. Weights 300–700.
- **Geist Mono** — `--font-mono`. Weights 400/500.

`tailwind.config.js` extends `fontFamily.sans` to start with Geist so the
single Tailwind utility (`text-white/40` on the bootstrap spinner) inherits
the same font as the rest of the app.

Body sets `font-feature-settings: "ss01", "cv11", "cv01"` in keshucord.css
to enable Geist's stylistic alternates.

Hierarchy:

| Token | Used for |
|---|---|
| `.page-title` (22 px, weight 600) | Per-screen H1 |
| `h3` inside `.card` (13 px, weight 500) | Card heading |
| Body (13–14 px) | Default paragraph text |
| `.hint`, captions (10.5–11 px) | Help text, monospace data lines |
| `.mono` | Numeric values, IDs, URLs |

The `.hero-title` on Login is a one-off at 46 px with a gradient-clipped
`<em>` span.

## 9. State management

Three layers, in order of scope:

### Module-scope (inside services)

Lives outside React entirely. Survives every mount/unmount.

- `obsService` holds: `status`, `lastHealth`, `bitrateHistory`, listener
  `Set`s, the poll timer, the prev-bytes/timestamp for bitrate Δ, and the
  WebSocket reference.
- `launchService` holds: `activeLaunch` promise + `activeAbort` controller
  (the serialization mutex).

Components subscribe via the small hooks in `src/utils/`:
`useObsStatus`, `useStreamHealth`, `useBitrateHistory`. Each is the same
6-line pattern — call the service's `getX()` for initial state, subscribe
inside `useEffect`, return the local state.

### React Context

One context — `SettingsProvider` in `src/utils/settingsContext.tsx` —
mounted in `src/main.tsx` above `<App />`. Provides `{ settings, loaded,
save, reset }`. `save` is **optimistic** (updates context state
synchronously, then persists in the background, re-loads from disk on
failure).

### Component / App state

`App.tsx` owns the cross-screen state:

```ts
const [authBootstrapping, setAuthBootstrapping] = useState(true);
const [screen, setScreen] = useState<Screen>('login');
const [user, setUser] = useState<YouTubeUser | null>(null);
const [streamSettings, setStreamSettings] = useState<StreamSettings>(...);
const [seededFromUserDefaults, setSeededFromUserDefaults] = useState(false);
```

`streamSettings` is lifted so the user can navigate Create ↔ Settings ↔
Launch without losing edits.

Per-screen state stays inside each screen for things that are truly local
(e.g. CreateScreen's `preset`/`thumbFilled`/`tags` UI-only mocks,
LaunchStatusScreen's launch-event-driven state, SettingsScreen's `tab`).

## 10. Loading / error state patterns

### Loading

| State | Pattern |
|---|---|
| Initial auth + settings load | Full-window centered spinner with "Loading session…" caption. Implemented in `App.tsx` bootstrap branch. |
| OAuth in flight | `LoginScreen` button shows `<Spinner size="sm" /> Waiting for browser…` and disables itself. |
| OBS test connection | `Test connection` button label flips to "Testing…", chip remains showing real obsStatus. |
| Launch step "active" | Step row turns purple with a pulsing ring; checklist sub-line shows live `step:detail` updates. |
| Stream-active polling | `go-live` step sub-line shows `YouTube reports stream "ready" — waiting (8s)…` ticking. |
| Dash bitrate buffer empty while streaming | Chart shows "collecting first samples…" inline empty state. |
| Settings auto-save in flight | Optimistic — UI doesn't show a loading state. Header chip shows `Saved · just now` after success or `Save failed` on error. |

### Error

| State | Pattern |
|---|---|
| Login OAuth error | Red `.fineprint` panel under the buttons with full message. Button re-enables. |
| Launch step fails | Red `.check-item.err` for the failing row + a red alert under the checklist with the full message + the cleanup-deleted-resources sub-line. Header CTA flips to "Back to setup". |
| OBS test connection fails | Red panel under the password field with the OBS-mapped error message ("Could not reach OBS …", "OBS rejected the password …", etc). |
| Settings save fails | Header chip flips to red `Save failed` with the message in the `title` attribute. Context auto-reloads canonical state from disk. |
| Dash End-stream fails | Red alert above the Connection rows in the Connection card. |

All error rendering uses inline elements (no toast system, no portal). This
keeps the error attached to the action that triggered it.

## 11. Animation philosophy

Only two CSS animation hooks:

- `.fadein` — opacity + 6 px translateY on mount, 400 ms ease-out. Used by
  every screen's root and many cards (`.card.pad.fadein.d2` etc., where
  `.d1`–`.d6` stagger by 50 ms each).
- `@keyframes pulse` (1.6 s) — used by `.dot.live` for the live indicator.

The launch ring's `.ring-fg` has a `transition: stroke-dashoffset 600ms
cubic-bezier(0.16, 1, 0.3, 1)`, which is responsible for the smooth ring
fill. No JS animation libraries.

The `Spinner` component uses Tailwind's `animate-spin`. That's the only
non-design-CSS animation.

If `userSettings.appearanceReduceMotion` is ever wired to CSS, the
expectation is a `.app[data-reduce-motion]` class that overrides these
keyframes with `animation: none` and the transition with `transition: none`.

## 12. Reusable component conventions

- **One file per component**, default export for screens, named exports for
  utilities/primitives.
- **Icons** all live in `src/components/Icons.tsx`. New icons go there.
  They take a single `className` prop, default size via that, currentColor
  for stroke.
- **No `Button`, `Card`, `Input` wrapper components.** Use the design's
  CSS classes directly (`<button className="btn primary">`, etc.). The
  inline `className=` is the API.
- **Form state** lives in the parent. Inputs are controlled. There is no
  form-state library.
- **Hooks naming**: `useX()` for context subscribers (`useObsStatus`,
  `useStreamHealth`, `useBitrateHistory`, `useSettings`). Each is ≤ 10 lines.
- **Services are namespace exports**. `import { obsService } from
  '../services'` → `obsService.connect(...)`. This makes intent explicit
  at the call site.

## 13. Frontend data flow

```
                             ┌──────────────────────────────┐
                             │  Main process                │
                             │  - auth tokens               │
                             │  - youtube API client        │
                             │  - settings.enc / tokens.enc │
                             └─────────────┬────────────────┘
                                           │
                              IPC bridge (preload exposes
                              window.keshucord.*)
                                           │
       ┌────────────────────────┬──────────┴──────────┬───────────────────────────┐
       │                        │                     │                           │
       ▼                        ▼                     ▼                           ▼
 youtubeService          settingsService        SettingsProvider          obsService
 (renderer facade)       (renderer facade)      (renderer Context)       (renderer-owned WebSocket)
       │                        │                     │                           │
       │                        │                     │                           │
       └──────────┬─────────────┴─────────────────────┘                           │
                  │                                                               │
                  ▼                                                               ▼
            launchService ◄────────── orchestrates ───────────► obsService + youtubeService
            (the only service                                   are also called directly by
             that calls every                                   screens for non-launch tasks
             other service)                                     (test connection, sign out, etc.)
                  │
                  ▼
            LaunchEvent stream
                  │
                  ▼
            LaunchStatusScreen renders ring + checklist + IngestionInfoCard
            using the events
```

Key invariants:

- **OAuth access tokens never reach the renderer.** Renderer-side
  `youtubeService` only ever calls IPC handlers.
- **The OBS WebSocket lives entirely in the renderer.** No IPC for OBS.
- **All persistent settings flow through `useSettings()`.** Direct calls
  to `settingsService.save` are only inside the Context provider.
- **`streamSettings` (the form) is separate from `userSettings` (defaults).**
  `userSettings` is the source of truth for defaults; `streamSettings` is
  seeded from it once on bootstrap (and on "Plan another stream") but is
  otherwise independent.
- **Every screen except Login mounts inside the same `.app` grid.** The
  grid never re-mounts. Only the `<main>`'s child swaps when `screen`
  changes.
- **`key={screen}` is intentionally not set** on the main child. This means
  screen→screen transitions keep child state if React happens to keep the
  same component type — but since each route is a different component
  function, React unmounts/remounts naturally. `LaunchStatusScreen` mounts
  fresh on every visit, which is why `runLaunchSequence` re-runs (and is
  protected by `launchService`'s mutex).
