interface IconProps {
  className?: string;
}

export function YouTubeIcon({ className = 'h-4 w-4' }: IconProps) {
  // Matches the Keshucord design's IconYT — a rounded rectangle with a
  // play-triangle "cut" out. Uses currentColor for the rectangle so it
  // tints to the surrounding button text, and the design's --bg-2 token
  // for the triangle so it reads as transparent on the primary button.
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" stroke="none">
      <rect x="2.5" y="6" width="19" height="12" rx="3.5" />
      <path d="M10.5 9.5 15 12l-4.5 2.5z" fill="var(--bg-2)" />
    </svg>
  );
}

export function KeyIcon({ className = 'h-3.5 w-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps()}>
      <circle cx="8" cy="12" r="4" />
      <path d="m12 12 8 0M18 10v4M20 12v3" />
    </svg>
  );
}

export function BoltIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
    </svg>
  );
}

export function CheckIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="3">
      <path d="m5 12 5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LockIcon({ className = 'h-3.5 w-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" strokeLinecap="round" />
    </svg>
  );
}

export function ObsIcon({ className = 'h-3.5 w-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </svg>
  );
}

export function PlugIcon({ className = 'h-3.5 w-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 7V3M15 7V3M7 11h10v2a5 5 0 0 1-5 5 5 5 0 0 1-5-5v-2ZM12 18v3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PlayIcon({ className = 'h-3.5 w-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M8 5v14l11-7L8 5Z" />
    </svg>
  );
}

export function StopIcon({ className = 'h-3.5 w-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  );
}

export function GearIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ---- Sidebar / titlebar icons (Keshucord redesign) ----
// Stroke icons — match the design's icons.jsx visually. Use `currentColor` so
// they inherit from the surrounding text color (e.g., the nav-item.active rule
// in keshucord.css colours the icn span via `color: var(--acc-hi)`).

function strokeProps(stroke = 1.6) {
  return {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: stroke,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
}

export function HomeIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps(1.5)}>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10v9h14v-9" />
    </svg>
  );
}

export function PlusIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps()}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function LiveIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps()}>
      <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
      <path d="M5.5 5.5a9 9 0 0 0 0 13M18.5 5.5a9 9 0 0 1 0 13" />
      <path d="M8 8a5 5 0 0 0 0 8M16 8a5 5 0 0 1 0 8" />
    </svg>
  );
}

export function DashIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps()}>
      <path d="M4 12a8 8 0 0 1 16 0" />
      <path d="m12 12 4-3" />
      <circle cx="12" cy="14" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function HistoryIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps()}>
      <path d="M12 8v4l3 2" />
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v4h4" />
    </svg>
  );
}

export function HelpIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps()}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.7" />
      <circle cx="12" cy="16.5" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function CmdIcon({ className = 'h-3 w-3' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps()}>
      <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z" />
    </svg>
  );
}

// `SettingsIcon` is the new alias for the existing GearIcon — the sidebar
// renders it as the Settings nav glyph.
export const SettingsIcon = GearIcon;

// ---- Create-screen icons ----

export function ArrowRightIcon({ className = 'h-3.5 w-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps()}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function ClockIcon({ className = 'h-3.5 w-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps()}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function LayersIcon({ className = 'h-3.5 w-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps()}>
      <path d="m12 4-9 5 9 5 9-5z" />
      <path d="m3 14 9 5 9-5" />
    </svg>
  );
}

export function SparkleIcon({ className = 'h-3.5 w-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps()}>
      <path d="M12 3v6M12 15v6M3 12h6M15 12h6" />
      <path d="m5.5 5.5 4 4M14.5 14.5l4 4M18.5 5.5l-4 4M9.5 14.5l-4 4" />
    </svg>
  );
}

export function UploadIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps(1.4)}>
      <path d="M12 16V5M7 10l5-5 5 5" />
      <path d="M5 19h14" />
    </svg>
  );
}

export function WifiIcon({ className = 'h-3.5 w-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps()}>
      <path d="M5 12a10 10 0 0 1 14 0" />
      <path d="M8.5 15.5a5 5 0 0 1 7 0" />
      <circle cx="12" cy="18.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

// ---- Dash-screen icons ----

export function PauseIcon({ className = 'h-3.5 w-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps()}>
      <path d="M8 5v14M16 5v14" />
    </svg>
  );
}

export function BellIcon({ className = 'h-3.5 w-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps()}>
      <path d="M6 9a6 6 0 0 1 12 0v4l2 3H4l2-3z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </svg>
  );
}

export function ExpandIcon({ className = 'h-3.5 w-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps()}>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>
  );
}

// ---- Settings-screen icons ----

export function ChipIcon({ className = 'h-3.5 w-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps()}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 3v3M12 3v3M15 3v3M9 18v3M12 18v3M15 18v3M3 9h3M3 12h3M3 15h3M18 9h3M18 12h3M18 15h3" />
    </svg>
  );
}

export function EyeIcon({ className = 'h-3 w-3' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps()}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
