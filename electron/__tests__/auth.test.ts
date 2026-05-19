import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the electron module before any auth.ts import so the file's top-level
// `import { shell } from 'electron'` doesn't blow up under jsdom.
vi.mock('electron', () => ({
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(s)),
    decryptString: vi.fn((b: Buffer) => b.toString()),
  },
  app: { getPath: vi.fn(() => '/tmp') },
}));

// tokenStore is imported by auth.ts; we mock it so the refresh tests can
// observe `tokenStore.clear()` and `tokenStore.save()` calls without
// touching real disk.
vi.mock('../tokenStore', () => ({
  load: vi.fn(async () => null),
  save: vi.fn(async () => undefined),
  clear: vi.fn(async () => undefined),
}));

import * as auth from '../auth';
import * as tokenStore from '../tokenStore';

// ---- isAuthClassTokenFailure (pure) ----

describe('isAuthClassTokenFailure', () => {
  it('returns true for the three RFC 6749 §5.2 auth-class error codes inside the 4xx range', () => {
    expect(auth.isAuthClassTokenFailure(400, 'invalid_grant')).toBe(true);
    expect(auth.isAuthClassTokenFailure(400, 'invalid_token')).toBe(true);
    expect(auth.isAuthClassTokenFailure(400, 'invalid_request')).toBe(true);
    expect(auth.isAuthClassTokenFailure(401, 'invalid_grant')).toBe(true);
    expect(auth.isAuthClassTokenFailure(403, 'invalid_token')).toBe(true);
  });

  it('returns false for any 5xx, regardless of error code', () => {
    expect(auth.isAuthClassTokenFailure(500, 'invalid_grant')).toBe(false);
    expect(auth.isAuthClassTokenFailure(502, undefined)).toBe(false);
    expect(auth.isAuthClassTokenFailure(503, 'server_error')).toBe(false);
  });

  it('returns false for 429 rate-limit responses (transient, should retry)', () => {
    expect(auth.isAuthClassTokenFailure(429, undefined)).toBe(false);
    expect(auth.isAuthClassTokenFailure(429, 'rate_limit_exceeded')).toBe(false);
  });

  it('returns false for 4xx responses that lack a recognized auth-class error code', () => {
    expect(auth.isAuthClassTokenFailure(400, undefined)).toBe(false);
    expect(auth.isAuthClassTokenFailure(400, 'unknown_error')).toBe(false);
    expect(auth.isAuthClassTokenFailure(400, '')).toBe(false);
  });

  it('returns false for 200 or other non-error statuses', () => {
    // Defensive: callers should never invoke with res.ok, but pinning the
    // contract makes it impossible to misuse.
    expect(auth.isAuthClassTokenFailure(200, 'invalid_grant')).toBe(false);
    expect(auth.isAuthClassTokenFailure(304, 'invalid_grant')).toBe(false);
  });
});

// ---- AuthCancelledError ----

describe('AuthCancelledError', () => {
  it('carries a "timeout" reason and an AuthCancelledError-prefixed message', () => {
    const e = new auth.AuthCancelledError('timeout', 'Sign-in timed out.');
    expect(e.name).toBe('AuthCancelledError');
    expect(e.reason).toBe('timeout');
    expect(e.message).toMatch(/^AuthCancelledError:/);
  });

  it('carries a "user-cancelled" reason and an AuthCancelledError-prefixed message', () => {
    const e = new auth.AuthCancelledError('user-cancelled', 'Cancelled by user.');
    expect(e.name).toBe('AuthCancelledError');
    expect(e.reason).toBe('user-cancelled');
    expect(e.message).toContain('Cancelled by user.');
  });
});

// ---- refresh() retry + classification (fetch-mocked) ----

