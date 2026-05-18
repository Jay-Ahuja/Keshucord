import type { OBSConnectionStatus } from '../../types';

// ---- mock obs-websocket-js ----
//
// We expose the singleton instance (and its event-handler map) on a
// hoisted holder so each test can drive events and inspect calls. Using
// vi.hoisted ensures the holder exists BEFORE the mocked module factory runs
// (vi.mock is hoisted by Vitest above module-level let/const initialisers,
// so closing directly over a `let` in this file would hit the TDZ).

interface MockObsHandle {
  connect: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  __handlers: Map<string, (...args: unknown[]) => void>;
  __fire: (event: string, ...args: unknown[]) => void;
}

const holder = vi.hoisted(() => ({ instance: null as MockObsHandle | null }));

vi.mock('obs-websocket-js', () => {
  return {
    default: vi.fn().mockImplementation(() => {
      const handlers = new Map<string, (...args: unknown[]) => void>();
      const handle: MockObsHandle = {
        connect: vi.fn(),
        call: vi.fn(),
        disconnect: vi.fn().mockResolvedValue(undefined),
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          handlers.set(event, handler);
        }),
        off: vi.fn(),
        __handlers: handlers,
        __fire: (event: string, ...args: unknown[]) => {
          const h = handlers.get(event);
          if (h) h(...args);
        },
      };
      holder.instance = handle;
      return handle;
    }),
  };
});

import * as obsService from '../obsService';

function obsMock(): MockObsHandle {
  if (!holder.instance) throw new Error('OBSWebSocket mock not initialised');
  return holder.instance;
}

/**
 * Pushes the service into 'connected' state by simulating a successful
 * connect() handshake. Keeps each test's arrange step short.
 */
async function arriveConnected(): Promise<void> {
  const mock = obsMock();
  mock.connect.mockResolvedValueOnce({ obsWebSocketVersion: '5.0.0' });
  mock.call.mockImplementation(async (command: string) => {
    if (command === 'GetCurrentProgramScene') return { currentProgramSceneName: 'Scene' };
    if (command === 'GetStreamStatus') return { outputActive: false };
    return {};
  });
  await obsService.connect('pw');
  mock.call.mockReset();
}

beforeEach(async () => {
  vi.useRealTimers();
  // Reset internal call/connect/disconnect mock state first, but keep the
  // handler map (the service registered its handlers once at module load).
  if (holder.instance) {
    obsMock().connect.mockReset();
    obsMock().call.mockReset();
    obsMock().disconnect.mockReset().mockResolvedValue(undefined);
  }
  // Force the service back to a 'disconnected' baseline. The exported
  // disconnect() unconditionally sets state to 'disconnected', which works
  // even from the 'error' state (the ConnectionClosed handler guards against
  // that transition, but setStatus itself does not).
  await obsService.disconnect();
});

afterEach(async () => {
  // Restore real timers (some tests opt into fake timers in their own scope).
  vi.useRealTimers();
  // If a test left the service streaming, flush via ConnectionClosed so the
  // health poller stops. Subsequent disconnect() in the next beforeEach gives
  // a clean baseline.
  if (holder.instance) {
    try {
      obsMock().__fire('ConnectionClosed', { code: 1000, reason: 'test cleanup' });
    } catch {
      // ignore
    }
  }
});

// ---- connect ----

