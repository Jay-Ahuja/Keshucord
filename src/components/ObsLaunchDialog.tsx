import { useCallback, useEffect, useState } from 'react';
import { launchAndWait, ObsLaunchError } from '../services/obsService';
import { Spinner } from './Spinner';

/**
 * Internal state machine for the dialog.
 *
 *   prompt   → user just opened it; offered "Launch OBS" + "Cancel"
 *   launching → main process is spawning OBS + we're polling probe()
 *   error    → spawn failed or wait-for-reachable timed out; offers
 *              "Try again" + "Cancel"; the failure reason is shown verbatim
 *
 * Cancel from any state closes the dialog without surfacing an error.
 * Success from `launching` invokes `onLaunched` (CreateScreen advances to
 * the actual launch flow).
 */
type DialogState =
  | { kind: 'prompt' }
  | { kind: 'launching' }
  | { kind: 'error'; reason: string };

interface Props {
  /** Render the dialog when true; the host component owns this. */
  open: boolean;
  /** User dismissed the dialog (X / Cancel / backdrop click / Escape). */
  onClose: () => void;
  /** OBS became reachable — proceed with the original Go Live action. */
  onLaunched: () => void;
}

export function ObsLaunchDialog({ open, onClose, onLaunched }: Props) {
  const [state, setState] = useState<DialogState>({ kind: 'prompt' });

  // Reset to the prompt state every time the dialog is (re-)opened. Without
  // this, dismissing while in an error state would leave the next open
  // showing the stale error message.
  useEffect(() => {
    if (open) {
      setState({ kind: 'prompt' });
    }
  }, [open]);

  const handleLaunch = useCallback(async () => {
    setState({ kind: 'launching' });
    try {
      await launchAndWait();
      // Success — caller advances. We deliberately do NOT call onClose
      // here; the caller closes the dialog itself as part of its
      // post-launch transition (avoids a one-frame flicker between
      // dialog dismissal and screen change).
      onLaunched();
    } catch (err) {
      const reason =
        err instanceof ObsLaunchError
          ? err.reason
          : err instanceof Error
          ? err.message
          : 'Could not launch OBS.';
      setState({ kind: 'error', reason });
    }
  }, [onLaunched]);

  // Escape-to-cancel — only while NOT launching, so users can't abandon a
  // spawn that's already in flight (we have no way to cancel the child
  // process from the renderer).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && state.kind !== 'launching') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, state.kind, onClose]);

  if (!open) return null;

  const launching = state.kind === 'launching';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="obs-launch-dialog-title"
      onClick={(e) => {
        // Click on the backdrop (not bubbled from the inner card) closes —
        // again, only if we're not mid-launch.
        if (e.target === e.currentTarget && !launching) {
          onClose();
        }
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'oklch(0 0 0 / 0.55)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        className="card pad fadein"
        style={{
          width: '100%',
          maxWidth: 460,
          padding: 22,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <h3 id="obs-launch-dialog-title" style={{ margin: 0 }}>
          OBS Studio doesn't appear to be running. Launch OBS now?
        </h3>

        {state.kind === 'prompt' && (
          <p
            style={{
              margin: 0,
              fontSize: 12.5,
              color: 'var(--fg-mute)',
              lineHeight: 1.55,
            }}
          >
            Keshucord needs OBS open before it can configure your scene and start
            streaming. We'll launch it for you and wait for the WebSocket on
            <span className="mono" style={{ color: 'var(--fg)' }}>
              {' '}ws://localhost:4455
            </span>{' '}
            to come up.
          </p>
        )}

        {state.kind === 'launching' && (
          <div
            className="row"
            style={{
              gap: 10,
              fontSize: 12.5,
              color: 'var(--fg-mute)',
              lineHeight: 1.55,
            }}
          >
            <Spinner size="sm" />
            <span>Launching OBS and waiting for the WebSocket to accept connections…</span>
          </div>
        )}

        {state.kind === 'error' && (
          <div
            role="alert"
            className="fineprint"
            style={{
              color: 'oklch(0.86 0.14 22)',
              background: 'oklch(0.66 0.22 22 / 0.10)',
              border: '1px solid oklch(0.66 0.22 22 / 0.30)',
              borderRadius: 8,
              padding: '10px 12px',
              lineHeight: 1.55,
              fontSize: 12,
            }}
          >
            {state.reason}
          </div>
        )}

        <div
          className="row"
          style={{ justifyContent: 'flex-end', gap: 8, marginTop: 4 }}
        >
          <button
            type="button"
            className="btn ghost"
            onClick={onClose}
            disabled={launching}
            title={launching ? 'OBS is still launching — please wait.' : 'Close this dialog'}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={handleLaunch}
            disabled={launching}
            autoFocus
          >
            {launching ? (
              <>
                <Spinner size="sm" /> Launching…
              </>
            ) : state.kind === 'error' ? (
              'Try again'
            ) : (
              'Launch OBS'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
