# Design System

> Visual language, token system, component classes, and styling
> conventions for Keshucord. Read alongside
> [`frontend-system.md`](./frontend-system.md) for layout and state
> context.

## 1. Source file

All design tokens and component classes live in one file:

```
src/styles/keshucord.css    1274 lines, imported once in src/main.tsx
```

It is loaded after `src/index.css` (Tailwind preflight) so it wins on
every conflicting rule. When a visual change is needed, **edit
`keshucord.css`**, not `index.css` or a Tailwind config.

Tailwind's role is limited to:
- Preflight reset (from `index.css`).
- `animate-spin`, sizing utilities, and `text-white/40` used by the
  `Spinner` component (`src/components/Spinner.tsx`) — the only remaining
  Tailwind consumer in the app.

## 2. Design tokens (CSS variables on `:root`)

All colors are **oklch**. Variables are set on `:root` and read by every
component class. The accent sub-palette is runtime-swappable (see §6).

### Surface ladder

| Variable | Role |
|---|---|
| `--bg-0` | Outermost chrome (titlebar background, deep sidebar) |
| `--bg-1` | Primary page background |
| `--bg-2` | Cards, panels |
| `--bg-3` | Hover state background |
| `--bg-4` | Active/selected state background |

### Text scale

| Variable | Role |
|---|---|
| `--fg` | Primary body text |
| `--fg-mute` | Secondary text, labels |
| `--fg-dim` | Placeholder, disabled, hint text |
| `--fg-ghost` | Very subdued — divider labels, empty states |

### Accent palette (mutable at runtime)

| Variable | Role |
|---|---|
| `--acc` | Primary accent (button backgrounds, active states, ring fill) |
| `--acc-hi` | Lighter accent for highlights |
| `--acc-lo` | Darker accent for pressed states |
| `--acc-glow` | Translucent accent for shadows/glows |
| `--acc-wash` | Very translucent accent for selection washes |

### Semantic colors

| Variable | Role |
|---|---|
| `--ok` | Success, connected, live dot green |
| `--warn` | Warning states |
| `--err` | Error states, red banners |
| `--live` | YouTube live red |

### Border scale

| Variable | Role |
|---|---|
| `--line-soft` | Subtle dividers, card borders at rest |
| `--line` | Default border |
| `--line-strong` | Emphasized border, input focus ring |

### Layout constants

| Variable | Value | Role |
|---|---|---|
| `--sb-w` | 232 px | Expanded sidebar width |
| `--sb-w-compact` | 64 px | Collapsed sidebar width |
| `--titlebar-h` | 36 px | Fixed top bar height |
| `--radius` | (varies per component) | Card / input border radius |
| `--font-sans` | `'Geist', system-ui, sans-serif` | Body font stack |
| `--font-mono` | `'Geist Mono', monospace` | Monospace (keys, IDs, URLs) |

## 3. Typography

Two Google-hosted fonts preconnected in `index.html`:

| Font | Variable | Weights | Used for |
|---|---|---|---|
| Geist | `--font-sans` | 300–700 | All body text, labels, headings |
| Geist Mono | `--font-mono` | 400, 500 | Numeric values, IDs, RTMP URLs, stream keys |

Body sets `font-feature-settings: "ss01", "cv11", "cv01"` to activate
Geist's stylistic alternates (cleaner `l`, `1`, `0`).

### Typographic hierarchy

| Class / element | Size | Weight | Used for |
|---|---|---|---|
| `.hero-title` | 46 px | 700 | Login screen H1 (one-off) |
| `.page-title` | 22 px | 600 | Per-screen title in `.page-head` |
| `h3` inside `.card` | 13 px | 500 | Card section headings |
| Body default | 13–14 px | 400 | Paragraph text, form labels |
| `.hint`, captions | 10.5–11 px | 400 | Help text, timestamp chips |
| `.mono` | inherits | 500 | Monospace data (apply via className) |

The `.hero-title` has a gradient-clipped `<em>` child for the brand
color treatment on "Keshucord". Do not replicate this pattern elsewhere.

## 4. Layout primitives

### App shell

```css
.app {
  display: grid;
  grid-template-columns: var(--sb-w) 1fr;
  grid-template-rows: 36px 1fr;
  height: 100vh;
}
.app.compact { --sb-w: var(--sb-w-compact); }
```

