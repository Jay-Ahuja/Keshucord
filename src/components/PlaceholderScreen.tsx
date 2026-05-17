interface Props {
  title: string;
  subtitle?: string;
}

/**
 * Renders an explicit "Coming soon" `.page` for sidebar routes that exist in
 * the Keshucord redesign but haven't been migrated yet (Overview, Stream
 * Health, History, Help). Per the integration plan, no fake data — when a
 * screen has no real backing yet, we show an honest empty state and the
 * shell stays usable.
 */
export function PlaceholderScreen({ title, subtitle }: Props) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">{title}</div>
          <div className="page-sub">{subtitle ?? 'Coming in a follow-up step.'}</div>
        </div>
      </div>
      <div className="card pad" style={{ maxWidth: 520 }}>
        <h3>Coming soon</h3>
        <p style={{ fontSize: 13, color: 'var(--fg-mute)', lineHeight: 1.55 }}>
          This screen is part of the Keshucord redesign rollout. The shell + navigation are in
          place — content lands in a follow-up step.
        </p>
      </div>
    </div>
  );
}
