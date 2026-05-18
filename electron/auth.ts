import { shell } from 'electron';
import crypto from 'node:crypto';
import http from 'node:http';
import { URL } from 'node:url';
import * as tokenStore from './tokenStore';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const YOUTUBE_CHANNELS_ENDPOINT =
  'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true';

/**
 * The single YouTube scope required for everything the launch flow does:
 *   - channels.list (read the signed-in channel)
 *   - liveBroadcasts.insert / .bind / .transition / .delete
 *   - liveStreams.insert / .list (ingestion + status) / .delete
 *   - videos.update (best-effort category)
 *
 * `youtube.force-ssl` is a superset of `youtube` plus mandates HTTPS — Google
 * recommends it for any app that mutates the channel over the network. It is
 * the *only* scope that grants the live-streaming endpoints; downgrading to
 * `youtube.readonly` would break everything from step 3 (broadcast) onward.
 *
 * The other scopes (`openid`, `email`, `profile`) are for the OIDC userinfo
 * endpoint we hit during sign-in to display the user's name/avatar.
 */
const REQUIRED_YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

const SCOPES = [
  'openid',
  'email',
  'profile',
  REQUIRED_YOUTUBE_SCOPE,
];

const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_LEEWAY_MS = 60_000;
const REVOKE_TIMEOUT_MS = 5_000;
const TOKENINFO_ENDPOINT = 'https://oauth2.googleapis.com/tokeninfo';
const TOKENINFO_TIMEOUT_MS = 5_000;
/**
 * Hard ceiling for *every* outbound call to Google's OAuth + userinfo +
 * YouTube channels endpoints. Without this, a hung TCP connection (think
 * mid-flight Wi-Fi handover, captive portal, ISP DNS hijack, corporate
 * proxy stalls) leaves the entire sign-in / refresh flow blocked
 * indefinitely — and worse, leaves the user with no actionable error.
 *
 * 15s is long enough that healthy mobile / DSL connections complete a TLS
 * handshake + POST + JSON response with comfortable headroom, and short
 * enough that a stuck network surfaces as a clear timeout error rather
 * than a perceived freeze.
 *
 * `probeTokenInfo` keeps its tighter 5s ceiling — it's purely diagnostic
 * and shouldn't be allowed to slow down sign-in.
 */
const GOOGLE_FETCH_TIMEOUT_MS = 15_000;

function log(...args: unknown[]) {
  console.info('[auth]', ...args);
}

/**
 * HTML-escape arbitrary text before injecting it into the loopback callback
 * page. Required because we render `error_description` (an attacker-controlled
 * query-param string) straight into a `<p>` element — without escaping, a
 * malicious redirect URL could deliver a stored-XSS payload to the loopback
 * page (port-confined and short-lived, but still arbitrary script execution
 * in the user's browser with file: privileges).
 *
 * Order matters: `&` MUST be replaced first, otherwise we'd double-escape
 * the entities introduced by the later replacements (e.g. `&lt;` → `&amp;lt;`).
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Wraps `fetch` with an `AbortController`-based timeout. On timeout the
 * underlying request is aborted and we throw a clear, user-actionable error
 * instead of the generic `AbortError`. All other fetch errors propagate
 * unchanged so callers can distinguish "network failure" from "Google said no".
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = GOOGLE_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || ac.signal.aborted)) {
      throw new Error(
        `Google endpoint timed out after ${Math.round(timeoutMs / 1000)}s — check your network connection (${url}).`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns true if the given `scope` string (space-separated, as returned by
 * Google's token endpoint) grants the YouTube live-streaming capability.
 *
 * We check defensively because Google's consent screen lets the user uncheck
 * individual scopes — if they uncheck "YouTube", the exchanged token will
 * have `openid email profile` but no YouTube access, and every subsequent
 * API call returns ACCESS_TOKEN_SCOPE_INSUFFICIENT. Detecting this at
 * sign-in time gives us a useful error instead of a raw 403.
 */
function hasRequiredYouTubeScope(scope: string | undefined | null): boolean {
  if (!scope) return false;
  return scope.split(/\s+/).includes(REQUIRED_YOUTUBE_SCOPE);
}