`.compact` is toggled by `App.tsx` based on `userSettings.sidebarCompact`.

### Page wrapper

```
.page        — overflow-y: auto, internal scroll
.page-head   — title + sub + right-aligned CTA buttons
.page-title  — h1 inside .page-head
```

Every screen except Login uses `.page` + `.page-head`.

### Utility classes

| Class | What it does |
|---|---|
| `.col` | `display: flex; flex-direction: column` |
| `.row` | `display: flex; flex-direction: row; align-items: center` |
| `.between` | `.row` + `justify-content: space-between` |
| `.flex1` | `flex: 1` |
| `.gap-sm` | Small gap between flex children |
| `.dim` | Lower opacity — used for muted/secondary text |
| `.mono` | Applies `--font-mono` |
| `.fadein` | Entrance animation (see §8) |
| `.fadein.d1`–`.d6` | Staggered entrance delays (50 ms each) |

## 5. Component classes

### Buttons

```css
.btn           — base: padding, border-radius, font, transition
.btn.primary   — accent fill background
.btn.ghost     — transparent, border on hover
.btn.lg        — larger padding / font size
.btn.sm        — smaller padding / font size
.btn.live-go   — special: the "Go Live" CTA (larger, accent gradient)
```

Usage pattern: `<button className="btn primary">`. There is no React
`Button` wrapper component.

### Cards

```css
.card          — surface bg, border, border-radius
.card.pad      — adds padding
.card.padL     — larger padding (used in Settings tab content)
```

Usage: `<div className="card pad">`. No React `Card` wrapper.

### Form controls

```css
.input         — text input styling
.textarea      — textarea styling (also used via `.input` in some places)
.select        — select element
.seg           — segmented control (3-button Privacy picker)
.switch        — toggle switch (boolean settings)
```

All are styled exclusively via className. There are no controlled React
wrapper components for these. Form state lives in the parent component.

### Status chips

```css
.chip          — base chip: small, rounded, inline
.chip.acc      — accent-colored chip
.chip.ok       — success green chip
.chip.live     — YouTube-live red chip
```

### Status dots

```css
.dot           — small circle indicator
.dot.ok        — green (connected, active)
.dot.warn      — yellow (degraded)
.dot.err       — red (error)
.dot.live      — red + pulsing animation (live dot)
```

### KPI tiles

```css
.kpi           — metric tile: number + label
.kpi.acc       — accent-colored KPI (highlighted metric)
```

Used in `DashScreen` for bitrate, FPS, dropped frames, latency.

### Checklist (launch flow)

```css
.check-item          — step row: icon + label + detail sub-line
.check-item.active   — purple, pulsing state (step in progress)
.check-item.done     — green checkmark
.check-item.err      — red X (step failed)
.check-item.pending  — muted (not yet reached)
```

### Launch ring

```css
.ring-bg     — background track circle (SVG stroke)
.ring-fg     — progress arc (SVG stroke, dashoffset animated)
```

`stroke-dashoffset` has a `transition: 600ms cubic-bezier(0.16, 1, 0.3, 1)`
for the smooth sweep animation. JS calculates the offset from
`pct = doneCount / 10 * 100`.

### Preset bar

```css
.preset-bar    — horizontal scrollable preset chip row on CreateScreen
```

### Privacy radio

```css
.privacy-radio  — 3-option icon-radio group on CreateScreen
```

### Event feed

```css
.event-feed    — DashScreen live event log card (currently empty state)
```

### Bar chart

```css
.bar-chart     — DashScreen bitrate history chart container
```

## 6. Accent system

Four accent palettes, each a triplet of oklch values for `--acc` /
`--acc-hi` / `--acc-lo` plus matching `--acc-glow` / `--acc-wash`:

| Name | Token | Hue | Character |
|---|---|---|---|
| `purple` | default | ~285° oklch | Wealthy purple (design default) |
| `cobalt` | `cobalt` | ~255° oklch | Blue |
| `ember` | `ember` | ~25° oklch | Orange-red |
| `mono` | `mono` | L=0.5, C=0 | Greyscale (no hue) |

`src/utils/applyAccent.ts` maps the `AppearanceAccent` union to the
corresponding oklch triplets and writes them to `:root.style`.

