import { useState } from 'react';
import type { StreamIngestionInfo, YouTubeBroadcast } from '../types';

interface Props {
  broadcast?: YouTubeBroadcast | null;
  ingestion?: StreamIngestionInfo | null;
}

export function IngestionInfoCard({ broadcast, ingestion }: Props) {
  if (!broadcast && !ingestion) return null;

  return (
    <div className="card pad">
      <h3>
        YouTube ingestion <span className="tag">credential-grade</span>
      </h3>
      <div className="col" style={{ gap: 10 }}>
        {broadcast && (
          <IngestionRow label="Broadcast">
            <a
              href={broadcast.watchUrl}
              target="_blank"
              rel="noreferrer"
              className="mono"
              style={{
                color: 'var(--acc-hi)',
                textDecoration: 'none',
                wordBreak: 'break-all',
                fontSize: 11.5,
              }}
            >
              {broadcast.watchUrl}
            </a>
          </IngestionRow>
        )}
        {ingestion && (
          <>
            <IngestionRow label="RTMP URL">
              <CopyableValue value={ingestion.rtmpUrl} />
            </IngestionRow>
            <IngestionRow label="Stream key">
              <SecretValue value={ingestion.streamKey} />
            </IngestionRow>
            {ingestion.backupRtmpUrl && (
              <IngestionRow label="Backup URL">
                <CopyableValue value={ingestion.backupRtmpUrl} />
              </IngestionRow>
            )}
          </>
        )}
      </div>
      <p
        style={{
          fontSize: 11,
          color: 'var(--fg-ghost)',
          marginTop: 14,
          lineHeight: 1.5,
        }}
      >
        These credentials are live on YouTube. Anyone with the stream key can broadcast as you —
        treat it like a password.
      </p>
    </div>
  );
}

function IngestionRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        borderRadius: 8,
        border: '1px solid var(--line-soft)',
        background: 'var(--bg-2)',
        padding: '8px 10px',
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          color: 'var(--fg-dim)',
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      <div style={{ marginTop: 4 }}>{children}</div>
    </div>
  );
}

function CopyableValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };
  return (
    <div className="row" style={{ gap: 8 }}>
      <span
        className="mono flex1"
        style={{
          fontSize: 11.5,
          color: 'var(--fg-mute)',
          wordBreak: 'break-all',
          minWidth: 0,
        }}
      >
        {value}
      </span>
      <button type="button" className="btn sm" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function SecretValue({ value }: { value: string }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };
  return (
    <div className="row" style={{ gap: 8 }}>
      <span
        className="mono flex1"
        style={{
          fontSize: 11.5,
          color: 'var(--fg-mute)',
          wordBreak: 'break-all',
          minWidth: 0,
        }}
      >
        {shown ? value : '•'.repeat(Math.min(value.length, 28))}
      </span>
      <button type="button" className="btn sm ghost" onClick={() => setShown((s) => !s)}>
        {shown ? 'Hide' : 'Show'}
      </button>
      <button type="button" className="btn sm" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
