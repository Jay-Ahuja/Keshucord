import { CmdIcon } from './Icons';
import type { Screen } from '../types';

const PAGE_TITLE: Record<Screen, string> = {
  login: 'Welcome',
  home: 'Overview',
  create: 'New Stream',
  launch: 'Going Live',
  dash: 'Stream Health',
  history: 'History',
  settings: 'Settings',
  help: 'Help',
};

interface Props {
  page: Screen;
  isLive?: boolean;
  liveDuration?: string;
}

export function TitleBar({ page, isLive, liveDuration }: Props) {
  return (
    <div className="titlebar">
      {/* The design's macOS-style "traffic lights" are decorative; on Windows
          they would be misleading, so we drop them and reserve a small spacer
          to keep the title aligned with the sidebar's brand block below. */}
      <div style={{ width: 6 }} />
      <div className="tb-title">
        <b>Keshucord</b>
        <span style={{ color: 'var(--fg-ghost)' }}>—</span>
        <span>{PAGE_TITLE[page]}</span>
      </div>
      <div className="tb-right">
        {isLive && (
          <span className="chip live">
            <span className="dot live"></span>
            LIVE{liveDuration ? ` · ${liveDuration}` : ''}
          </span>
        )}
        <div className="cmd-hint" title="Command palette (coming soon)">
          <CmdIcon /> <span>K</span>
        </div>
        <span style={{ opacity: 0.5 }}>v0.1 · preview</span>
      </div>
    </div>
  );
}