`App.tsx` calls `applyAccent(userSettings.appearanceAccent)` inside a
`useEffect` on every `appearanceAccent` change. On boot, this fires after
first paint — a single-frame flash of the default purple accent is
possible if the stored accent differs.

Every accent-aware class in `keshucord.css` references `var(--acc)` etc.,
so the swap is CSS-only and does not require a re-render.

To add a new accent:
1. Add the name to `AppearanceAccent` union in `src/types/settings.ts`.
2. Add the oklch mapping in `src/utils/applyAccent.ts`.
3. Add the swatch in `SettingsScreen.tsx` → Appearance tab.
4. Add normalize guard in `electron/settingsStore.ts` `normalizeAccent`.

## 7. Screen-specific layout classes

Each screen has its own grid class:

| Class | Screen | Layout |
|---|---|---|
| `.login` | `LoginScreen` | Split-hero: 1fr left (brand) / 1fr right (form). Collapses to single pane below 1000 px. |
| `.create` | `CreateScreen` | Two-col: form (left) / side panel (right). Collapses below 1100 px. |
| `.launch` | `LaunchStatusScreen` | Two-col: ring + checklist (left) / ingestion card (right). Collapses below 1000 px. |
| `.dash` | `DashScreen` | Two-col: preview + chart (left) / KPIs + event feed (right). Collapses below 1280 px. |
| `.settings` | `SettingsScreen` | 200 px sticky tab rail (left) / content (right). |

All responsive behavior is **CSS-only** — no JS breakpoint detection.

## 8. Animation

Two animation primitives, nothing else:

### `.fadein` — mount entrance

```css
@keyframes fadein {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
.fadein { animation: fadein 400ms ease-out both; }
.fadein.d1 { animation-delay: 50ms; }
.fadein.d2 { animation-delay: 100ms; }
/* … up to .d6 at 300ms */
```

Applied to screen roots and card groups to stagger entrance. Example:
`<div className="card pad fadein d2">`.

### `.dot.live` — pulse

```css
@keyframes pulse { … }
.dot.live { animation: pulse 1.6s ease-in-out infinite; }
```

The red live indicator in the Sidebar status footer and TitleBar.

### Launch ring fill

Not a CSS animation — a `stroke-dashoffset` transition:

```css
.ring-fg { transition: stroke-dashoffset 600ms cubic-bezier(0.16, 1, 0.3, 1); }
```

### Spinner

`Spinner.tsx` uses Tailwind's `animate-spin`. It's the only component not
using the design CSS for animation.

### Planned but not implemented

`userSettings.appearanceReduceMotion` is persisted and editable but no
CSS gate exists. The intended approach is a `.app[data-reduce-motion]`
selector that sets `animation: none` and `transition: none` on all
animation hooks above.

## 9. Color scheme

Dark-only. `:root { color-scheme: dark; }` is set in `keshucord.css` so
the OS scrollbar and system UI chrome honor dark mode automatically. No
light-mode variants exist and none are planned in the current design.

## 10. Adding a new component class

When a new visual pattern appears in more than one place:

1. Add the rule to `keshucord.css` under a clearly labeled section comment.
2. Reference it via `className=` in the component(s).
3. Do **not** create a React wrapper component unless the behavior is
   complex enough to warrant it (i.e., a stateful compound component).
   The raw `className=` API is intentional.

When a pattern appears only once, prefer an inline `style={{}}` or a
one-off `className` in the component file.

Do **not** add Tailwind utility soup to new components. The only Tailwind
survivors are in `Spinner.tsx` — a historical accident being gradually
cleaned up.

## 11. Known dead / unimplemented surface

| Item | File | Status |
|---|---|---|
| `tailwind.config.js` `brand-*` / `ink-*` palette | `tailwind.config.js` | Dead — Tailwind purges unused classes, so no bundle impact, but the config block is stale. |
| `appearanceDensity: 'compact'` | `keshucord.css` | Token persists and is editable in Settings, but no `compact` density variant CSS exists. |
| `appearanceReduceMotion` | `keshucord.css` | Persists, editable, no CSS gate. Wiring: add `.app[data-reduce-motion]` selector. |
| Window glass setting | `SettingsScreen.tsx` | UI toggle renders as disabled. No CSS implementation. |