/**
 * Build the user-visible error for the insufficient-scope failure. Includes
 * the exact requested vs granted scope diff plus a step-by-step remediation
 * checklist, because the actual fix is almost always in Google Cloud Console
 * (the OAuth consent screen's allowed-scopes list, the YouTube Data API
 * enablement, or the Test-Users list) rather than on the user's side. The
 * generic "sign out and sign in again" wording from the previous fix was
 * misleading — re-doing the OAuth flow can't add a scope that the Cloud
 * Console refuses to surface on the consent page in the first place.
 */
function buildInsufficientScopeDiagnostic(
  requested: readonly string[],
  granted: readonly string[],
): string {
  const missing = requested.filter((s) => !granted.includes(s));
  return [
    'Sign-in completed but Google did not grant the YouTube permission that Keshucord needs.',
    '',
    `Requested scopes: ${requested.join(' ')}`,
    `Granted scopes:   ${granted.length > 0 ? granted.join(' ') : '<none>'}`,
    `Missing:          ${missing.join(' ') || '<none>'}`,
    '',
    'Re-doing the consent flow CANNOT fix this — Google only surfaces scopes that your OAuth client is configured to allow. Fix steps (one-time, in Google Cloud Console):',
    '',
    `1. Open the OAuth consent screen config for your project:`,
    `   https://console.cloud.google.com/apis/credentials/consent`,
    `2. Click "EDIT APP" → reach the "Scopes" step → "ADD OR REMOVE SCOPES".`,
    `3. Filter for "${REQUIRED_YOUTUBE_SCOPE}" and check it. Save.`,
    `4. Confirm the YouTube Data API v3 is enabled for the project:`,
    `   https://console.cloud.google.com/apis/library/youtube.googleapis.com`,
    `5. If "Publishing status" is "Testing", add your Google account under "Test users".`,
    `6. Then sign in again from Keshucord. The consent screen should now show a YouTube permission row.`,
  ].join('\n');
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  channel: string;
  avatarUrl?: string;
  channelId?: string;
  channelThumbnailUrl?: string;
}

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
  id_token?: string;
}

interface GoogleUserInfo {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

interface YouTubeChannelsResponse {
  items?: {
    id: string;
    snippet: {
      title: string;
      thumbnails?: { default?: { url?: string }; medium?: { url?: string } };
    };
  }[];
}

function config(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'Google OAuth is not configured. Create a Desktop OAuth client in Google Cloud Console and set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Keshucord/.env. See docs/oauth-setup.md.',
    );
  }
  return { clientId, clientSecret };
}

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

interface LoopbackHandle {
  port: number;
  codePromise: Promise<string>;
}

function startLoopback(expectedState: string): Promise<LoopbackHandle> {
  return new Promise((resolveSetup, rejectSetup) => {
    let settled = false;
    let codeResolve!: (code: string) => void;
    let codeReject!: (err: Error) => void;
    const codePromise = new Promise<string>((res, rej) => {
      codeResolve = res;
      codeReject = rej;
    });

    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400).end();
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/' && url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }

      const finish = (
        status: number,
        body: string,
        outcome: { code?: string; error?: Error },
      ) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // close after response is flushed
        setTimeout(() => server.close(), 50);
        if (outcome.error) codeReject(outcome.error);
        else if (outcome.code) codeResolve(outcome.code);
      };

      const errorParam = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const receivedState = url.searchParams.get('state');

      if (errorParam) {
        const description = url.searchParams.get('error_description') ?? errorParam;
        finish(400, callbackPage('error', `Google returned an error: ${description}`), {
          error: new Error(`Google OAuth error: ${description}`),
        });
        return;
      }
      if (!code || !receivedState) {
        finish(400, callbackPage('error', 'Missing authorization code in callback.'), {
          error: new Error('Missing authorization code'),
        });
        return;
      }
      if (receivedState !== expectedState) {
        finish(
          400,
          callbackPage(
            'error',
            'State mismatch. The sign-in attempt may have been tampered with — try again.',
          ),
          { error: new Error('State mismatch') },
        );
        return;
      }
      finish(
        200,
        callbackPage('success', 'You can close this tab and return to Keshucord.'),
        { code },
      );
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      codeReject(new Error('Sign-in timed out after 5 minutes. Please try again.'));
    }, SIGN_IN_TIMEOUT_MS);

    server.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectSetup(err);
      codeReject(err);
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        rejectSetup(new Error('Could not start loopback HTTP server.'));
        return;
      }
      resolveSetup({ port: address.port, codePromise });
    });
  });
}

