import * as auth from './auth';

const API_BASE = 'https://www.googleapis.com/youtube/v3';

// Retry config for transient (network / 5xx / 429 / timeout) failures.
// Only applied to *idempotent* operations — see CallInit.idempotent below.
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 200; // 200 → 400 → 800 with jitter
const PER_ATTEMPT_TIMEOUT_MS = 20_000;

// Internal retry for `getStreamIngestionInfo` when YouTube reports the stream
// resource exists but its `cdn.ingestionInfo` isn't populated yet — a brief
// post-`liveStreams.insert` race that resolves within a few seconds.
const INGESTION_RETRY_ATTEMPTS = 5;
const INGESTION_RETRY_DELAY_MS = 1000;

function log(...args: unknown[]) {
  console.info('[youtube]', ...args);
}

/** Mask a stream key in logs so we don't leak credentials to terminal/file logs. */
function maskKey(key: string | undefined | null): string {
  if (!key) return '<empty>';
  return `<${key.length}-char key ending …${key.slice(-4)}>`;
}

// ---- In-flight operation registry ----
//
// AbortSignal can't be serialized across IPC, so the renderer-side launch
// orchestrator can't directly pass its signal into these main-process calls.
// Instead, every top-level operation here registers its own AbortController
// in `activeOperations`. The renderer fires `youtube:cancel` (see ipc.ts)
// when its launch is aborted — that calls `cancelAllInFlight()` here, which
// aborts every registered controller. The next per-attempt timeout / retry
// check in `call()` will then unwind the operation.

const activeOperations = new Set<AbortController>();

async function withOperationAbort<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  activeOperations.add(controller);
  try {
    return await fn(controller.signal);
  } finally {
    activeOperations.delete(controller);
  }
}

export function cancelAllInFlight(): void {
  if (activeOperations.size === 0) return;
  log(`cancelAllInFlight: aborting ${activeOperations.size} in-flight operation(s)`);
  for (const c of activeOperations) c.abort();
  // Don't clear here — each registered op clears itself in its finally block.
}

export type Privacy = 'public' | 'unlisted' | 'private';

export interface CreateBroadcastInput {
  title: string;
  description?: string;
  privacyStatus: Privacy;
  category?: string;
}

export interface CreateLiveStreamInput {
  title: string;
}

export interface YouTubeBroadcastDTO {
  id: string;
  title: string;
  description: string;
  privacy: Privacy;
  category: string;
  status: string;
  watchUrl: string;
  scheduledStartTime: string;
  boundStreamId?: string;
}

export interface YouTubeLiveStreamDTO {
  id: string;
  title: string;
}

export interface StreamIngestionInfoDTO {
  streamId: string;
  streamKey: string;
  rtmpUrl: string;
  backupRtmpUrl?: string;
}

// ---- liveBroadcasts.insert ----

export async function createBroadcast(input: CreateBroadcastInput): Promise<YouTubeBroadcastDTO> {
  return withOperationAbort(async (signal) => {
    log(
      `createBroadcast: title="${input.title}", privacy=${input.privacyStatus}, category=${input.category ?? '<none>'}`,
    );
    const scheduledStartTime = new Date(Date.now() + 30_000).toISOString();
    const body = {
      snippet: {
        title: input.title,
        description: input.description ?? '',
        scheduledStartTime,
      },
      contentDetails: {
        enableAutoStart: false,
        enableAutoStop: false,
        enableDvr: true,
        monitorStream: { enableMonitorStream: false },
        latencyPreference: 'low',
      },
      status: {
        privacyStatus: input.privacyStatus,
        selfDeclaredMadeForKids: false,
      },
    };

    // POST insert is NOT marked idempotent — a transient 5xx after YouTube has
    // already accepted the request would otherwise produce a duplicate broadcast.
    const data = await call<{
      id: string;
      snippet: { title: string; description: string };
      status: { lifeCycleStatus: string };
    }>(`${API_BASE}/liveBroadcasts?part=snippet,contentDetails,status`, {
      method: 'POST',
      body,
      signal,
    });

    if (!data.id) {
      throw new Error('YouTube returned no broadcast id from liveBroadcasts.insert.');
    }
    log(`createBroadcast → returned broadcast id: ${data.id}`);

    if (input.category) {
      await setCategoryBestEffort(data.id, {
        title: input.title,
        description: input.description ?? '',
        category: input.category,
        signal,
      });
    }

    return {
      id: data.id,
      title: data.snippet.title,
      description: data.snippet.description,
      privacy: input.privacyStatus,
      category: input.category ?? '',
      status: data.status.lifeCycleStatus,
      watchUrl: `https://www.youtube.com/watch?v=${data.id}`,
      scheduledStartTime,
    };
  });
}

