import { useState } from 'react';
import { CheckIcon, KeyIcon, YouTubeIcon } from '../components/Icons';
import { Spinner } from '../components/Spinner';
import { youtubeService } from '../services';
import type { YouTubeUser } from '../types';

interface Props {
  onSignedIn: (user: YouTubeUser) => void;
}

const TRUST_ITEMS = [
  'OAuth · Google Verified',
  'End-to-end TLS',
  'Local-only stream keys',
  'No telemetry by default',
];

export default function LoginScreen({ onSignedIn }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const user = await youtubeService.signIn();
      onSignedIn(user);
      return; // parent advances the screen
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
      setBusy(false);
    }
  };

  const handleStreamKey = () => {
    // We only ship OAuth sign-in. The design surfaces a stream-key button as
    // a secondary CTA; rather than hide it (which changes the visual balance),
    // we keep it visible and explain the constraint when the user clicks.
    setError(
      'Stream-key auth is not supported in Keshucord. Use "Continue with YouTube" above — OAuth gives us the broadcasts API access we need.',
    );
  };

  return (
    <div className="login fadein">
      <div className="login-pane">
        <div className="grid-bg" />
        <div className="login-brand">
          <div className="brand-mark" />
          <div className="brand-text">
            <b>Keshucord</b>
            <span>Studio</span>
          </div>
        </div>

        <div className="hero-eyebrow">
          <span className="live-dot" /> One-click broadcast
        </div>
        <h1 className="hero-title">
          Go live on YouTube
          <br />
          in <em>under ten seconds</em>.
        </h1>
        <p className="hero-sub">
          Keshucord pairs your YouTube channel with OBS, dials in your scene, and opens the door
          to the world — without a checklist, without a tab to lose.
        </p>

        <div className="login-cta">
          <button
            type="button"
            className="btn primary lg"
            style={{ justifyContent: 'center' }}
            onClick={handleSignIn}
            disabled={busy}
          >
            {busy ? (
              <>
                <Spinner size="sm" /> Waiting for browser…
              </>
            ) : (
              <>
                <YouTubeIcon /> Continue with YouTube
              </>
            )}
          </button>
          <button
            type="button"
            className="btn ghost lg"
            style={{ justifyContent: 'center' }}
            onClick={handleStreamKey}
            disabled={busy}
          >
            <KeyIcon /> Sign in with stream key
          </button>

          {busy && (
            <div className="fineprint" style={{ color: 'var(--fg-mute)' }}>
              A browser window opened — complete the Google consent flow there. This window will
              continue automatically.
            </div>
          )}

          {error && !busy && (
            <div
              role="alert"
              className="fineprint"
              style={{
                color: 'oklch(0.86 0.14 22)',
                background: 'oklch(0.66 0.22 22 / 0.10)',
                border: '1px solid oklch(0.66 0.22 22 / 0.30)',
                borderRadius: 8,
                padding: '8px 10px',
                lineHeight: 1.5,
              }}
            >
              {error}
            </div>
          )}

          {!busy && !error && (
            <div className="fineprint">
              We never touch your password — auth is OAuth via Google. Scopes used: channel info,
              broadcasts, livestreams.
            </div>
          )}
        </div>

        <div className="trust-row">
          {TRUST_ITEMS.map((label) => (
            <div key={label} className="trust-item">
              <span className="check">
                <CheckIcon className="h-2.5 w-2.5" />
              </span>{' '}
              {label}
            </div>
          ))}
        </div>
      </div>

      <div className="login-art">
        <div className="grid-bg" />
        <div className="device">
          <div className="barr">
            <div className="d" />
            <div className="d" />
            <div className="d" />
          </div>
          <div className="body">
            <div className="left">
              <div className="ll a" />
              <div className="ll" />
              <div className="ll" />
              <div className="ll" />
              <div style={{ flex: 1 }} />
              <div className="ll" />
            </div>
            <div className="right">
              <div className="preview" />
              <div className="stats">
                <div />
                <div />
                <div />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