describe('refresh', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    vi.clearAllMocks();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockTokenStored(): void {
    vi.mocked(tokenStore.load).mockResolvedValue({
      accessToken: 'old-access',
      refreshToken: 'refresh-1',
      // Expires 5 seconds from now → falls inside the refresh leeway window.
      expiresAt: Date.now() + 5_000,
      scope: 'openid email profile https://www.googleapis.com/auth/youtube.force-ssl',
      tokenType: 'Bearer',
      user: {
        id: 'u1',
        email: 'u@example.com',
        name: 'U',
        channelTitle: 'U',
      },
    });
  }

  function mockFetchSequence(responses: Array<() => Response | Promise<Response>>): {
    callCount: () => number;
  } {
    let i = 0;
    globalThis.fetch = vi.fn(async () => {
      const handler = responses[i] ?? responses[responses.length - 1];
      i++;
      return handler();
    }) as unknown as typeof fetch;
    return { callCount: () => i };
  }

  function ok(body: object): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  function err(status: number, body: object): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('502 then 200 → returns refreshed access token, retries once, preserves stored tokens through the retry', async () => {
    mockTokenStored();
    const seq = mockFetchSequence([
      () => err(502, { error: 'bad_gateway' }),
      () =>
        ok({
          access_token: 'new-access',
          expires_in: 3600,
          token_type: 'Bearer',
          scope:
            'openid email profile https://www.googleapis.com/auth/youtube.force-ssl',
        }),
    ]);

    const token = await auth.getAccessToken();
    expect(token).toBe('new-access');
    expect(seq.callCount()).toBe(2);
    // tokenStore.clear must NEVER fire on a transient 502 that we successfully retried.
    expect(vi.mocked(tokenStore.clear)).not.toHaveBeenCalled();
    // The new tokens are persisted via tokenStore.save.
    expect(vi.mocked(tokenStore.save)).toHaveBeenCalledTimes(1);
  });

  it('three 502s in a row → throws transient error, preserves cached tokens', async () => {
    mockTokenStored();
    const seq = mockFetchSequence([
      () => err(502, { error: 'bad_gateway' }),
      () => err(503, { error: 'service_unavailable' }),
      () => err(500, { error: 'internal' }),
    ]);

    await expect(auth.getAccessToken()).rejects.toThrow(
      /refresh failed transiently after 3 attempts/,
    );
    expect(seq.callCount()).toBe(3);
    expect(vi.mocked(tokenStore.clear)).not.toHaveBeenCalled();
    expect(vi.mocked(tokenStore.save)).not.toHaveBeenCalled();
  });

  it('invalid_grant → clears tokens immediately, returns null, no retry', async () => {
    mockTokenStored();
    const seq = mockFetchSequence([() => err(400, { error: 'invalid_grant' })]);

    const token = await auth.getAccessToken();
    expect(token).toBeNull();
    expect(seq.callCount()).toBe(1);
    expect(vi.mocked(tokenStore.clear)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(tokenStore.save)).not.toHaveBeenCalled();
  });

  it('invalid_token → clears tokens immediately, returns null, no retry', async () => {
    mockTokenStored();
    const seq = mockFetchSequence([() => err(401, { error: 'invalid_token' })]);

    const token = await auth.getAccessToken();
    expect(token).toBeNull();
    expect(seq.callCount()).toBe(1);
    expect(vi.mocked(tokenStore.clear)).toHaveBeenCalledTimes(1);
  });

  it('generic 4xx without an auth-class error code → transient, retries, finally throws', async () => {
    mockTokenStored();
    const seq = mockFetchSequence([
      () => err(400, { error: 'something_else' }),
      () => err(400, { error: 'still_not_auth_class' }),
      () => err(400, { error: 'definitely_not' }),
    ]);

    await expect(auth.getAccessToken()).rejects.toThrow(/refresh failed transiently/);
    expect(seq.callCount()).toBe(3);
    expect(vi.mocked(tokenStore.clear)).not.toHaveBeenCalled();
  });

  it('network error then 200 → retries through the catch and returns the new token', async () => {
    mockTokenStored();
    const seq = mockFetchSequence([
      () => {
        throw new Error('network error');
      },
      () =>
        ok({
          access_token: 'new-access',
          expires_in: 3600,
          token_type: 'Bearer',
          scope:
            'openid email profile https://www.googleapis.com/auth/youtube.force-ssl',
        }),
    ]);

    const token = await auth.getAccessToken();
    expect(token).toBe('new-access');
    expect(seq.callCount()).toBe(2);
    expect(vi.mocked(tokenStore.clear)).not.toHaveBeenCalled();
  });

  it('200 but token_type is not Bearer → throws (defensive assertion)', async () => {
    mockTokenStored();
    mockFetchSequence([
      () =>
        ok({
          access_token: 'whatever',
          expires_in: 3600,
          token_type: 'MAC',
          scope:
            'openid email profile https://www.googleapis.com/auth/youtube.force-ssl',
        }),
    ]);

    await expect(auth.getAccessToken()).rejects.toThrow(/token_type "MAC"/);
  });

  it('200 but scope no longer includes youtube.force-ssl → clears tokens, returns null', async () => {
    mockTokenStored();
    mockFetchSequence([
      () =>
        ok({
          access_token: 'new-access',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'openid email profile', // YouTube scope dropped
        }),
    ]);

    const token = await auth.getAccessToken();
    expect(token).toBeNull();
    expect(vi.mocked(tokenStore.clear)).toHaveBeenCalledTimes(1);
  });
});