// ---- liveStreams.insert ----

export async function createLiveStream(input: CreateLiveStreamInput): Promise<YouTubeLiveStreamDTO> {
  return withOperationAbort(async (signal) => {
    log('createLiveStream:', { title: input.title });
    const body = {
      snippet: {
        title: input.title || 'Keshucord live',
      },
      cdn: {
        frameRate: 'variable',
        ingestionType: 'rtmp',
        resolution: 'variable',
      },
      contentDetails: {
        isReusable: false,
      },
    };

    // POST insert: also not idempotent.
    const data = await call<{ id: string; snippet: { title: string } }>(
      `${API_BASE}/liveStreams?part=snippet,cdn,contentDetails`,
      { method: 'POST', body, signal },
    );

    if (!data.id) {
      throw new Error('YouTube returned no stream id from liveStreams.insert.');
    }
    log('createLiveStream → returned stream id:', data.id);
    return { id: data.id, title: data.snippet.title };
  });
}

// ---- liveBroadcasts.bind ----

export async function bindBroadcastToStream(
  broadcastId: string,
  streamId: string,
): Promise<{ broadcastId: string; streamId: string }> {
  return withOperationAbort(async (signal) => {
    log(`bindBroadcastToStream: broadcast=${broadcastId} stream=${streamId}`);
    const url = new URL(`${API_BASE}/liveBroadcasts/bind`);
    url.searchParams.set('part', 'id,contentDetails');
    url.searchParams.set('id', broadcastId);
    url.searchParams.set('streamId', streamId);

    // bind is idempotent: calling it again with the same broadcast/stream pair
    // produces the same result on YouTube's side. Safe to retry on 5xx/429.
    const data = await call<{ id: string; contentDetails?: { boundStreamId?: string } }>(
      url.toString(),
      { method: 'POST', idempotent: true, signal },
    );

    const boundStreamId = data.contentDetails?.boundStreamId;
    log(`bindBroadcastToStream → broadcast=${data.id} boundStreamId=${boundStreamId ?? '<none>'}`);

    if (data.id !== broadcastId) {
      throw new Error(
        `Bind response is for broadcast ${data.id} but we asked to bind ${broadcastId}. Aborting to avoid streaming to the wrong destination.`,
      );
    }
    if (!boundStreamId) {
      throw new Error(
        `YouTube returned no boundStreamId for broadcast ${broadcastId} — the stream and broadcast are not linked.`,
      );
    }
    if (boundStreamId !== streamId) {
      throw new Error(
        `Broadcast ${broadcastId} was bound to stream ${boundStreamId} but we provisioned stream ${streamId}. Aborting to avoid streaming to the wrong destination.`,
      );
    }
    return { broadcastId: data.id, streamId: boundStreamId };
  });
}

// ---- liveStreams.list (status only) ----

export async function getStreamStatus(streamId: string): Promise<string> {
  return withOperationAbort(async (signal) => {
    const url = new URL(`${API_BASE}/liveStreams`);
    url.searchParams.set('part', 'status');
    url.searchParams.set('id', streamId);

    // GET — fully idempotent, retry on transient failure.
    const data = await call<{
      items?: { id: string; status?: { streamStatus?: string } }[];
    }>(url.toString(), { method: 'GET', idempotent: true, signal });

    const status = data.items?.[0]?.status?.streamStatus;
    if (!status) {
      throw new Error(`Could not read status for stream ${streamId}.`);
    }
    return status;
  });
}