// Single-flight guard for signIn(). Without this, a double-clicked "Sign In"
// button starts two loopback servers + opens two browser tabs; the second
// `startLoopback` would happily bind a *different* random port and the user
// experiences a confusing race where only one tab can succeed. Coalescing
// to the in-flight promise gives both callers the same eventual result.
let signInInFlight: Promise<AuthUser> | null = null;

export function signIn(): Promise<AuthUser> {
  if (signInInFlight) {
    log('signIn: returning in-flight promise (deduped concurrent sign-in)');
    return signInInFlight;
  }
  signInInFlight = signInImpl().finally(() => {
    signInInFlight = null;
  });
  return signInInFlight;
}

async function signInImpl(): Promise<AuthUser> {
  const { clientId, clientSecret } = config();
  const state = base64url(crypto.randomBytes(16));
  const pkce = pkcePair();

  const { port, codePromise } = await startLoopback(state);
  const redirectUri = `http://127.0.0.1:${port}`;

  log('signIn: requested scopes =', SCOPES);

  // Proactively clear any pre-existing tokens before the fresh OAuth round-
  // trip. This guarantees that on a failed sign-in we never silently retain
  // an old session for a different account / older scope set — sign-in is a
  // destructive action by design.
  await tokenStore.clear();

  const authUrl = new URL(AUTH_ENDPOINT);
  const params = authUrl.searchParams;
  params.set('client_id', clientId);
  params.set('redirect_uri', redirectUri);
  params.set('response_type', 'code');
  params.set('scope', SCOPES.join(' '));
  params.set('state', state);
  params.set('code_challenge', pkce.challenge);
  params.set('code_challenge_method', 'S256');
  // `access_type=offline` + `prompt=consent` is the documented combination
  // that guarantees Google returns a refresh_token AND re-shows the consent
  // screen every sign-in — so a user that previously unchecked the YouTube
  // permission gets a fresh chance to grant it. We deliberately do NOT pass
  // `include_granted_scopes=true`: in some flows it caused the token to
  // reuse a prior partial-scope grant rather than honouring the explicit
  // re-request, which was actively masking this bug.
  params.set('access_type', 'offline');
  params.set('prompt', 'consent');

  log(
    `signIn: opening consent at client_id=...${clientId.slice(-8)} redirect=${redirectUri} ` +
      `(scope param length=${SCOPES.join(' ').length})`,
  );

  await shell.openExternal(authUrl.toString());

  const code = await codePromise;

  const tokens = await exchangeCode({
    clientId,
    clientSecret,
    code,
    codeVerifier: pkce.verifier,
    redirectUri,
  });

  // Log the full shape of the exchange response (without secret values) so
  // diagnosing user-reported sign-in failures from logs is unambiguous.
  log('signIn: token exchange response shape =', {
    hasAccessToken: !!tokens.access_token,
    hasRefreshToken: !!tokens.refresh_token,
    expiresIn: tokens.expires_in,
    tokenType: tokens.token_type,
    scope: tokens.scope || '<missing>',
  });

  // Independent verification: ask Google's tokeninfo endpoint what scopes it
  // actually associates with this access token. If the exchange response and
  // tokeninfo disagree we've found something genuinely weird; if they agree
  // and both lack `youtube.force-ssl` we can be certain Google is the source
  // of the missing scope (i.e. the Cloud Console consent screen).
  const tokenInfo = await probeTokenInfo(tokens.access_token);
  log('signIn: tokeninfo verification =', tokenInfo ?? '<unavailable>');

  // Pick the broadest reasonable view of granted scopes: prefer tokeninfo
  // (auth-server source of truth) and fall back to the exchange response.
  const grantedScopes = parseScopeString(tokenInfo?.scope ?? tokens.scope ?? '');
  const missingScopes = SCOPES.filter((s) => !grantedScopes.includes(s));
  log('signIn: scope diff =', {
    requested: SCOPES,
    granted: grantedScopes,
    missing: missingScopes,
  });

  if (!tokens.refresh_token) {
    // Best-effort revoke so we don't leave a token lingering on Google's side
    // with an inert refresh_token-less access_token still active.
    await bestEffortRevoke(tokens.access_token);
    throw new Error(
      'Google did not return a refresh token. Revoke previous access at https://myaccount.google.com/permissions and sign in again.',
    );
  }

  if (!grantedScopes.includes(REQUIRED_YOUTUBE_SCOPE)) {
    log(
      'signIn: granted scopes are missing the required YouTube scope — revoking partial token. ' +
        `granted="${grantedScopes.join(' ')}", required="${REQUIRED_YOUTUBE_SCOPE}"`,
    );
    // Don't store these tokens — they're useless to us. Revoke them on
    // Google's side so the user's Google account doesn't accumulate dead
    // grants for our app.
    await bestEffortRevoke(tokens.access_token);
    if (tokens.refresh_token) await bestEffortRevoke(tokens.refresh_token);
    throw new Error(buildInsufficientScopeDiagnostic(SCOPES, grantedScopes));
  }

  let user: AuthUser;
  try {
    user = await fetchUserProfile(tokens.access_token);
  } catch (err) {
    // If the userinfo or channels.list call returns a 403 with an
    // insufficient-scope reason despite tokens.scope advertising the scope,
    // we have a stronger signal: Google's API gateway disagrees with Google's
    // own token endpoint. This usually means the YouTube Data API v3 isn't
    // enabled in the project, even though the consent screen has the scope.
    // Surface the same diagnostic so the user sees all remediation steps.
    if (isInsufficientScopeError(err)) {
      log(
        'signIn: API rejected token despite advertised scope — likely YouTube Data API v3 disabled in the project',
      );
      await bestEffortRevoke(tokens.access_token);
      if (tokens.refresh_token) await bestEffortRevoke(tokens.refresh_token);
      throw new Error(buildInsufficientScopeDiagnostic(SCOPES, grantedScopes));
    }
    throw err;
  }

  await tokenStore.save({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    scope: tokens.scope,
    tokenType: tokens.token_type,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      channelId: user.channelId,
      channelTitle: user.channel,
      channelThumbnailUrl: user.channelThumbnailUrl,
    },
  });

  log(`signIn: tokens saved for "${user.email}"`);
  return user;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const stored = await tokenStore.load();
  if (!stored) {
    log('getCurrentUser: no cached tokens');
    return null;
  }
  // Catch the common upgrade case: tokens.enc was written by an older build
  // that didn't request `youtube.force-ssl`, or by a sign-in where the user
  // unchecked the YouTube permission. Refreshing a token can NEVER add a
  // scope, so the only fix is a fresh consent flow — clear the stale cache
  // so the next boot drops the user on the login screen.
  if (!hasRequiredYouTubeScope(stored.scope)) {
    log(
      'getCurrentUser: cached tokens lack the required YouTube scope — clearing and requiring re-consent. ' +
        `cached="${stored.scope ?? ''}", required="${REQUIRED_YOUTUBE_SCOPE}"`,
    );
    await tokenStore.clear();
    return null;
  }
  log(`getCurrentUser: returning cached user "${stored.user.email}" (scope ok)`);
  return {
    id: stored.user.id,
    name: stored.user.name,
    email: stored.user.email,
    channel: stored.user.channelTitle ?? stored.user.name,
    avatarUrl: stored.user.avatarUrl,
    channelId: stored.user.channelId,
    channelThumbnailUrl: stored.user.channelThumbnailUrl,
  };
}

