import type { LaunchEvent } from '../launchService';
import type {
  StreamIngestionInfo,
  StreamSettings,
  YouTubeBroadcast,
  YouTubeLiveStream,
  YouTubeUser,
} from '../../types';

// Mock both service modules before importing the system under test so the SUT
// picks up the mocks. Each function returns a successful stub by default; tests
// override individual functions via vi.mocked(...).mockResolvedValueOnce().
vi.mock('../obsService', () => ({
  connect: vi.fn(async () => ({ state: 'connected' as const })),
  disconnect: vi.fn(async () => undefined),
  configureStreamService: vi.fn(async () => undefined),
  assertActiveStreamServiceSettings: vi.fn(async () => undefined),
  startStreaming: vi.fn(async () => ({ state: 'streaming' as const })),
  stopStreaming: vi.fn(async () => ({ state: 'connected' as const })),
  getStatus: vi.fn(() => ({ state: 'connected' as const })),
}));

vi.mock('../youtubeService', () => ({
  getCurrentUser: vi.fn(
    async (): Promise<YouTubeUser> => ({
      id: 'user-1',
      name: 'Test User',
      email: 'test@example.com',
      channel: 'Test Channel',
    }),
  ),
  createBroadcast: vi.fn(
    async (): Promise<YouTubeBroadcast> => ({
      id: 'bcast-1',
      title: 'Test',
      description: '',
      privacy: 'unlisted',
      category: '',
      status: 'created',
      watchUrl: 'https://youtube.com/watch?v=bcast-1',
      scheduledStartTime: new Date().toISOString(),
    }),
  ),
  createLiveStream: vi.fn(
    async (): Promise<YouTubeLiveStream> => ({ id: 'stream-1', title: 'Test' }),
  ),
  bindBroadcastToStream: vi.fn(async () => undefined),
  getStreamIngestionInfo: vi.fn(
    async (streamId: string): Promise<StreamIngestionInfo> => ({
      streamId,
      streamKey: 'abcd-efgh-ijkl-mnop',
      rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
    }),
  ),
  waitForStreamActive: vi.fn(async () => undefined),
  transitionToLive: vi.fn(
    async (b: YouTubeBroadcast): Promise<YouTubeBroadcast> => ({ ...b, status: 'live' }),
  ),
  deleteBroadcast: vi.fn(async () => undefined),
  deleteLiveStream: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
}));

import * as obs from '../obsService';
import * as youtube from '../youtubeService';
import { runLaunchSequence } from '../launchService';

function makeSettings(overrides: Partial<StreamSettings> = {}): StreamSettings {
  return {
    title: 'Test Stream',
    description: 'Test description',
    privacy: 'unlisted',
    category: '',
    obsPassword: 'pw',
    ...overrides,
  };
}

/**
 * Drains the launch-service module-level mutex by aborting any in-flight
 * launch and waiting for it to settle. Without this, tests that simulate
 * never-resolving operations would leak state into the next test.
 */
async function drainMutex(): Promise<void> {
  // A no-op launch with an immediate abort drains the mutex by replacing any
  // prior leaked launch and then settling itself.
  const ac = new AbortController();
  ac.abort();
  await runLaunchSequence({
    settings: makeSettings(),
    onEvent: () => undefined,
    signal: ac.signal,
  }).catch(() => undefined);
}