// ---- liveBroadcasts.transition ----

export async function transitionToLive(broadcastId: string): Promise<YouTubeBroadcastDTO> {
  return withOperationAbort(async (signal) => {
    log(`transitionToLive: broadcast=${broadcastId}`);
    const url = new URL(`${API_BASE}/liveBroadcasts/transition`);
    url.searchParams.set('part', 'snippet,status,contentDetails');
    url.searchParams.set('broadcastStatus', 'live');
    url.searchParams.set('id', broadcastId);

    // transition is idempotent at the application layer (YouTube returns
    // `redundantTransition` if already in the requested state). Retry-on-503 is
    // safe; we surface redundantTransition via explainError if it leaks through.
    const data = await call<{
      id: string;
      snippet: { title: string; description: string; scheduledStartTime: string };
      status: { lifeCycleStatus: string; privacyStatus: Privacy };
      contentDetails?: { boundStreamId?: string };
    }>(url.toString(), { method: 'POST', idempotent: true, signal });

    if (!data.id) {
      throw new Error('YouTube returned no broadcast id from liveBroadcasts.transition.');
    }
    log(`transitionToLive → broadcast=${data.id} lifeCycleStatus=${data.status.lifeCycleStatus}`);
    return {
      id: data.id,
      title: data.snippet.title,
      description: data.snippet.description,
      privacy: data.status.privacyStatus,
      category: '',
      status: data.status.lifeCycleStatus,
      watchUrl: `https://www.youtube.com/watch?v=${data.id}`,
      scheduledStartTime: data.snippet.scheduledStartTime,
      boundStreamId: data.contentDetails?.boundStreamId,
    };
  });
}

export async function transitionToComplete(broadcastId: string): Promise<void> {
  return withOperationAbort(async (signal) => {
    log(`transitionToComplete: broadcast=${broadcastId}`);
    const url = new URL(`${API_BASE}/liveBroadcasts/transition`);
    url.searchParams.set('part', 'id,status');
    url.searchParams.set('broadcastStatus', 'complete');
    url.searchParams.set('id', broadcastId);

    // transition is idempotent at the application layer (YouTube returns
    // `redundantTransition` if already in the requested state — i.e. a user
    // double-clicking End Stream). Retry-on-503 is safe; we surface
    // redundantTransition via explainError if it leaks through.
    const data = await call<{
      id: string;
      status?: { lifeCycleStatus?: string };
    }>(url.toString(), { method: 'POST', idempotent: true, signal });

    if (!data.id) {
      throw new Error('YouTube returned no broadcast id from liveBroadcasts.transition.');
    }
    log(
      `transitionToComplete → broadcast=${data.id} lifeCycleStatus=${data.status?.lifeCycleStatus ?? '<unknown>'}`,
    );
  });
}

// ---- liveBroadcasts.delete / liveStreams.delete ----

export async function deleteBroadcast(broadcastId: string): Promise<void> {
  return withOperationAbort(async (signal) => {
    log(`deleteBroadcast: ${broadcastId}`);
    const url = new URL(`${API_BASE}/liveBroadcasts`);
    url.searchParams.set('id', broadcastId);
    await callDelete(url.toString(), signal);
  });
}

export async function deleteLiveStream(streamId: string): Promise<void> {
  return withOperationAbort(async (signal) => {
    log(`deleteLiveStream: ${streamId}`);
    const url = new URL(`${API_BASE}/liveStreams`);
    url.searchParams.set('id', streamId);
    await callDelete(url.toString(), signal);
  });
}

// ---- liveStreams.list (ingestion info) ----