// Dedupe concurrent refreshes. Without this, two API calls that both land
// inside the 60-second refresh leeway window would each POST to /token,
// rotating the refresh_token twice — the second call's saved tokens then
// reference a refresh_token that the first call already invalidated.
let pendingRefresh: Promise<tokenStore.StoredTokens | null> | null = null;

export async function getAccessToken(): Promise<string | null> {
  const stored = await tokenStore.load();
  if (!stored) return null;
  // Same scope guard as getCurrentUser — a token whose scope doesn't cover
  // the YouTube live-streaming APIs is worse than no token at all: handing
  // it out causes every subsequent call to fail with a confusing 403 instead
  // of cleanly bouncing the user to the login screen.
  if (!hasRequiredYouTubeScope(stored.scope)) {
    log(
      'getAccessToken: cached scope insufficient — clearing tokens to force re-consent. ' +
        `cached="${stored.scope ?? ''}"`,
    );
    await tokenStore.clear();
    return null;
  }
  if (stored.expiresAt - Date.now() > TOKEN_REFRESH_LEEWAY_MS) {
    log(
      `getAccessToken: reusing cached access token (expires in ${Math.round(
        (stored.expiresAt - Date.now()) / 1000,
      )}s)`,
    );
    return stored.accessToken;
  }
  if (!pendingRefresh) {
    log(
      `getAccessToken: refreshing access token (${Math.round(
        (Date.now() - stored.expiresAt) / 1000,
      )}s past expiry / within leeway)`,
    );
    pendingRefresh = refresh(stored).finally(() => {
      pendingRefresh = null;
    });
  } else {
    log('getAccessToken: awaiting in-flight refresh (deduped)');
  }
  const refreshed = await pendingRefresh;
  return refreshed?.accessToken ?? null;
}

