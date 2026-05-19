import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the electron module — youtube.ts imports it transitively via auth.ts.
vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(s)),
    decryptString: vi.fn((b: Buffer) => b.toString()),
  },
  app: { getPath: vi.fn(() => '/tmp') },
}));

// Mock auth so call() can fetch tokens without exercising the real OAuth
// flow. Default: a working access token. Individual tests override.
vi.mock('../auth', () => ({
  getAccessToken: vi.fn(async () => 'test-access-token'),
}));

import * as youtube from '../youtube';

const originalFetch = globalThis.fetch;

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
function err(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetchSequence(handlers: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>): {
  callCount: () => number;
  calls: () => Array<{ url: string; init?: RequestInit }>;
} {
  let i = 0;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    calls.push({ url, init });
    const handler = handlers[i] ?? handlers[handlers.length - 1];
    i++;
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { callCount: () => i, calls: () => calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---- bindBroadcastToStream identity assertions ----

describe('bindBroadcastToStream', () => {
  it('happy path: ids match → returns the (broadcastId, streamId) pair', async () => {
    mockFetchSequence([
      () =>
        ok({ id: 'bcast-1', contentDetails: { boundStreamId: 'stream-1' } }),
    ]);

    const result = await youtube.bindBroadcastToStream('bcast-1', 'stream-1');
    expect(result).toEqual({ broadcastId: 'bcast-1', streamId: 'stream-1' });
  });

  it('M8: throws if YouTube returns a different broadcast id', async () => {
    mockFetchSequence([
      () =>
        ok({ id: 'bcast-DIFFERENT', contentDetails: { boundStreamId: 'stream-1' } }),
    ]);

    await expect(
      youtube.bindBroadcastToStream('bcast-1', 'stream-1'),
    ).rejects.toThrow(/Bind response is for broadcast bcast-DIFFERENT/);
  });

  it('M8: throws if YouTube returns no boundStreamId at all', async () => {
    mockFetchSequence([() => ok({ id: 'bcast-1', contentDetails: {} })]);

    await expect(
      youtube.bindBroadcastToStream('bcast-1', 'stream-1'),
    ).rejects.toThrow(/no boundStreamId/);
  });

  it('M8: throws if boundStreamId is a different stream than the one we provisioned (the wrong-broadcast bug guard)', async () => {
    mockFetchSequence([
      () =>
        ok({
          id: 'bcast-1',
          contentDetails: { boundStreamId: 'stream-LEAKED-FROM-ANOTHER-LAUNCH' },
        }),
    ]);

    await expect(
      youtube.bindBroadcastToStream('bcast-1', 'stream-1'),
    ).rejects.toThrow(/bound to stream stream-LEAKED-FROM-ANOTHER-LAUNCH but we provisioned stream stream-1/);
  });
});

// ---- getStreamIngestionInfo identity + retry ----

describe('getStreamIngestionInfo', () => {
  it('happy path: returns ingestion info with RTMPS preferred', async () => {
    mockFetchSequence([
      () =>
        ok({
          items: [
            {
              id: 'stream-1',
              cdn: {
                ingestionInfo: {
                  streamName: 'abcd-efgh',
                  ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2',
                  rtmpsIngestionAddress: 'rtmps://a.rtmps.youtube.com/live2',
                },
              },
            },
          ],
        }),
    ]);

    const info = await youtube.getStreamIngestionInfo('stream-1');
    expect(info).toEqual({
      streamId: 'stream-1',
      streamKey: 'abcd-efgh',
      rtmpUrl: 'rtmps://a.rtmps.youtube.com/live2',
      backupRtmpUrl: undefined,
    });
  });

  it('M8: throws if items[0].id is a different stream than requested', async () => {
    mockFetchSequence([
      () =>
        ok({
          items: [
            {
              id: 'stream-DIFFERENT',
              cdn: {
                ingestionInfo: {
                  streamName: 'leaked-key',
                  ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2',
                },
              },
            },
          ],
        }),
    ]);

    await expect(youtube.getStreamIngestionInfo('stream-1')).rejects.toThrow(
      /Asked YouTube for stream stream-1 but got stream-DIFFERENT/,
    );
  });

  it('retries up to 5 attempts when ingestionInfo is absent, then throws', async () => {
    vi.useFakeTimers();
    try {
      const seq = mockFetchSequence([
        () => ok({ items: [{ id: 'stream-1', cdn: {} }] }),
      ]);

      const promise = youtube
        .getStreamIngestionInfo('stream-1')
        .catch((e) => e);
      // Drive through all retry sleeps (1000ms each between attempts, 5 attempts → 4 sleeps).
      await vi.advanceTimersByTimeAsync(6000);
      const result = await promise;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/does not have ingestion info available yet after 5 attempts/);
      expect(seq.callCount()).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- retry on transient failures for idempotent calls ----

describe('call() retry behavior', () => {
  it('idempotent GET retries 502 then succeeds on the second attempt', async () => {
    vi.useFakeTimers();
    try {
      const seq = mockFetchSequence([
        () => err(502, { error: { code: 502, message: 'bad gateway' } }),
        () => ok({ items: [{ id: 'stream-1', status: { streamStatus: 'active' } }] }),
      ]);

      const promise = youtube.getStreamStatus('stream-1');
      await vi.advanceTimersByTimeAsync(1500);
      const status = await promise;
      expect(status).toBe('active');
      expect(seq.callCount()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('idempotent GET gives up after 3 attempts of 5xx and throws', async () => {
    vi.useFakeTimers();
    try {
      const seq = mockFetchSequence([
        () => err(500, { error: { code: 500, message: 'internal' } }),
        () => err(503, { error: { code: 503, message: 'unavailable' } }),
        () => err(500, { error: { code: 500, message: 'internal' } }),
      ]);

      const promise = youtube.getStreamStatus('stream-1').catch((e) => e);
      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;
      expect(result).toBeInstanceOf(Error);
      expect(seq.callCount()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- cancelAllInFlight: in-flight + pending-cancel flag (M6) ----

describe('cancelAllInFlight', () => {
  it('aborts an in-flight controller (the classic case)', async () => {
    // Mock fetch to never resolve — the abort must surface as the rejection.
    globalThis.fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    ) as unknown as typeof fetch;

    const promise = youtube.getStreamStatus('stream-1').catch((e) => e);
    // Give the IPC handler a tick to register its controller.
    await new Promise((r) => setTimeout(r, 10));
    youtube.cancelAllInFlight();

    const err = await promise;
    // The thrown value is a DOMException('Aborted', 'AbortError') — DOMException
    // does not extend Error in all environments, so check the name field
    // (stable across Node, jsdom, and browsers).
    expect((err as { name?: string }).name).toBe('AbortError');
  });

  it('M6: a cancel that arrives BEFORE any operation registers still aborts the next-arriving operation (pending-cancel race fix)', async () => {
    // Empty registry: cancelAllInFlight in the legacy code returned without
    // setting any flag, leaving the next-to-arrive op fully uncancelled.
    // The pending-cancel grace window must capture it.
    youtube.cancelAllInFlight();

    // Now a fresh op arrives. Mock fetch to assert it's never actually called
    // — the controller should be aborted at entry, the per-attempt check
    // should throw, and we should never reach the network.
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(youtube.getStreamStatus('stream-1')).rejects.toThrow(/Aborted/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('M6: pending-cancel does NOT pre-empt a fresh op that arrives well after the grace window', async () => {
    youtube.cancelAllInFlight();
    // Wait past the 250ms grace window plus headroom.
    await new Promise((r) => setTimeout(r, 350));

    mockFetchSequence([
      () =>
        ok({ items: [{ id: 'stream-1', status: { streamStatus: 'active' } }] }),
    ]);

    const status = await youtube.getStreamStatus('stream-1');
    expect(status).toBe('active');
  });
});