beforeEach(() => {
  // resetAllMocks (NOT clearAllMocks) so any leftover mockImplementationOnce
  // / mockResolvedValueOnce queues from a prior test are dropped before we
  // re-install the defaults below.
  vi.resetAllMocks();
  // Restore default mock implementations after reset.
  vi.mocked(obs.connect).mockResolvedValue({ state: 'connected' as const });
  vi.mocked(obs.disconnect).mockResolvedValue(undefined);
  vi.mocked(obs.configureStreamService).mockResolvedValue(undefined);
  vi.mocked(obs.assertActiveStreamServiceSettings).mockResolvedValue(undefined);
  vi.mocked(obs.startStreaming).mockResolvedValue({ state: 'streaming' as const });
  vi.mocked(obs.stopStreaming).mockResolvedValue({ state: 'connected' as const });
  vi.mocked(obs.getStatus).mockReturnValue({ state: 'connected' as const });

  vi.mocked(youtube.getCurrentUser).mockResolvedValue({
    id: 'user-1',
    name: 'Test User',
    email: 'test@example.com',
    channel: 'Test Channel',
  });
  vi.mocked(youtube.createBroadcast).mockResolvedValue({
    id: 'bcast-1',
    title: 'Test',
    description: '',
    privacy: 'unlisted',
    category: '',
    status: 'created',
    watchUrl: 'https://youtube.com/watch?v=bcast-1',
    scheduledStartTime: new Date().toISOString(),
  });
  vi.mocked(youtube.createLiveStream).mockResolvedValue({ id: 'stream-1', title: 'Test' });
  vi.mocked(youtube.bindBroadcastToStream).mockResolvedValue(undefined);
  vi.mocked(youtube.getStreamIngestionInfo).mockImplementation(async (streamId: string) => ({
    streamId,
    streamKey: 'abcd-efgh-ijkl-mnop',
    rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
  }));
  vi.mocked(youtube.waitForStreamActive).mockResolvedValue(undefined);
  vi.mocked(youtube.transitionToLive).mockImplementation(async (b: YouTubeBroadcast) => ({
    ...b,
    status: 'live',
  }));
  vi.mocked(youtube.deleteBroadcast).mockResolvedValue(undefined);
  vi.mocked(youtube.deleteLiveStream).mockResolvedValue(undefined);
  vi.mocked(youtube.cancel).mockResolvedValue(undefined);
});

afterEach(async () => {
  // Make sure no leaked launch keeps the module mutex held between tests.
  await drainMutex();
});

// ---- validateSettings (run via the orchestrator's validate step) ----
//
// validateSettings is not exported, so we exercise it by running the launch and
// checking that the 'validate' step throws with the documented messages.

describe('validateSettings', () => {
  async function expectValidateError(settings: StreamSettings, matcher: RegExp | string) {
    const events: LaunchEvent[] = [];
    await expect(
      runLaunchSequence({ settings, onEvent: (e) => events.push(e) }),
    ).rejects.toThrow(matcher);
    const err = events.find((e) => e.type === 'step:error' && e.stepId === 'validate');
    expect(err).toBeDefined();
  }

  it('rejects empty title', async () => {
    await expectValidateError(makeSettings({ title: '   ' }), 'Stream title is required.');
  });

  it('rejects a 101-character title and mentions the character count', async () => {
    const longTitle = 'a'.repeat(101);
    await expectValidateError(makeSettings({ title: longTitle }), /101 characters/);
  });

  it('rejects a 5001-character description and mentions the character count', async () => {
    const longDescription = 'a'.repeat(5001);
    await expectValidateError(makeSettings({ description: longDescription }), /5001 characters/);
  });

  it('rejects empty obsPassword', async () => {
    await expectValidateError(
      makeSettings({ obsPassword: '   ' }),
      'OBS WebSocket password is required.',
    );
  });

  it('rejects an invalid privacy enum and mentions the value', async () => {
    await expectValidateError(
      // Cast through unknown to bypass the compile-time check — the runtime
      // validator is the one we're testing.
      makeSettings({ privacy: 'secret' as unknown as StreamSettings['privacy'] }),
      /secret/,
    );
  });

  it('accepts a valid settings object (no throw)', async () => {
    // Happy path: should not throw, should reach 'complete'.
    const events: LaunchEvent[] = [];
    await expect(
      runLaunchSequence({ settings: makeSettings(), onEvent: (e) => events.push(e) }),
    ).resolves.toMatchObject({ status: 'live' });
    expect(events.find((e) => e.type === 'step:error')).toBeUndefined();
  });
});

// ---- happy path ----