export async function getStreamIngestionInfo(streamId: string): Promise<StreamIngestionInfoDTO> {
  return withOperationAbort(async (signal) => {
    log(`getStreamIngestionInfo: streamId=${streamId}`);
    const url = new URL(`${API_BASE}/liveStreams`);
    url.searchParams.set('part', 'cdn,status');
    url.searchParams.set('id', streamId);

    // YouTube briefly returns a stream resource without `cdn.ingestionInfo`
    // immediately after `liveStreams.insert`. Retry the *inner* readiness check
    // a handful of times before giving up — this is the most common transient
    // launch failure in practice.
    let lastWaitMessage = '';
    for (let attempt = 1; attempt <= INGESTION_RETRY_ATTEMPTS; attempt++) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const data = await call<{
        items?: {
          id: string;
          cdn?: {
            ingestionInfo?: {
              streamName?: string;
              ingestionAddress?: string;
              backupIngestionAddress?: string;
              rtmpsIngestionAddress?: string;
              rtmpsBackupIngestionAddress?: string;
            };
          };
        }[];
      }>(url.toString(), { method: 'GET', idempotent: true, signal });

      const item = data.items?.[0];
      if (!item) {
        throw new Error(`YouTube returned no liveStream for id ${streamId}.`);
      }
      if (item.id !== streamId) {
        // Defensive — guards against any pagination/cache weirdness where the API
        // could return a different stream than the one we requested. Without this
        // we could potentially fetch ingestion info from the wrong stream entirely.
        throw new Error(
          `Asked YouTube for stream ${streamId} but got ${item.id}. Aborting to avoid using the wrong stream key.`,
        );
      }

      const info = item.cdn?.ingestionInfo;
      if (info?.streamName && info.ingestionAddress) {
        const result: StreamIngestionInfoDTO = {
          streamId: item.id,
          streamKey: info.streamName,
          // Prefer RTMPS when available — most ingest configs support it and it's encrypted.
          rtmpUrl: info.rtmpsIngestionAddress ?? info.ingestionAddress,
          backupRtmpUrl: info.rtmpsBackupIngestionAddress ?? info.backupIngestionAddress,
        };
        log('getStreamIngestionInfo →', {
          streamId: result.streamId,
          rtmpUrl: result.rtmpUrl,
          backupRtmpUrl: result.backupRtmpUrl,
          streamKey: maskKey(result.streamKey),
          attempts: attempt,
        });
        return result;
      }

      lastWaitMessage = info
        ? 'ingestionInfo present but missing streamName/ingestionAddress'
        : 'ingestionInfo absent';
      if (attempt < INGESTION_RETRY_ATTEMPTS) {
        log(
          `getStreamIngestionInfo: ${lastWaitMessage} — retrying in ${INGESTION_RETRY_DELAY_MS}ms (attempt ${attempt}/${INGESTION_RETRY_ATTEMPTS})`,
        );
        await sleep(INGESTION_RETRY_DELAY_MS, signal);
      }
    }

    throw new Error(
      `Stream ${streamId} does not have ingestion info available yet after ${INGESTION_RETRY_ATTEMPTS} attempts (${lastWaitMessage}). Try again in a moment.`,
    );
  });
}

// ---- internals ----

interface CallInit {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: object;
  /**
   * Whether this call is safe to retry on transient failure (network error,
   * per-attempt timeout, HTTP 5xx, HTTP 429). Defaults to false. Only set true
   * when the operation has no observable difference between "ran once" and
   * "ran N times" — i.e. GET, DELETE, bind (upsert), transition (state machine).
   * POST inserts are NOT idempotent: a 503 after YouTube already accepted the
   * insert would produce a duplicate resource on retry.
   */
  idempotent?: boolean;
  /** Operation-level abort signal — fires when `cancelAllInFlight()` runs. */
  signal: AbortSignal;
}