export async function signOut(): Promise<void> {
  // Order matters: we attempt revoke *before* clearing local storage so that
  // even if the revoke fetch hangs and we abort it, the disk clear that
  // follows runs unconditionally. tokens.enc is a single encrypted blob
  // containing access token + refresh token + cached profile, so unlinking
  // it removes all four in one operation.
  const stored = await tokenStore.load();
  if (stored?.refreshToken) {
    log(`signOut: revoking refresh token for "${stored.user.email}"`);
    await bestEffortRevoke(stored.refreshToken);
  }
  await tokenStore.clear();
  log('signOut: local token state cleared');
}

async function exchangeCode(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<GoogleTokenResponse> {
  const res = await fetchWithTimeout(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: args.code,
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code_verifier: args.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: args.redirectUri,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  const tokens = (await res.json()) as GoogleTokenResponse;
  // Google's token endpoint is documented to always return `token_type: "Bearer"`.
  // If that ever changes (or we somehow hit a man-in-the-middle that rewrites
  // the response) we want to fail loudly here rather than silently store a
  // token that the rest of the app would still try to use as a Bearer token.
  if (tokens.token_type !== 'Bearer') {
    throw new Error(
      `Unexpected token_type "${tokens.token_type}" from Google — expected "Bearer".`,
    );
  }
  return tokens;
}

async function refresh(stored: tokenStore.StoredTokens): Promise<tokenStore.StoredTokens | null> {
  const { clientId, clientSecret } = config();
  const res = await fetchWithTimeout(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: stored.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    // === Why we no longer blanket-clear on every !res.ok ============================
    // The previous implementation unconditionally called tokenStore.clear() on any
    // non-2xx response, which made a transient hiccup (502 from Google, a 429 burst,
    // a corporate proxy returning 503, a 5xx during a Google incident, or a 4xx
    // without an auth-class reason) look identical to a real "your refresh token is
    // gone" event. The result: a user who was happily signed in would mysteriously
    // get bounced to the login screen, lose their in-progress launch, and have to
    // redo the whole consent flow — for nothing.
    //
    // The OAuth 2.0 RFC (6749 §5.2) lists the *auth-failure* error codes that
    // truly mean "this refresh_token will never work again": `invalid_grant`,
    // `invalid_token`, `invalid_request`. Everything else (network blip, server
    // error, rate limit, malformed body we can't parse) is recoverable — we throw
    // so the caller's retry logic / outer error boundary can react, and we leave
    // the cached tokens intact so the next attempt has something to refresh.
    //
    // Audit reference: H3 ("silent sign-out on transient refresh failure").
    // ================================================================================
    let errorCode: string | undefined;
    try {
      // Cloning so subsequent .text() / debugging is still possible if needed.
      const body = (await res.json()) as { error?: string; error_description?: string };
      errorCode = typeof body?.error === 'string' ? body.error : undefined;
    } catch {
      // Malformed / non-JSON body from Google — extremely rare, but if it
      // happens we deliberately fall through to the "non-auth-class" branch.
      // It would be unsafe to assume "invalid_grant" without evidence.
      errorCode = undefined;
    }

    const isAuthClass4xx =
      res.status >= 400 &&
      res.status < 500 &&
      (errorCode === 'invalid_grant' ||
        errorCode === 'invalid_token' ||
        errorCode === 'invalid_request');

    if (isAuthClass4xx) {
      log(
        `refresh: token endpoint returned ${res.status} ${errorCode} — clearing local state (genuine auth failure)`,
      );
      await tokenStore.clear();
      return null;
    }

    log(
      `refresh: token endpoint returned ${res.status}${
        errorCode ? ` (error="${errorCode}")` : ''
      } — treating as transient, preserving cached tokens`,
    );
    throw new Error(
      `Google token endpoint returned ${res.status}${
        errorCode ? ` (${errorCode})` : ''
      } — refresh failed transiently. Cached tokens kept; retry later.`,
    );
  }
  const data = (await res.json()) as Omit<GoogleTokenResponse, 'refresh_token'> & {
    refresh_token?: string;
  };
  // Same defensive token_type assertion as exchangeCode — if Google's refresh
  // response ever stops being a Bearer token, fail loudly instead of silently
  // mis-using whatever we got back.
  if (data.token_type !== undefined && data.token_type !== 'Bearer') {
    throw new Error(
      `Unexpected token_type "${data.token_type}" from Google — expected "Bearer".`,
    );
  }
  const nextScope = data.scope ?? stored.scope;
  // A refresh can never *add* a scope — Google issues a token with at most
  // the scopes the refresh_token was originally consented to. So if the
  // refreshed token doesn't include our required scope, neither did the
  // original; bail out and require a fresh consent.
  if (!hasRequiredYouTubeScope(nextScope)) {
    log(
      'refresh: refreshed token lacks required YouTube scope — clearing and requiring re-consent. ' +
        `refreshed="${nextScope}"`,
    );
    await tokenStore.clear();
    return null;
  }
  const next: tokenStore.StoredTokens = {
    ...stored,
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: nextScope,
    tokenType: data.token_type ?? stored.tokenType,
    refreshToken: data.refresh_token ?? stored.refreshToken,
  };
  await tokenStore.save(next);
  log(`refresh: ok (new expiresAt in ${Math.round((next.expiresAt - Date.now()) / 1000)}s)`);
  return next;
}

async function fetchUserProfile(accessToken: string): Promise<AuthUser> {
  const [userinfo, channels] = await Promise.all([
    fetchJson<GoogleUserInfo>(USERINFO_ENDPOINT, accessToken),
    fetchJson<YouTubeChannelsResponse>(YOUTUBE_CHANNELS_ENDPOINT, accessToken),
  ]);
  const channel = channels.items?.[0];
  return {
    id: userinfo.sub,
    name: userinfo.name,
    email: userinfo.email,
    channel: channel?.snippet.title ?? userinfo.name,
    avatarUrl: userinfo.picture,
    channelId: channel?.id,
    channelThumbnailUrl:
      channel?.snippet.thumbnails?.medium?.url ?? channel?.snippet.thumbnails?.default?.url,
  };
}

async function fetchJson<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetchWithTimeout(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    // Detect the specific Google APIs "insufficient scopes" failure shape so
    // sign-in can convert it into a useful user-facing message instead of
    // surfacing the raw JSON error body. The check covers both the legacy
    // `errors[0].reason="insufficientPermissions"` field and the newer
    // `details[].reason="ACCESS_TOKEN_SCOPE_INSUFFICIENT"` field; Google's
    // YouTube endpoints return one or the other depending on age of the API.
    if (res.status === 403 && looksLikeInsufficientScope(text)) {
      throw new InsufficientScopeError(
        `${url} returned 403 with insufficient-scope error: ${text.slice(0, 200)}`,
      );
    }
    throw new Error(`${url} returned ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

class InsufficientScopeError extends Error {
  readonly insufficientScope = true;
}

function looksLikeInsufficientScope(body: string): boolean {
  return (
    body.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT') ||
    body.includes('insufficient authentication scopes') ||
    body.includes('"reason": "insufficientPermissions"') ||
    body.includes('"reason":"insufficientPermissions"')
  );
}

function isInsufficientScopeError(err: unknown): boolean {
  return err instanceof InsufficientScopeError;
}

function parseScopeString(scope: string): string[] {
  return scope.split(/\s+/).filter(Boolean);
}

interface TokenInfoResponse {
  scope?: string;
  expires_in?: string;
  email?: string;
  aud?: string;
}

/**
 * Hits Google's tokeninfo endpoint to verify what scopes the auth server
 * actually attributes to a freshly-issued access token. Used as a second
 * source of truth alongside the token-exchange response's `scope` field —
 * if the two disagree, the user's logs will surface that disagreement and
 * make the underlying Google-side bug debuggable. Bounded at 5s and silent
 * on failure: tokeninfo is purely diagnostic, never load-bearing.
 */
async function probeTokenInfo(accessToken: string): Promise<TokenInfoResponse | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TOKENINFO_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${TOKENINFO_ENDPOINT}?access_token=${encodeURIComponent(accessToken)}`,
      { signal: ac.signal },
    );
    if (!res.ok) {
      log(`probeTokenInfo: ${res.status} ${res.statusText}`);
      return null;
    }
    return (await res.json()) as TokenInfoResponse;
  } catch (err) {
    log('probeTokenInfo: failed (non-fatal):', err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POSTs to Google's revoke endpoint, with a 5s ceiling so a sign-out flow
 * can never hang on a network blip. Failures are logged but never thrown —
 * the local token clear is the authoritative "you are signed out" action.
 */
async function bestEffortRevoke(token: string): Promise<void> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REVOKE_TIMEOUT_MS);
  try {
    await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      signal: ac.signal,
    });
  } catch (err) {
    // Promoted from log() → console.warn so the failure is visible in default
    // log filters (we ship to support with INFO suppressed but WARN+ kept).
    // The user-actionable URL is included because there's literally nothing
    // else they can do to fully revoke if Google's revoke endpoint is down.
    console.warn(
      '[auth] revoke failed during sign-out — refresh token may still be valid on Google\'s servers. ' +
        'The user can revoke at https://myaccount.google.com/permissions. Cause:',
      err instanceof Error ? err.message : err,
    );
  } finally {
    clearTimeout(timer);
  }
}