describe('runLaunchSequence happy path', () => {
  const STEP_ORDER = [
    'validate',
    'auth',
    'broadcast',
    'stream',
    'bind',
    'ingestion',
    'connect-obs',
    'configure-obs',
    'start-stream',
    'go-live',
  ] as const;

  it('emits all 10 step:start + step:done events in order', async () => {
    const events: LaunchEvent[] = [];
    await runLaunchSequence({ settings: makeSettings(), onEvent: (e) => events.push(e) });

    const stepEvents = events.filter(
      (e): e is Extract<LaunchEvent, { type: 'step:start' | 'step:done' }> =>
        e.type === 'step:start' || e.type === 'step:done',
    );

    // Each step should appear as a start followed by a done, in canonical order.
    for (let i = 0; i < STEP_ORDER.length; i++) {
      expect(stepEvents[i * 2]).toEqual({ type: 'step:start', stepId: STEP_ORDER[i] });
      expect(stepEvents[i * 2 + 1]).toEqual({ type: 'step:done', stepId: STEP_ORDER[i] });
    }
    expect(stepEvents).toHaveLength(STEP_ORDER.length * 2);
  });

  it('emits broadcast-created exactly once after step 3', async () => {
    const events: LaunchEvent[] = [];
    await runLaunchSequence({ settings: makeSettings(), onEvent: (e) => events.push(e) });

    const broadcastCreatedIndices = events
      .map((e, i) => (e.type === 'broadcast-created' ? i : -1))
      .filter((i) => i !== -1);
    expect(broadcastCreatedIndices).toHaveLength(1);

    const broadcastDoneIndex = events.findIndex(
      (e) => e.type === 'step:done' && e.stepId === 'broadcast',
    );
    expect(broadcastDoneIndex).toBeGreaterThanOrEqual(0);
    expect(broadcastCreatedIndices[0]).toBeGreaterThan(broadcastDoneIndex);
  });

  it('emits ingestion-ready exactly once after step 6', async () => {
    const events: LaunchEvent[] = [];
    await runLaunchSequence({ settings: makeSettings(), onEvent: (e) => events.push(e) });

    const ingestionIndices = events
      .map((e, i) => (e.type === 'ingestion-ready' ? i : -1))
      .filter((i) => i !== -1);
    expect(ingestionIndices).toHaveLength(1);

    const ingestionDoneIndex = events.findIndex(
      (e) => e.type === 'step:done' && e.stepId === 'ingestion',
    );
    expect(ingestionIndices[0]).toBeGreaterThan(ingestionDoneIndex);
  });

  it('emits complete exactly once after step 10 with the live broadcast', async () => {
    const events: LaunchEvent[] = [];
    await runLaunchSequence({ settings: makeSettings(), onEvent: (e) => events.push(e) });

    const completes = events.filter((e) => e.type === 'complete');
    expect(completes).toHaveLength(1);
    const complete = completes[0] as Extract<LaunchEvent, { type: 'complete' }>;
    expect(complete.broadcast.status).toBe('live');

    // 'complete' should fire AFTER step:done for 'go-live'.
    const goLiveDoneIndex = events.findIndex(
      (e) => e.type === 'step:done' && e.stepId === 'go-live',
    );
    const completeIndex = events.findIndex((e) => e.type === 'complete');
    expect(completeIndex).toBeGreaterThan(goLiveDoneIndex);
  });

  it('mutex: after one launch completes, a second call runs normally', async () => {
    await runLaunchSequence({ settings: makeSettings(), onEvent: () => undefined });
    const events: LaunchEvent[] = [];
    await runLaunchSequence({ settings: makeSettings(), onEvent: (e) => events.push(e) });
    expect(events.filter((e) => e.type === 'complete')).toHaveLength(1);
    // createBroadcast was called once per launch -> 2 total.
    expect(vi.mocked(youtube.createBroadcast)).toHaveBeenCalledTimes(2);
  });
});

// ---- failure & cleanup ----