describe('connect', () => {
  it('success: transitions to "connected" and notifies status listeners', async () => {
    const mock = obsMock();
    mock.connect.mockResolvedValueOnce({ obsWebSocketVersion: '5.0.0' });
    mock.call.mockImplementation(async (command: string) => {
      if (command === 'GetCurrentProgramScene') return { currentProgramSceneName: 'My Scene' };
      if (command === 'GetStreamStatus') return { outputActive: false };
      return {};
    });

    const seen: OBSConnectionStatus[] = [];
    const unsubscribe = obsService.subscribe((s) => seen.push(s));
    try {
      const result = await obsService.connect('pw');
      expect(result.state).toBe('connected');
      expect(result.version).toBe('5.0.0');
      expect(result.currentScene).toBe('My Scene');
      expect(obsService.getStatus().state).toBe('connected');
      // At least one notification arrived with the connected state.
      expect(seen.some((s) => s.state === 'connected')).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it('code 4009 (wrong password) → error state with mapped password message', async () => {
    const mock = obsMock();
    const err: Error & { code?: number } = Object.assign(new Error('auth failed'), { code: 4009 });
    mock.connect.mockRejectedValue(err);

    await expect(obsService.connect('wrong')).rejects.toThrow(/OBS rejected the password/);
    expect(obsService.getStatus().state).toBe('error');
    expect(obsService.getStatus().error).toMatch(/OBS rejected the password/);
  });

  it('connection refused → error state with the localhost-mapped message', async () => {
    const mock = obsMock();
    mock.connect.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:4455'));

    await expect(obsService.connect('pw')).rejects.toThrow(/Could not reach OBS at ws:\/\/localhost:4455/);
    expect(obsService.getStatus().state).toBe('error');
  });

  it('refuses when already streaming with the "Stop the stream before reconnecting" message', async () => {
    await arriveConnected();
    obsMock().__fire('StreamStateChanged', { outputActive: true });
    expect(obsService.getStatus().state).toBe('streaming');

    await expect(obsService.connect('pw')).rejects.toThrow(
      /Stop the stream before reconnecting/,
    );
  });
});

// ---- configureStreamService ----

describe('configureStreamService', () => {
  it('refuses when state is "disconnected"', async () => {
    // Baseline is disconnected after beforeEach.
    await expect(
      obsService.configureStreamService({ rtmpUrl: 'rtmp://x', streamKey: 'k' }),
    ).rejects.toThrow(/Connect to OBS before configuring stream settings/);
  });

  it('refuses when state is "streaming"', async () => {
    await arriveConnected();
    obsMock().__fire('StreamStateChanged', { outputActive: true });
    await expect(
      obsService.configureStreamService({ rtmpUrl: 'rtmp://x', streamKey: 'k' }),
    ).rejects.toThrow(/OBS is already streaming/);
  });

  it('refuses on empty rtmpUrl', async () => {
    await arriveConnected();
    await expect(
      obsService.configureStreamService({ rtmpUrl: '', streamKey: 'k' }),
    ).rejects.toThrow(/Missing RTMP URL or stream key/);
  });

  it('refuses on empty streamKey', async () => {
    await arriveConnected();
    await expect(
      obsService.configureStreamService({ rtmpUrl: 'rtmp://x', streamKey: '' }),
    ).rejects.toThrow(/Missing RTMP URL or stream key/);
  });

  it('happy path: SetStreamServiceSettings called with rtmp_custom + correct server/key', async () => {
    await arriveConnected();
    const mock = obsMock();
    mock.call.mockImplementation(async (command: string, _params?: unknown) => {
      if (command === 'GetStreamServiceSettings') {
        return {
          streamServiceType: 'rtmp_custom',
          streamServiceSettings: {
            server: 'rtmp://a.rtmp.youtube.com/live2',
            key: 'abcd',
          },
        };
      }
      if (command === 'SetStreamServiceSettings') return {};
      return {};
    });

    await obsService.configureStreamService({
      rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
      streamKey: 'abcd',
    });

    const setCall = mock.call.mock.calls.find(
      (c: unknown[]) => c[0] === 'SetStreamServiceSettings',
    );
    expect(setCall).toBeDefined();
    expect(setCall![1]).toMatchObject({
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: {
        server: 'rtmp://a.rtmp.youtube.com/live2',
        key: 'abcd',
        use_auth: false,
      },
    });
  });

  it('poll-verify times out on stale rtmp_common type → throws the YouTube-account fix message', async () => {
    vi.useFakeTimers();
    try {
      await arriveConnected();
      const mock = obsMock();
      mock.call.mockImplementation(async (command: string) => {
        if (command === 'GetStreamServiceSettings') {
          return {
            streamServiceType: 'rtmp_common',
            streamServiceSettings: { service: 'YouTube - RTMP', server: '', key: '' },
          };
        }
        return {};
      });

      const promise = obsService.configureStreamService({
        rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
        streamKey: 'abcd',
      }).catch((e) => e);
      // Drive past the 3-second verify deadline.
      await vi.advanceTimersByTimeAsync(3500);
      const err = await promise;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/managed YouTube broadcast workflow|locked to a managed YouTube/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('poll-verify times out on server mismatch → throws naming actual vs expected server', async () => {
    vi.useFakeTimers();
    try {
      await arriveConnected();
      const mock = obsMock();
      mock.call.mockImplementation(async (command: string) => {
        if (command === 'GetStreamServiceSettings') {
          return {
            streamServiceType: 'rtmp_custom',
            streamServiceSettings: { server: 'rtmp://wrong-server/', key: 'abcd' },
          };
        }
        return {};
      });

      const promise = obsService.configureStreamService({
        rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
        streamKey: 'abcd',
      }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(3500);
      const err = await promise;
      expect(err).toBeInstanceOf(Error);
      // "did not apply the new stream settings" message naming the applied server.
      expect((err as Error).message).toMatch(/rtmp:\/\/wrong-server/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('poll-verify times out on key mismatch → throws the "did not apply" message', async () => {
    vi.useFakeTimers();
    try {
      await arriveConnected();
      const mock = obsMock();
      mock.call.mockImplementation(async (command: string) => {
        if (command === 'GetStreamServiceSettings') {
          return {
            streamServiceType: 'rtmp_custom',
            streamServiceSettings: { server: 'rtmp://a.rtmp.youtube.com/live2', key: 'OLD' },
          };
        }
        return {};
      });

      const promise = obsService.configureStreamService({
        rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
        streamKey: 'NEW',
      }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(3500);
      const err = await promise;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/did not apply the new stream settings/);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- assertActiveStreamServiceSettings ----

describe('assertActiveStreamServiceSettings', () => {
  it('type mismatch → throws "OBS stream service is X" expected rtmp_custom', async () => {
    await arriveConnected();
    const mock = obsMock();
    mock.call.mockImplementation(async (command: string) => {
      if (command === 'GetStreamServiceSettings') {
        return {
          streamServiceType: 'rtmp_common',
          streamServiceSettings: { server: '', key: '' },
        };
      }
      return {};
    });

    await expect(
      obsService.assertActiveStreamServiceSettings({
        rtmpUrl: 'rtmp://x/',
        streamKey: 'k',
      }),
    ).rejects.toThrow(/stream service is "rtmp_common".*expected "rtmp_custom"/);
  });

  it('server mismatch → throws naming the actual vs expected server', async () => {
    await arriveConnected();
    const mock = obsMock();
    mock.call.mockImplementation(async (command: string) => {
      if (command === 'GetStreamServiceSettings') {
        return {
          streamServiceType: 'rtmp_custom',
          streamServiceSettings: { server: 'rtmp://wrong/', key: 'k' },
        };
      }
      return {};
    });

    await expect(
      obsService.assertActiveStreamServiceSettings({
        rtmpUrl: 'rtmp://right/',
        streamKey: 'k',
      }),
    ).rejects.toThrow(/RTMP server is "rtmp:\/\/wrong\/".*expects "rtmp:\/\/right\/"/);
  });

  it('key mismatch → throws "OBS stream key does not match"', async () => {
    await arriveConnected();
    const mock = obsMock();
    mock.call.mockImplementation(async (command: string) => {
      if (command === 'GetStreamServiceSettings') {
        return {
          streamServiceType: 'rtmp_custom',
          streamServiceSettings: { server: 'rtmp://right/', key: 'WRONG-KEY' },
        };
      }
      return {};
    });

    await expect(
      obsService.assertActiveStreamServiceSettings({
        rtmpUrl: 'rtmp://right/',
        streamKey: 'RIGHT-KEY',
      }),
    ).rejects.toThrow(/OBS stream key does not match/);
  });

  it('all match → resolves without throwing', async () => {
    await arriveConnected();
    const mock = obsMock();
    mock.call.mockImplementation(async (command: string) => {
      if (command === 'GetStreamServiceSettings') {
        return {
          streamServiceType: 'rtmp_custom',
          streamServiceSettings: { server: 'rtmp://right/', key: 'KEY' },
        };
      }
      return {};
    });

    await expect(
      obsService.assertActiveStreamServiceSettings({
        rtmpUrl: 'rtmp://right/',
        streamKey: 'KEY',
      }),
    ).resolves.toBeUndefined();
  });
});

// ---- startStreaming ----

describe('startStreaming', () => {
  it('outputActive flips true on second poll → state transitions to "streaming"', async () => {
    vi.useFakeTimers();
    try {
      await arriveConnected();
      const mock = obsMock();
      let getStreamStatusCalls = 0;
      mock.call.mockImplementation(async (command: string) => {
        if (command === 'StartStream') return {};
        if (command === 'GetStreamStatus') {
          getStreamStatusCalls += 1;
          return { outputActive: getStreamStatusCalls >= 2 };
        }
        return {};
      });

      const promise = obsService.startStreaming();
      // Advance through the poll cadence (250 ms each).
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(300);
      const result = await promise;
      expect(result.state).toBe('streaming');
      expect(obsService.getStatus().state).toBe('streaming');
    } finally {
      vi.useRealTimers();
    }
  });

  it('outputActive never true within 5s → throws the OBS-blocking-modal message', async () => {
    vi.useFakeTimers();
    try {
      await arriveConnected();
      const mock = obsMock();
      mock.call.mockImplementation(async (command: string) => {
        if (command === 'StartStream') return {};
        if (command === 'GetStreamStatus') return { outputActive: false };
        return {};
      });

      const promise = obsService.startStreaming().catch((e) => e);
      await vi.advanceTimersByTimeAsync(6000);
      const err = await promise;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(
        /OBS accepted the StartStream command but is not actually streaming/,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- OBS event handlers ----

describe('OBS event handlers', () => {
  it('ConnectionClosed from "connected" → state becomes "disconnected"', async () => {
    await arriveConnected();
    obsMock().__fire('ConnectionClosed', { code: 1000, reason: 'test' });
    expect(obsService.getStatus().state).toBe('disconnected');
  });

  it('ConnectionClosed from "streaming" → state becomes "disconnected"', async () => {
    await arriveConnected();
    obsMock().__fire('StreamStateChanged', { outputActive: true });
    expect(obsService.getStatus().state).toBe('streaming');
    obsMock().__fire('ConnectionClosed', { code: 1006, reason: 'killed' });
    expect(obsService.getStatus().state).toBe('disconnected');
  });

  it('StreamStateChanged(true) from "connected" → state becomes "streaming"', async () => {
    await arriveConnected();
    obsMock().__fire('StreamStateChanged', { outputActive: true });
    expect(obsService.getStatus().state).toBe('streaming');
  });

  it('StreamStateChanged(false) from "streaming" → state becomes "connected"', async () => {
    await arriveConnected();
    obsMock().__fire('StreamStateChanged', { outputActive: true });
    expect(obsService.getStatus().state).toBe('streaming');
    obsMock().__fire('StreamStateChanged', { outputActive: false });
    expect(obsService.getStatus().state).toBe('connected');
  });

  it('StreamStateChanged(true) from "disconnected" (unexpected) → state does NOT flip', () => {
    // Baseline is disconnected.
    expect(obsService.getStatus().state).toBe('disconnected');
    obsMock().__fire('StreamStateChanged', { outputActive: true });
    expect(obsService.getStatus().state).toBe('disconnected');
  });
});

// ---- health polling lifecycle ----

describe('health polling lifecycle', () => {
  it('starts on "connected" → "streaming" transition (poller calls GetStreamStatus)', async () => {
    vi.useFakeTimers();
    try {
      await arriveConnected();
      const mock = obsMock();
      mock.call.mockImplementation(async (command: string) => {
        if (command === 'GetStreamStatus') return { outputBytes: 0 };
        if (command === 'GetStats') return { activeFps: 30, averageFrameRenderTime: 10 };
        return {};
      });
      // Flip into 'streaming' — this starts the health poller and runs the
      // first tick immediately.
      obsMock().__fire('StreamStateChanged', { outputActive: true });
      // The first poll tick is microtask-scheduled; flush it.
      await vi.advanceTimersByTimeAsync(0);
      // After the first tick, advance by the poll interval to trigger a second.
      await vi.advanceTimersByTimeAsync(2000);

      const getStatusCalls = mock.call.mock.calls.filter(
        (c: unknown[]) => c[0] === 'GetStreamStatus',
      );
      expect(getStatusCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops on "streaming" → "connected" transition (notifies health listener with null)', async () => {
    vi.useFakeTimers();
    try {
      await arriveConnected();
      const mock = obsMock();
      mock.call.mockImplementation(async (command: string) => {
        if (command === 'GetStreamStatus') return { outputBytes: 0 };
        if (command === 'GetStats') return { activeFps: 30 };
        return {};
      });
      obsMock().__fire('StreamStateChanged', { outputActive: true });
      await vi.advanceTimersByTimeAsync(0);

      const healthSeen: Array<unknown> = [];
      const unsubscribe = obsService.subscribeHealth((h) => healthSeen.push(h));
      try {
        // Flip back to 'connected' — should stop polling and notify null.
        obsMock().__fire('StreamStateChanged', { outputActive: false });
        await vi.advanceTimersByTimeAsync(0);
        // After the transition the last notification should be null.
        expect(healthSeen[healthSeen.length - 1]).toBeNull();
      } finally {
        unsubscribe();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('bitrate ring buffer accepts new samples and caps at 64', async () => {
    vi.useFakeTimers();
    try {
      await arriveConnected();
      const mock = obsMock();
      // Step 1000 bytes per poll = predictable bitrate samples.
      let bytes = 0;
      mock.call.mockImplementation(async (command: string) => {
        if (command === 'GetStreamStatus') {
          bytes += 1000;
          return {
            outputBytes: bytes,
            outputSkippedFrames: 0,
            outputTotalFrames: 100,
            outputCongestion: 0,
            outputDuration: 0,
          };
        }
        if (command === 'GetStats') return { activeFps: 30, averageFrameRenderTime: 10 };
        return {};
      });

      obsMock().__fire('StreamStateChanged', { outputActive: true });
      // Drive 70 ticks of the health poller; the buffer is capped at 64.
      for (let i = 0; i < 70; i++) {
        await vi.advanceTimersByTimeAsync(1500);
      }
      const history = obsService.getBitrateHistory();
      expect(history.length).toBeLessThanOrEqual(64);
      expect(history.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- probe ----
//
// probe() opens a raw browser WebSocket. We stub the global to control
// open/error timing.

describe('probe', () => {
  // We swap the global WebSocket for a fake. EventTarget gives us
  // addEventListener/dispatchEvent for free.
  class FakeWebSocket extends EventTarget {
    static instances: FakeWebSocket[] = [];
    closed = false;
    constructor(public url: string) {
      super();
      FakeWebSocket.instances.push(this);
    }
    close() {
      this.closed = true;
    }
  }

  let originalWebSocket: typeof globalThis.WebSocket | undefined;

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    FakeWebSocket.instances = [];
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    if (originalWebSocket) {
      (globalThis as { WebSocket: typeof globalThis.WebSocket }).WebSocket = originalWebSocket;
    }
  });

  it('resolves true when the fake WebSocket opens', async () => {
    const promise = obsService.probe({ timeoutMs: 500 });
    // Fire open immediately.
    await Promise.resolve();
    const ws = FakeWebSocket.instances[0]!;
    ws.dispatchEvent(new Event('open'));
    expect(await promise).toBe(true);
    expect(ws.closed).toBe(true);
  });

  it('resolves false on timeout', async () => {
    vi.useFakeTimers();
    try {
      const promise = obsService.probe({ timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(150);
      expect(await promise).toBe(false);
      // The probe should have closed the (still-pending) socket on timeout.
      expect(FakeWebSocket.instances[0]?.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the underlying WebSocket on error', async () => {
    const promise = obsService.probe({ timeoutMs: 500 });
    await Promise.resolve();
    const ws = FakeWebSocket.instances[0]!;
    ws.dispatchEvent(new Event('error'));
    expect(await promise).toBe(false);
    expect(ws.closed).toBe(true);
  });
});
