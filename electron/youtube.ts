import * as auth from './auth';

const API_BASE = 'https://www.googleapis.com/youtube/v3';

function log(...args: unknown[]) {
  console.info('[youtube]', ...args);
}

/** Mask a stream key in logs so we don't leak credentials to terminal/file logs. */
function maskKey(key: string | undefined | null): string {
  if (!key) return '<empty>';
  return `<${key.length}-char key ending …${key.slice(-4)}>`;
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

  const data = await call<{ id: string; snippet: { title: string; description: string }; status: { lifeCycleStatus: string } }>(
    `${API_BASE}/liveBroadcasts?part=snippet,contentDetails,status`,
    { method: 'POST', body },
  );

  if (input.category) {
    await setCategoryBestEffort(data.id, {
      title: input.title,
      description: input.description ?? '',
      category: input.category,
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
}

// ---- liveStreams.insert ----

export async function createLiveStream(input: CreateLiveStreamInput): Promise<YouTubeLiveStreamDTO> {
  log('createLiveStream:', input);
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

  const data = await call<{ id: string; snippet: { title: string } }>(
    `${API_BASE}/liveStreams?part=snippet,cdn,contentDetails`,
    { method: 'POST', body },
  );

  if (!data.id) {
    throw new Error('YouTube returned no stream id from liveStreams.insert.');
  }
  log('createLiveStream → returned stream id:', data.id);
  return { id: data.id, title: data.snippet.title };
}

// ---- liveBroadcasts.bind ----

export async function bindBroadcastToStream(
  broadcastId: string,
  streamId: string,
): Promise<{ broadcastId: string; streamId: string }> {
  log(`bindBroadcastToStream: broadcast=${broadcastId} stream=${streamId}`);
  const url = new URL(`${API_BASE}/liveBroadcasts/bind`);
  url.searchParams.set('part', 'id,contentDetails');
  url.searchParams.set('id', broadcastId);
  url.searchParams.set('streamId', streamId);

  const data = await call<{ id: string; contentDetails?: { boundStreamId?: string } }>(url.toString(), {
    method: 'POST',
  });

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
}

// ---- liveStreams.list (status only) ----

export async function getStreamStatus(streamId: string): Promise<string> {
  const url = new URL(`${API_BASE}/liveStreams`);
  url.searchParams.set('part', 'status');
  url.searchParams.set('id', streamId);

  const data = await call<{
    items?: { id: string; status?: { streamStatus?: string } }[];
  }>(url.toString(), { method: 'GET' });

  const status = data.items?.[0]?.status?.streamStatus;
  if (!status) {
    throw new Error(`Could not read status for stream ${streamId}.`);
  }
  return status;
}

// ---- liveBroadcasts.transition ----

export async function transitionToLive(broadcastId: string): Promise<YouTubeBroadcastDTO> {
  const url = new URL(`${API_BASE}/liveBroadcasts/transition`);
  url.searchParams.set('part', 'snippet,status,contentDetails');
  url.searchParams.set('broadcastStatus', 'live');
  url.searchParams.set('id', broadcastId);

  const data = await call<{
    id: string;
    snippet: { title: string; description: string; scheduledStartTime: string };
    status: { lifeCycleStatus: string; privacyStatus: Privacy };
    contentDetails?: { boundStreamId?: string };
  }>(url.toString(), { method: 'POST' });

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
}

// ---- liveBroadcasts.delete / liveStreams.delete ----

export async function deleteBroadcast(broadcastId: string): Promise<void> {
  const url = new URL(`${API_BASE}/liveBroadcasts`);
  url.searchParams.set('id', broadcastId);
  await callDelete(url.toString());
}

export async function deleteLiveStream(streamId: string): Promise<void> {
  const url = new URL(`${API_BASE}/liveStreams`);
  url.searchParams.set('id', streamId);
  await callDelete(url.toString());
}

// ---- liveStreams.list (ingestion info) ----

export async function getStreamIngestionInfo(streamId: string): Promise<StreamIngestionInfoDTO> {
  log(`getStreamIngestionInfo: streamId=${streamId}`);
  const url = new URL(`${API_BASE}/liveStreams`);
  url.searchParams.set('part', 'cdn,status');
  url.searchParams.set('id', streamId);

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
  }>(url.toString(), { method: 'GET' });

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
  if (!info?.streamName || !info.ingestionAddress) {
    throw new Error(
      `Stream ${streamId} does not have ingestion info available yet. Try again in a moment.`,
    );
  }

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
  });
  return result;
}

// ---- internals ----

interface CallInit {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: object;
}

async function call<T>(url: string, init: CallInit): Promise<T> {
  const token = await auth.getAccessToken();
  if (!token) {
    throw new Error('Not signed in to YouTube. Sign in from the login screen and try again.');
  }
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(url, {
    method: init.method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  if (!res.ok) {
    throw new Error(await explainError(res));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function callDelete(url: string): Promise<void> {
  const token = await auth.getAccessToken();
  if (!token) {
    throw new Error('Not signed in to YouTube. Sign in from the login screen and try again.');
  }
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });

  // 404 = resource already gone; treat as success so cleanup is idempotent.
  if (res.status === 404) return;
  if (!res.ok) {
    throw new Error(await explainError(res));
  }
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
  args: { title: string; description: string; category: string },
): Promise<void> {
  try {
    await call(`${API_BASE}/videos?part=snippet`, {
      method: 'PUT',
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