async function call<T>(url: string, init: CallInit): Promise<T> {
  const token = await auth.getAccessToken();
  if (!token) {
    throw new Error('Not signed in to YouTube. Sign in from the login screen and try again.');
  }
  const baseHeaders: Record<string, string> = { authorization: `Bearer ${token}` };
  if (init.body !== undefined) baseHeaders['content-type'] = 'application/json';

  const maxAttempts = init.idempotent ? RETRY_ATTEMPTS : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (init.signal.aborted) throw new DOMException('Aborted', 'AbortError');

    // Per-attempt controller: we abort it from the timeout fallback AND from
    // the operation's abort signal. Outer abort always wins; the per-attempt
    // timeout looks like a transient failure (retryable) so we track it
    // separately via the `timedOut` flag.
    const attemptController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      attemptController.abort();
    }, PER_ATTEMPT_TIMEOUT_MS);
    const onOuterAbort = () => attemptController.abort();
    init.signal.addEventListener('abort', onOuterAbort, { once: true });

    let response: Response | null = null;
    let attemptError: unknown = null;
    try {
      response = await fetch(url, {
        method: init.method,
        headers: baseHeaders,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: attemptController.signal,
      });
    } catch (err) {
      attemptError = err;
    } finally {
      clearTimeout(timer);
      init.signal.removeEventListener('abort', onOuterAbort);
    }

    // Outer abort always wins over any other failure mode.
    if (init.signal.aborted) throw new DOMException('Aborted', 'AbortError');

    if (response) {
      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }

      if (init.idempotent && isRetryableStatus(response.status) && attempt < maxAttempts) {
        // Drain body so the underlying connection can be reused.
        try {
          await response.text();
        } catch {
          // ignore
        }
        const delay = backoffMs(attempt);
        log(
          `transient HTTP ${response.status} on ${init.method} ${url} — retry ${attempt}/${maxAttempts} in ${Math.round(delay)}ms`,
        );
        await sleep(delay, init.signal);
        continue;
      }

      throw new Error(await explainError(response));
    }

    // No response → network error or per-attempt timeout. Both are transient.
    const isTransient =
      timedOut ||
      attemptError instanceof TypeError ||
      (attemptError instanceof DOMException && attemptError.name === 'AbortError');

    if (init.idempotent && isTransient && attempt < maxAttempts) {
      const kind = timedOut ? 'timeout' : 'network';
      const msg = attemptError instanceof Error ? attemptError.message : String(attemptError);
      const delay = backoffMs(attempt);
      log(
        `transient ${kind} on ${init.method} ${url} — retry ${attempt}/${maxAttempts} in ${Math.round(delay)}ms: ${msg}`,
      );
      await sleep(delay, init.signal);
      continue;
    }

    if (timedOut) {
      throw new Error(
        `YouTube API call timed out after ${PER_ATTEMPT_TIMEOUT_MS}ms: ${init.method} ${url}`,
      );
    }
    throw attemptError instanceof Error
      ? attemptError
      : new Error(String(attemptError ?? `Unknown fetch failure for ${init.method} ${url}`));
  }

  // Loop exits via return / throw; this is unreachable but keeps TS happy.
  throw new Error('YouTube API call exhausted retry attempts.');
}

