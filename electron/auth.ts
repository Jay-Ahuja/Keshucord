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

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_LEEWAY_MS = 60_000;

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

  const authUrl = new URL(AUTH_ENDPOINT);
  const params = authUrl.searchParams;
  params.set('client_id', clientId);
  params.set('redirect_uri', redirectUri);
  params.set('response_type', 'code');
  params.set('scope', SCOPES.join(' '));
  params.set('state', state);
  params.set('code_challenge', pkce.challenge);
  params.set('code_challenge_method', 'S256');
  params.set('access_type', 'offline');
  params.set('prompt', 'consent');

  await shell.openExternal(authUrl.toString());

  const code = await codePromise;

  const tokens = await exchangeCode({
    clientId,
    clientSecret,
    code,
    codeVerifier: pkce.verifier,
    redirectUri,
  });

  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Revoke previous access at https://myaccount.google.com/permissions and sign in again.',
    );
  }

  const user = await fetchUserProfile(tokens.access_token);

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

  return user;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const stored = await tokenStore.load();
  if (!stored) return null;
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

export async function getAccessToken(): Promise<string | null> {
  const stored = await tokenStore.load();
  if (!stored) return null;
  if (stored.expiresAt - Date.now() > TOKEN_REFRESH_LEEWAY_MS) {
    return stored.accessToken;
  }
  const refreshed = await refresh(stored);
  return refreshed?.accessToken ?? null;
}

export async function signOut(): Promise<void> {
  const stored = await tokenStore.load();
  if (stored?.refreshToken) {
    try {
      await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(stored.refreshToken)}`, {
        method: 'POST',
      });
    } catch {
      // best-effort
    }
  }
  await tokenStore.clear();
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
    await tokenStore.clear();
    return null;
  }
  const data = (await res.json()) as Omit<GoogleTokenResponse, 'refresh_token'> & {
    refresh_token?: string;
  };
  const next: tokenStore.StoredTokens = {
    ...stored,
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope ?? stored.scope,
    tokenType: data.token_type ?? stored.tokenType,
    refreshToken: data.refresh_token ?? stored.refreshToken,
  };
  await tokenStore.save(next);
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
    throw new Error(`${url} returned ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
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
