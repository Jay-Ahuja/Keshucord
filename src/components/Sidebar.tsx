import {
  DashIcon,
  HelpIcon,
  HistoryIcon,
  HomeIcon,
  PlusIcon,
  SettingsIcon,
  SignOutIcon,
} from './Icons';
import type { OBSConnectionState, OBSConnectionStatus, Screen, YouTubeUser } from '../types';
import { initialsOf } from '../utils/format';

interface NavItem {
  key: Screen;
  label: string;
  Icon: (props: { className?: string }) => JSX.Element;
  kbd?: string;
  liveAware?: boolean;
}

// 'launch' is intentionally absent: it's a transient state owned by the
// Create → Launch → Dash flow, not a destination the user navigates to.
// The Screen union still contains 'launch' so route guards in App.tsx keep
// working; we just don't surface a sidebar entry for it.
const NAV_PRIMARY: NavItem[] = [
  { key: 'home', label: 'Overview', Icon: HomeIcon, kbd: '⌘1' },
  { key: 'create', label: 'New Stream', Icon: PlusIcon, kbd: '⌘N' },
  { key: 'dash', label: 'Stream Health', Icon: DashIcon, kbd: '⌘H', liveAware: true },
  { key: 'history', label: 'History', Icon: HistoryIcon },
];

const NAV_BOTTOM: NavItem[] = [
  { key: 'settings', label: 'Settings', Icon: SettingsIcon, kbd: '⌘,' },
  { key: 'help', label: 'Help & Docs', Icon: HelpIcon },
];

interface Props {
  page: Screen;
  onNavigate: (next: Screen) => void;
  onToggleCompact: () => void;
  onSignOut: () => void;
  user: YouTubeUser;
  obsStatus: OBSConnectionStatus;
}

function obsStatusLabel(state: OBSConnectionState): string {
  switch (state) {
    case 'connected':
      return ':4455';
    case 'streaming':
      return 'streaming';
    case 'connecting':
      return 'connecting…';
    case 'error':
      return 'error';
    default:
      return 'disconnected';
  }
}

function obsStatusDotClass(state: OBSConnectionState): string {
  switch (state) {
    case 'connected':
    case 'streaming':
      return 'dot ok';
    case 'connecting':
      return 'dot warn';
    case 'error':
      return 'dot err';
    default:
      return 'dot';
  }
}

export function Sidebar({
  page,
  onNavigate,
  onToggleCompact,
  onSignOut,
  user,
  obsStatus,
}: Props) {
  const isLive = obsStatus.state === 'streaming';
  const obsConnected = obsStatus.state === 'connected' || obsStatus.state === 'streaming';

  return (
    <aside className="sb">
      <div
        className="brand"
        onClick={onToggleCompact}
        style={{ cursor: 'pointer' }}
        title="Toggle sidebar"
      >
        <div className="brand-mark"></div>
        <div className="brand-text">
          <b>Keshucord</b>
          <span>Studio · 1.0</span>
        </div>
      </div>

      <div className="nav-section">
        <div className="nav-label">Workspace</div>
        {NAV_PRIMARY.map((item) => (
          <NavRow
            key={item.key}
            item={item}
            active={page === item.key}
            isLive={isLive}
            onClick={() => onNavigate(item.key)}
          />
        ))}
      </div>

      <div className="nav-section">
        <div className="nav-label">Account</div>
        {NAV_BOTTOM.map((item) => (
          <NavRow
            key={item.key}
            item={item}
            active={page === item.key}
            isLive={isLive}
            onClick={() => onNavigate(item.key)}
          />
        ))}
      </div>

      <div className="sb-footer">
        <div className="sb-status">
          <div className="row">
            <span className="dot ok"></span>
            <span className="label">YouTube</span>
            <span style={{ color: 'var(--fg-mute)' }}>
              {user.channel || 'Connected'}
            </span>
          </div>
          <div className="row">
            <span className={obsStatusDotClass(obsStatus.state)}></span>
            <span className="label">OBS WebSocket</span>
            <span style={{ color: 'var(--fg-mute)' }}>{obsStatusLabel(obsStatus.state)}</span>
          </div>
          {obsConnected && obsStatus.currentScene && (
            <div className="row">
              <span className="dot ok"></span>
              <span className="label">Scene</span>
              <span style={{ color: 'var(--fg-mute)' }}>{obsStatus.currentScene}</span>
            </div>
          )}
        </div>
        {/*
          The profile area is now a non-interactive display. Sign-out lives
          on the dedicated `.btn.ghost.icon.sm` button alongside it. The
          inline `cursor` + `background` overrides defeat `.acct`'s
          interactive treatment (cursor: pointer + hover bg from
          keshucord.css §account) without modifying the design system
          stylesheet.
        */}
        <div
          className="acct"
          aria-label={`Signed in as ${user.name}`}
          style={{ cursor: 'default', background: 'transparent' }}
        >
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt=""
              className="avatar"
              referrerPolicy="no-referrer"
              style={{ objectFit: 'cover' }}
            />
          ) : (
            <div
              className="avatar"
              style={{
                display: 'grid',
                placeItems: 'center',
                fontSize: 10.5,
                fontWeight: 600,
                color: 'var(--fg)',
              }}
            >
              {initialsOf(user.name)}
            </div>
          )}
          <div className="meta">
            <b>{user.name}</b>
            <span>{user.email}</span>
          </div>
          <button
            type="button"
            className="btn ghost icon sm"
            onClick={onSignOut}
            title="Sign out"
            aria-label="Sign out"
            style={{ marginLeft: 'auto', flexShrink: 0 }}
          >
            <SignOutIcon />
          </button>
        </div>
      </div>
    </aside>
  );
}

function NavRow({
  item,
  active,
  isLive,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  isLive: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className={'nav-item' + (active ? ' active' : '')}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <span className="icn">
        <item.Icon />
      </span>
      <span className="label">{item.label}</span>
      {item.liveAware && isLive ? (
        <span className="dot live" style={{ marginLeft: 'auto' }}></span>
      ) : (
        item.kbd && <kbd>{item.kbd}</kbd>
      )}
    </div>
  );
}