async function callDelete(url: string, signal: AbortSignal): Promise<void> {
  const token = await auth.getAccessToken();
  if (!token) {
    throw new Error('Not signed in to YouTube. Sign in from the login screen and try again.');
  }

  const maxAttempts = RETRY_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const attemptController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      attemptController.abort();
    }, PER_ATTEMPT_TIMEOUT_MS);
    const onOuterAbort = () => attemptController.abort();
    signal.addEventListener('abort', onOuterAbort, { once: true });

    let response: Response | null = null;
    let attemptError: unknown = null;
    try {
      response = await fetch(url, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
        signal: attemptController.signal,
      });
    } catch (err) {
      attemptError = err;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onOuterAbort);
    }

    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    if (response) {
      // 404 = resource already gone; treat as success so cleanup is idempotent.
      if (response.status === 404) return;
      if (response.ok) return;

      if (isRetryableStatus(response.status) && attempt < maxAttempts) {
        try {
          await response.text();
        } catch {
          // ignore
        }
        const delay = backoffMs(attempt);
        log(
          `transient HTTP ${response.status} on DELETE ${url} — retry ${attempt}/${maxAttempts} in ${Math.round(delay)}ms`,
        );
        await sleep(delay, signal);
        continue;
      }
      throw new Error(await explainError(response));
    }

    const isTransient =
      timedOut ||
      attemptError instanceof TypeError ||
      (attemptError instanceof DOMException && attemptError.name === 'AbortError');
    if (isTransient && attempt < maxAttempts) {
      const kind = timedOut ? 'timeout' : 'network';
      const msg = attemptError instanceof Error ? attemptError.message : String(attemptError);
      const delay = backoffMs(attempt);
      log(
        `transient ${kind} on DELETE ${url} — retry ${attempt}/${maxAttempts} in ${Math.round(delay)}ms: ${msg}`,
      );
      await sleep(delay, signal);
      continue;
    }

    if (timedOut) {
      throw new Error(`YouTube DELETE timed out after ${PER_ATTEMPT_TIMEOUT_MS}ms: ${url}`);
    }
    throw attemptError instanceof Error
      ? attemptError
      : new Error(String(attemptError ?? `Unknown fetch failure for DELETE ${url}`));
  }
  throw new Error('YouTube DELETE exhausted retry attempts.');
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function backoffMs(attempt: number): number {
  // Exponential: 200, 400, 800 with up to +30% jitter.
  const base = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  return base + Math.random() * base * 0.3;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
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

async function explainError(res: Response): Promise<string> {
  let body: { error?: { code?: number; message?: string; errors?: { reason?: string; message?: string }[] } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return `YouTube API error ${res.status}: ${res.statusText}`;
  }
  const reason = body.error?.errors?.[0]?.reason;
  const message = body.error?.message ?? `${res.status} ${res.statusText}`;

  switch (reason) {
    case 'authError':
    case 'invalidCredentials':
      return 'Your YouTube sign-in expired. Sign out and sign in again.';
    case 'insufficientPermissions':
      return 'The signed-in account is missing the YouTube live-streaming scope. Sign out and sign in again to re-consent.';
    case 'quotaExceeded':
      return 'YouTube API daily quota exceeded. Try again tomorrow or request a quota increase in Google Cloud Console.';
    case 'rateLimitExceeded':
    case 'userRateLimitExceeded':
      return 'YouTube rate-limit hit. Wait a minute and try again.';
    case 'liveStreamingNotEnabled':
      return 'This Google account is not enabled for YouTube live streaming. Open https://www.youtube.com/live_dashboard to verify the channel.';
    case 'liveBroadcastBindingNotAllowed':
      return `YouTube refused to bind the broadcast to the stream: ${message}`;
    case 'errorStreamInactive':
    case 'invalidTransition':
      return 'YouTube is not yet receiving video for this broadcast. Confirm OBS is actually streaming, then try again.';
    case 'redundantTransition':
      return 'This broadcast is already in the requested state.';
    case 'invalidValue':
    case 'badRequest':
      return `YouTube rejected the request: ${message}`;
    default:
      return `YouTube API error (${res.status}): ${message}`;
  }
}

const CATEGORY_MAP: Record<string, string> = {
  music: '10',
  gaming: '20',
  games: '20',
  'just chatting': '22',
  'people & blogs': '22',
  irl: '22',
  entertainment: '24',
  'how-to': '26',
  education: '27',
  'science & technology': '28',
  'software & game dev': '28',
};

function inferCategoryId(category: string): string {
  const key = category.toLowerCase().trim();
  return CATEGORY_MAP[key] ?? '20'; // assume gaming if unrecognised
}

async function setCategoryBestEffort(
  videoId: string,
  args: { title: string; description: string; category: string; signal: AbortSignal },
): Promise<void> {
  try {
    // PUT on videos.update is idempotent — retry on transient failure.
    await call(`${API_BASE}/videos?part=snippet`, {
      method: 'PUT',
      idempotent: true,
      signal: args.signal,
      body: {
        id: videoId,
        snippet: {
          title: args.title,
          description: args.description,
          categoryId: inferCategoryId(args.category),
          tags: [args.category],
        },
      },
    });
  } catch (err) {
    // Non-fatal — the broadcast was created successfully.
    console.warn('[youtube] Could not set video category:', err instanceof Error ? err.message : err);
  }
}
