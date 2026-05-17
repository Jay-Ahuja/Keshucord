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

function log(...args: unknown[]) {
  console.info('[auth]', ...args);
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

const INSUFFICIENT_SCOPE_MESSAGE =
  'Your YouTube sign-in is missing required permissions. Please sign out and sign in again to grant livestream access. ' +
  "On the Google consent screen, make sure the 'YouTube' permission is selected.";

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

export async function signIn(): Promise<AuthUser> {
  const { clientId, clientSecret } = config();
  const state = base64url(crypto.randomBytes(16));
  const pkce = pkcePair();

  const { port, codePromise } = await startLoopback(state);
  const redirectUri = `http://127.0.0.1:${port}`;

  log('signIn: requested scopes =', SCOPES);

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
  // screen every sign-in. The latter is critical for recovering from a
  // partial-scope state — if the user previously unchecked the YouTube
  // permission, this forces them to re-decide rather than silently re-using
  // the prior decision.
  params.set('access_type', 'offline');
  params.set('prompt', 'consent');
  // Incremental authorization: include previously-granted scopes in the
  // exchanged token. Harmless when there are no prior grants; useful when
  // the user has previously consented to some but not all of our scopes.
  params.set('include_granted_scopes', 'true');

  await shell.openExternal(authUrl.toString());

  const code = await codePromise;

  const tokens = await exchangeCode({
    clientId,
    clientSecret,
    code,
    codeVerifier: pkce.verifier,
    redirectUri,
  });

  log('signIn: granted scopes =', tokens.scope || '<missing>');

  if (!tokens.refresh_token) {
    // Best-effort revoke so we don't leave a token lingering on Google's side
    // with an inert refresh_token-less access_token still active.
    await bestEffortRevoke(tokens.access_token);
    throw new Error(
      'Google did not return a refresh token. Revoke previous access at https://myaccount.google.com/permissions and sign in again.',
    );
  }

  if (!hasRequiredYouTubeScope(tokens.scope)) {
    log(
      'signIn: granted scope is missing the required YouTube scope — revoking partial token and prompting re-consent. ' +
        `granted="${tokens.scope ?? ''}", required="${REQUIRED_YOUTUBE_SCOPE}"`,
    );
    // Don't store these tokens — they're useless to us. Revoke them on
    // Google's side so the user's Google account doesn't accumulate dead
    // grants for our app.
    await bestEffortRevoke(tokens.access_token);
    if (tokens.refresh_token) await bestEffortRevoke(tokens.refresh_token);
    throw new Error(INSUFFICIENT_SCOPE_MESSAGE);
  }

  let user: AuthUser;
  try {
    user = await fetchUserProfile(tokens.access_token);
  } catch (err) {
    // If the userinfo or channels.list call itself returns a 403 with an
    // insufficient-scope reason, surface the friendly message instead of the
    // raw Google API error.
    if (isInsufficientScopeError(err)) {
      log('signIn: API rejected token despite advertised scope — clearing and prompting re-consent');
      await bestEffortRevoke(tokens.access_token);
      if (tokens.refresh_token) await bestEffortRevoke(tokens.refresh_token);
      throw new Error(INSUFFICIENT_SCOPE_MESSAGE);
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
  const res = await fetch(TOKEN_ENDPOINT, {
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
  return (await res.json()) as GoogleTokenResponse;
}

async function refresh(stored: tokenStore.StoredTokens): Promise<tokenStore.StoredTokens | null> {
  const { clientId, clientSecret } = config();
  const res = await fetch(TOKEN_ENDPOINT, {
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
    // Refresh token revoked or expired — clear local state so the user re-signs in.
    log(`refresh: token endpoint returned ${res.status} — clearing local state`);
    await tokenStore.clear();
    return null;
  }
  const data = (await res.json()) as Omit<GoogleTokenResponse, 'refresh_token'> & {
    refresh_token?: string;
  };
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
  const res = await fetch(url, {
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
    log(
      'bestEffortRevoke: revoke failed (continuing anyway):',
      err instanceof Error ? err.message : err,
    );
  } finally {
    clearTimeout(timer);
  }
}

function callbackPage(kind: 'success' | 'error', message: string): string {
  const accent = kind === 'success' ? '#10b981' : '#ef4444';
  const title = kind === 'success' ? 'Signed in' : 'Sign-in failed';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Keshucord</title>
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
<h1>${title}</h1><p>${message}</p></div></body></html>`;
}