describe('runLaunchSequence failure & cleanup', () => {
  it('failure at step 3 (broadcast): no cleanup, emits step:error for broadcast', async () => {
    vi.mocked(youtube.createBroadcast).mockRejectedValueOnce(new Error('YouTube exploded'));
    const events: LaunchEvent[] = [];

    await expect(
      runLaunchSequence({ settings: makeSettings(), onEvent: (e) => events.push(e) }),
    ).rejects.toThrow('YouTube exploded');

    const err = events.find(
      (e): e is Extract<LaunchEvent, { type: 'step:error' }> =>
        e.type === 'step:error' && e.stepId === 'broadcast',
    );
    expect(err).toBeDefined();

    // No broadcast was successfully created, so nothing to delete.
    expect(vi.mocked(youtube.deleteBroadcast)).not.toHaveBeenCalled();
    expect(vi.mocked(youtube.deleteLiveStream)).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'cleanup')).toBeUndefined();
  });

  it('failure at step 5 (bind): cleans up both broadcast and stream and emits cleanup', async () => {
    vi.mocked(youtube.bindBroadcastToStream).mockRejectedValueOnce(new Error('bind failed'));
    const events: LaunchEvent[] = [];

    await expect(
      runLaunchSequence({ settings: makeSettings(), onEvent: (e) => events.push(e) }),
    ).rejects.toThrow('bind failed');

    expect(vi.mocked(youtube.deleteBroadcast)).toHaveBeenCalledWith('bcast-1');
    expect(vi.mocked(youtube.deleteLiveStream)).toHaveBeenCalledWith('stream-1');

    const cleanup = events.find(
      (e): e is Extract<LaunchEvent, { type: 'cleanup' }> => e.type === 'cleanup',
    );
    expect(cleanup).toBeDefined();
    expect(cleanup!.deleted).toEqual(
      expect.arrayContaining(['broadcast bcast-1', 'stream stream-1']),
    );
  });

  it('failure at step 9 with obsProgress="configured": cleanup calls obs.disconnect()', async () => {
    // Fail the assertActiveStreamServiceSettings call inside start-stream (so
    // obsProgress stays at 'configured', never reaching 'streaming').
    vi.mocked(obs.assertActiveStreamServiceSettings).mockRejectedValueOnce(
      new Error('drift detected'),
    );
    // After configure succeeded, getStatus is 'connected'.
    vi.mocked(obs.getStatus).mockReturnValue({ state: 'connected' as const });

    await expect(
      runLaunchSequence({ settings: makeSettings(), onEvent: () => undefined }),
    ).rejects.toThrow('drift detected');

    expect(vi.mocked(obs.disconnect)).toHaveBeenCalled();
    expect(vi.mocked(obs.stopStreaming)).not.toHaveBeenCalled();
  });

  it('failure mid-way through step 9 where obsProgress reaches "streaming": cleanup calls obs.stopStreaming() and obs.disconnect()', async () => {
    // assertActive succeeds, startStreaming succeeds (so obsProgress flips to
    // 'streaming'), then the *next* step (go-live) fails.
    vi.mocked(youtube.waitForStreamActive).mockRejectedValueOnce(new Error('never went active'));
    vi.mocked(obs.getStatus).mockReturnValue({ state: 'streaming' as const });

    await expect(
      runLaunchSequence({ settings: makeSettings(), onEvent: () => undefined }),
    ).rejects.toThrow('never went active');

    // Audit H3: cleanup's 'streaming' arm always attempts both stopStreaming
    // and disconnect now (previously only stopStreaming, and only when
    // getStatus().state === 'streaming'). The widened behavior is needed
    // because obsProgress is now flipped to 'streaming' BEFORE the StartStream
    // call returns, so a verify-loop timeout can land us in this arm even
    // when getStatus() never observed the streaming state.
    expect(vi.mocked(obs.stopStreaming)).toHaveBeenCalled();
    expect(vi.mocked(obs.disconnect)).toHaveBeenCalled();
  });

  it('failure during cleanup itself: a slow obs.disconnect() is awaited but does not crash the test', async () => {
    // The current code awaits obs.disconnect() without a timeout. We resolve
    // the rejection itself synchronously so the test does not hang. If a
    // future version adds a Promise.race timeout, this test still passes.
    vi.mocked(obs.assertActiveStreamServiceSettings).mockRejectedValueOnce(
      new Error('drift detected'),
    );
    vi.mocked(obs.getStatus).mockReturnValue({ state: 'connected' as const });
    vi.mocked(obs.disconnect).mockRejectedValueOnce(new Error('disconnect crashed'));

    // Cleanup should swallow the disconnect error and re-throw the original.
    await expect(
      runLaunchSequence({ settings: makeSettings(), onEvent: () => undefined }),
    ).rejects.toThrow('drift detected');

    expect(vi.mocked(obs.disconnect)).toHaveBeenCalled();
  });
});

