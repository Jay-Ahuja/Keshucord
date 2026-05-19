import type {
  StreamIngestionInfo,
  StreamSettings,
  YouTubeBroadcast,
  YouTubeLiveStream,
  YouTubeUser,
} from '../types';

// --- Session (real OAuth via main process) ---

export async function signIn(): Promise<YouTubeUser> {
  const user = await window.keshucord.auth.signIn();
  return decorate(user);
}

export async function signOut(): Promise<void> {
  await window.keshucord.auth.signOut();
}

export async function getCurrentUser(): Promise<YouTubeUser | null> {
  const user = await window.keshucord.auth.getCurrentUser();
  return user ? decorate(user) : null;
}

// --- YouTube Live Streaming API (real, via main process) ---

export async function createBroadcast(settings: StreamSettings): Promise<YouTubeBroadcast> {
  return window.keshucord.youtube.createBroadcast({
    title: settings.title,
    description: settings.description,
    privacyStatus: settings.privacy,
    category: settings.category || undefined,
  });
}

export async function createLiveStream(settings: StreamSettings): Promise<YouTubeLiveStream> {
  return window.keshucord.youtube.createLiveStream({
    title: settings.title || 'Keshucord live',
  });
}

export async function bindBroadcastToStream(
  broadcastId: string,
  streamId: string,
): Promise<void> {
  await window.keshucord.youtube.bindBroadcastToStream(broadcastId, streamId);
}

export async function getStreamIngestionInfo(streamId: string): Promise<StreamIngestionInfo> {
  return window.keshucord.youtube.getStreamIngestionInfo(streamId);
}

export async function getStreamStatus(streamId: string): Promise<string> {
  return window.keshucord.youtube.getStreamStatus(streamId);
}

/**
 * Poll liveStreams.list until YouTube reports the stream is `active`
 * (i.e. OBS is actually pushing bits we can transition on top of).
 */
export interface WaitForStreamActiveOptions {
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  onTick?: (info: { status: string; elapsedSeconds: number }) => void;
}

export async function waitForStreamActive(
  streamId: string,
  opts: WaitForStreamActiveOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const start = Date.now();
  const deadline = start + timeoutMs;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const status = await getStreamStatus(streamId);
    opts.onTick?.({ status, elapsedSeconds: Math.round((Date.now() - start) / 1000) });
    if (status === 'active') return;
    if (status === 'error') {
      throw new Error(
        'YouTube reports the stream is in an error state. Check OBS encoder settings (bitrate, codec) and try again.',
      );
    }
    await sleep(intervalMs, opts.signal);
  }

  throw new Error(
    "Timed out waiting for YouTube to receive video from OBS. Confirm OBS is actually streaming and that nothing is blocking RTMP (firewall, VPN, encoder error).",
  );
}

export async function deleteBroadcast(broadcastId: string): Promise<void> {
  await window.keshucord.youtube.deleteBroadcast(broadcastId);
}

export async function deleteLiveStream(streamId: string): Promise<void> {
  await window.keshucord.youtube.deleteLiveStream(streamId);
}

/**
 * Best-effort interrupt of any in-flight YouTube fetches running in the main
 * process. The launch orchestrator calls this when its AbortSignal fires so
 * that aborts don't have to wait out a stalled API request. Safe to call when
 * nothing is in flight (it's a no-op on the main side).
 */
export async function cancel(): Promise<void> {
  try {
    await window.keshucord.youtube.cancel();
  } catch (err) {
    // Cancel is best-effort at the orchestration level — if the IPC itself
    // fails, the in-flight fetches will still time out via the per-attempt
    // timeout in electron/youtube.ts. But we surface a warn here so a
    // genuinely broken cancel path isn't silently swallowed by the `void`
    // cast in launchService (where the .catch() previously erased any signal
    // of failure entirely).
    console.warn('[youtube] cancel IPC failed:', err);
    throw err;
  }
}

export async function transitionToLive(broadcast: YouTubeBroadcast): Promise<YouTubeBroadcast> {
  const updated = await window.keshucord.youtube.transitionToLive(broadcast.id);
  return {
    ...broadcast,
    status: updated.status,
    scheduledStartTime: updated.scheduledStartTime || broadcast.scheduledStartTime,
  };
}

export async function transitionToComplete(broadcastId: string): Promise<void> {
  await window.keshucord.youtube.transitionToComplete(broadcastId);
}

// --- helpers ---

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function decorate(user: YouTubeUser): YouTubeUser {
  return {
    ...user,
    avatarColor: user.avatarColor ?? pickAvatarColor(user.id || user.email || user.name),
  };
}

const AVATAR_PALETTE = [
  'from-brand-500 to-fuchsia-500',
  'from-sky-500 to-violet-500',
  'from-emerald-500 to-teal-500',
  'from-amber-500 to-rose-500',
  'from-indigo-500 to-pink-500',
];

function pickAvatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}