function callbackPage(kind: 'success' | 'error', message: string): string {
  const accent = kind === 'success' ? '#10b981' : '#ef4444';
  const title = kind === 'success' ? 'Signed in' : 'Sign-in failed';
  // `message` originates from Google's `error_description` query param on the
  // failure path — i.e. attacker-influenceable text. Escaping it before
  // interpolation closes a reflected-XSS vector on the loopback origin (port-
  // confined, but capable of arbitrary script execution in the user's browser
  // and exfiltration of any same-origin state the page can read).
  //
  // The CSP `<meta>` tag is defence-in-depth: even if an escape ever regresses,
  // `default-src 'none'` blocks all script execution (no inline, no remote, no
  // eval), and `style-src 'unsafe-inline'` preserves only the inline style we
  // use to render the card.
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Keshucord</title>
<style>
  html,body{margin:0;height:100%}
  body{display:grid;place-items:center;background:#08080c;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  .card{max-width:420px;padding:40px 36px;text-align:center;border-radius:18px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);box-shadow:0 20px 60px -20px rgba(0,0,0,.6)}
  .brand{display:inline-flex;align-items:center;gap:8px;font-size:12px;letter-spacing:.32em;text-transform:uppercase;color:rgba(255,255,255,.4)}
  .dot{width:8px;height:8px;border-radius:999px;background:${accent};box-shadow:0 0 14px ${accent}}
  h1{margin:18px 0 8px;font-size:22px;font-weight:700}
  p{margin:0;color:rgba(255,255,255,.65);line-height:1.55;font-size:14px}
</style></head>
<body><div class="card"><span class="brand"><span class="dot"></span>Keshucord</span>
<h1>${safeTitle}</h1><p>${safeMessage}</p></div></body></html>`;
}