// ---- mutex & abort ----

describe('mutex & abort', () => {
  it('two concurrent runLaunchSequence calls: second awaits first settlement', async () => {
    // Hold the first launch's waitForStreamActive (step 10) until either the
    // signal aborts or we release it. The signal-aware path is what fires
    // when the second launch arrives and the serializer aborts the first.
    vi.mocked(youtube.waitForStreamActive).mockImplementationOnce(async (_id, opts) => {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          opts?.signal?.removeEventListener('abort', onAbort);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        if (opts?.signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        opts?.signal?.addEventListener('abort', onAbort, { once: true });
      });
    });

    const firstEvents: LaunchEvent[] = [];
    const secondEvents: LaunchEvent[] = [];

    const firstPromise = runLaunchSequence({
      settings: makeSettings(),
      onEvent: (e) => firstEvents.push(e),
    });

    // Yield enough times for the first launch to reach waitForStreamActive.
    // The validate step is 250ms real time, so wait it out plus a bit.
    await new Promise((r) => setTimeout(r, 350));

    const secondPromise = runLaunchSequence({
      settings: makeSettings(),
      onEvent: (e) => secondEvents.push(e),
    });

    // Both promises settle: first aborts (cleanup runs), second completes.
    const [firstResult, secondResult] = await Promise.allSettled([firstPromise, secondPromise]);
    expect(firstResult.status).toBe('rejected');
    expect(secondResult.status).toBe('fulfilled');
    if (secondResult.status === 'fulfilled') {
      expect(secondResult.value.status).toBe('live');
    }
    // Second launch produced its own complete event.
    expect(secondEvents.find((e) => e.type === 'complete')).toBeDefined();
    // The serializer means the second launch's complete event must come
    // *after* the first launch fully settled — i.e. createBroadcast was called
    // twice in total.
    expect(vi.mocked(youtube.createBroadcast)).toHaveBeenCalledTimes(2);
  });

  it('pre-aborted signal: throws DOMException AbortError on the first step', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      runLaunchSequence({
        settings: makeSettings(),
        onEvent: () => undefined,
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('abort signal fired mid-launch: triggers cleanup, throws AbortError, calls youtube.cancel()', async () => {
    // Stall waitForStreamActive (step 10) so the launch is past
    // broadcast/stream/bind/ingestion when we abort — that way cleanup has
    // something to delete.
    vi.mocked(youtube.waitForStreamActive).mockImplementationOnce(async (_id, opts) => {
      await new Promise<void>((_resolve, reject) => {
        if (opts?.signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        opts?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    });

    const ac = new AbortController();
    const events: LaunchEvent[] = [];
    const promise = runLaunchSequence({
      settings: makeSettings(),
      onEvent: (e) => events.push(e),
      signal: ac.signal,
    });

    // Validate has a 250ms real-time sleep — wait it out plus enough margin
    // for the rest of the orchestrator to reach waitForStreamActive.
    await new Promise((r) => setTimeout(r, 400));

    ac.abort();
    // In real Electron / Node, DOMException('Aborted', 'AbortError') extends Error
    // and preserves .name. Under vitest's jsdom environment, jsdom's DOMException
    // does NOT satisfy `instanceof Error`, so the orchestrator's run() helper wraps
    // it in `new Error(String(err))` → message is "AbortError: Aborted" but .name
    // is "Error". Asserting on message keeps the test correct in both worlds.
    await expect(promise).rejects.toMatchObject({
      message: expect.stringContaining('Abort'),
    });

    // youtube.cancel was called when abort propagated.
    expect(vi.mocked(youtube.cancel)).toHaveBeenCalled();

    // Cleanup ran for the broadcast we created mid-flight.
    expect(vi.mocked(youtube.deleteBroadcast)).toHaveBeenCalled();
    expect(vi.mocked(youtube.deleteLiveStream)).toHaveBeenCalled();
  });
});
