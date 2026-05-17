# YouTube Integration

> All YouTube code that touches tokens lives in the **main process**. The
> renderer only sees high-level results. See `architecture.md` §5.
>
> User-facing Google Cloud Console setup is documented in
> [`oauth-setup.md`](./oauth-setup.md). This file documents how the app
> implements the flow.

## 1. OAuth flow

The app uses **OAuth 2.0 for Installed Apps** — Google's recommended flow
for desktop apps. Implementation: [`electron/auth.ts`](../electron/auth.ts).

### Scopes requested

```ts
const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];
```

`youtube.force-ssl` is the only "sensitive" scope. Read + write on the
user's YouTube channel — broadcasts, live streams, videos.

### Flow

```
User clicks "Continue with YouTube" in LoginScreen
   │
   ▼
youtubeService.signIn()                          ← renderer
   │
   ▼ window.keshucord.auth.signIn()
   │   (IPC: auth:sign-in)
   ▼
electron/auth.ts::signIn()                       ← main process
   │
   ├─ Generate `state` (random 16 bytes, base64url)
   ├─ Generate PKCE pair (verifier + S256 challenge)
   ├─ startLoopback(state) → opens an HTTP server on 127.0.0.1:<random>
   │                          and returns { port, codePromise }
   │
   ├─ Build authUrl =
   │    https://accounts.google.com/o/oauth2/v2/auth
   │      ?client_id=…&redirect_uri=http://127.0.0.1:<port>
   │      &response_type=code
   │      &scope=openid email profile .../youtube.force-ssl
   │      &state=…&code_challenge=…&code_challenge_method=S256
   │      &access_type=offline&prompt=consent
   │
   ├─ shell.openExternal(authUrl)
   │
   │  ── User completes Google consent in their default browser ──
   │
   ├─ Google redirects to http://127.0.0.1:<port>/?code=…&state=…
   ├─ The loopback server receives the request:
   │    · Validates `state` matches
   │    · Returns a styled "Signed in / Sign-in failed" HTML page
   │    · Resolves codePromise with the auth code
   │    · Closes the server
   │
   ├─ exchangeCode({ code, codeVerifier, redirectUri, clientId, clientSecret })
   │    POST https://oauth2.googleapis.com/token
   │    grant_type=authorization_code
   │    → { access_token, refresh_token, expires_in, scope, token_type, id_token }
   │
   ├─ Assert `refresh_token` present (`prompt=consent` makes Google always return it)
   │
   ├─ fetchUserProfile(access_token):
   │    Promise.all([
   │      GET openidconnect.googleapis.com/v1/userinfo,
   │      GET .../youtube/v3/channels?part=snippet&mine=true,
   │    ])
   │
   ├─ tokenStore.save({
   │     accessToken, refreshToken, expiresAt: now + expires_in*1000,
   │     scope, tokenType,
   │     user: { id, email, name, avatarUrl, channelId, channelTitle, channelThumbnailUrl }
   │   })
   │
   └─ return user
                              │
                              ▼
                  IPC bridge back to renderer
                              │
                              ▼
                  LoginScreen receives YouTubeUser
                              │
                              ▼
                  App: setUser(user); setScreen('create')
```

### Loopback server details

Listens on `127.0.0.1:0` (OS-assigned port). The port is read after `.listen` succeeds and used as the redirect URI in the auth URL.

The server handles a single request, then closes. Timeout: **5 minutes** —
if the user doesn't complete the consent in that window, the loopback
rejects with "Sign-in timed out after 5 minutes." and the launch fails
gracefully.

The server **validates `state`** before resolving — protects against
arbitrary loopback callbacks. Mismatch throws "State mismatch. The
sign-in attempt may have been tampered with — try again."

### Why PKCE for a desktop app with a client_secret

Google issues a `client_secret` for installed apps even though they can't
keep it secret. PKCE protects against an attacker intercepting the auth
code — without the verifier (which only lives in the running app's
memory), the code can't be exchanged. The client_secret is still required
by Google's endpoint; we read it from `process.env.GOOGLE_CLIENT_SECRET`
loaded via `dotenv` from `.env`.

## 2. Token handling / storage

### At rest

[`electron/tokenStore.ts`](../electron/tokenStore.ts). One JSON blob,
encrypted via Electron's `safeStorage`, written to
`<app.getPath('userData')>/tokens.enc` with mode 0o600.

```ts
interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;      // epoch ms
  scope: string;
  tokenType: string;
  user: StoredUser;       // cached profile so we don't re-fetch on every boot
}
```

`safeStorage` uses the OS keychain (DPAPI on Windows, Keychain on macOS,
libsecret on Linux). `save()` refuses to write if encryption isn't
available — never falls back to plaintext.

`load()` tries to read + decrypt; returns `null` on any failure (file
missing, decryption failed, JSON malformed). The auth flow treats this as
"not signed in" and falls through to the login screen.

`clear()` `fs.unlink`s the file. Errors swallowed (file may already be
gone).

### At runtime

`auth.getAccessToken()` is the single way to get a usable token:

```
getAccessToken()
   │
   ├─ tokenStore.load()
   │   └─ no tokens → return null
   │
   ├─ if (stored.expiresAt - Date.now() > 60_000):
   │     // still valid, > 60 s leeway
   │     return stored.accessToken
   │
   └─ refresh(stored):
        POST oauth2.googleapis.com/token
          grant_type=refresh_token
          refresh_token=…&client_id=…&client_secret=…
        │
        ├─ ok → save refreshed tokens → return new access_token
        │
        └─ not ok → tokenStore.clear() → return null
                   (caller treats as signed-out)
```

Every `electron/youtube.ts` API call goes through `call()`, which calls
`auth.getAccessToken()` per request. If it returns null, the call throws
"Not signed in to YouTube. Sign in from the login screen and try again."

### Sign out

```
auth.signOut()
   ├─ stored = tokenStore.load()
   ├─ if stored.refreshToken:
   │      fetch(oauth2.googleapis.com/revoke?token=…, { method: POST })  ← best effort
   │
   └─ tokenStore.clear()
```

If revoke fails (network blip, token already revoked) we don't fail the
sign-out — the local clear has happened, the user is logged out from the
app's perspective.

## 3. YouTube Data API client

[`electron/youtube.ts`](../electron/youtube.ts). Plain `fetch` against
`https://www.googleapis.com/youtube/v3`. No `googleapis` SDK dependency.

### `call()` helper

```ts
async function call<T>(url, init): Promise<T> {
  const token = await auth.getAccessToken();
  if (!token) throw new Error('Not signed in …');

  const res = await fetch(url, {
    method: init.method,
    headers: { authorization: `Bearer ${token}`,
               ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  if (!res.ok) throw new Error(await explainError(res));
  if (res.status === 204) return undefined as T;
  return await res.json() as T;
}
```

`explainError(res)` maps known error reasons (`authError`,
`insufficientPermissions`, `quotaExceeded`, `rateLimitExceeded`,
`liveStreamingNotEnabled`, `liveBroadcastBindingNotAllowed`,
`errorStreamInactive`, `invalidTransition`, `redundantTransition`,
`invalidValue`, `badRequest`) to actionable messages. The full list with
exact strings lives in the file.

### Logging

```ts
function log(...args) { console.info('[youtube]', ...args); }
function maskKey(key)  { return `<${key.length}-char key ending …${key.slice(-4)}>`; }
```

Every API function logs entry + relevant return data. Stream keys are
masked.

## 4. Broadcast creation lifecycle

`createBroadcast(input: { title, description?, privacyStatus, category? })`
implements steps 3–and-a-half of the launch flow.

### Step 3 of launch — `liveBroadcasts.insert`

```
POST /liveBroadcasts?part=snippet,contentDetails,status
body: {
  snippet: {
    title, description,
    scheduledStartTime: ISO(now + 30 s)    // YouTube requires this
  },
  contentDetails: {
    enableAutoStart: false,     // we manage transition manually
    enableAutoStop: false,
    enableDvr: true,
    monitorStream: { enableMonitorStream: false },
    latencyPreference: 'low',
  },
  status: {
    privacyStatus,                          // public | unlisted | private
    selfDeclaredMadeForKids: false,
  }
}
```

Returns a fresh broadcast id. We assert `data.id` is present — refuse to
proceed if YouTube returns nothing.

### Then, best-effort category update

If `input.category` is set, after the broadcast is created we attempt:

```
PUT /videos?part=snippet
body: {
  id: broadcast.id,
  snippet: {
    title: input.title,
    description: input.description ?? '',
    categoryId: inferCategoryId(input.category),     // "20" gaming default
    tags: [input.category],
  }
}
```

`liveBroadcasts` doesn't expose `snippet.categoryId` directly — that lives
on the underlying video resource. `inferCategoryId` maps common strings to
known YouTube category IDs (music → "10", gaming → "20", "just chatting"
→ "22", "software & game dev" → "28", etc.) with "20" (Gaming) as the
default.

This call is wrapped in a `try/catch` — if YouTube rejects the categoryId
update (e.g. because the resource isn't a normal video yet), we log a
warning and continue. The broadcast still has the correct title +
description + privacy.

### Return shape

```ts
{
  id, title, description, privacy,
  category: input.category ?? '',
  status: data.status.lifeCycleStatus,
  watchUrl: `https://www.youtube.com/watch?v=${id}`,
  scheduledStartTime,
}
```

## 5. Live stream creation lifecycle

### Step 4 of launch — `liveStreams.insert`

```
POST /liveStreams?part=snippet,cdn,contentDetails
body: {
  snippet: { title: input.title || 'Keshucord live' },
  cdn: {
    frameRate: 'variable',     // OBS dictates
    ingestionType: 'rtmp',
    resolution: 'variable',
  },
  contentDetails: {
    isReusable: false,         // fresh stream per launch — fresh key
  }
}
```

`isReusable: false` is significant: each launch gets a unique stream key.
We never reuse keys across launches. Trade-off: every launch costs a quota
unit and produces an orphan resource on failure. The benefit is that key
leakage from a previous failed launch doesn't compromise the next one.

Assertion: `data.id` must be present, else throw. Returns
`{ id, title }`.

### Step 6 of launch — `liveStreams.list` (ingestion info)

```
GET /liveStreams?part=cdn,status&id=<streamId>
```

Returns the ingestion endpoint details after the stream resource is
provisioned (usually instant — but YouTube can return "no ingestion info
available yet" if read too fast; we surface that as an error and the user
can retry).

Identity assertions (both throw if violated):

1. `data.items[0]` must exist (`Stream ${streamId} not found`).
2. `data.items[0].id === streamId` — guards against pagination / cache
   weirdness returning a different stream.

Then we extract:

```ts
{
  streamId: item.id,
  streamKey: info.streamName,
  rtmpUrl: info.rtmpsIngestionAddress ?? info.ingestionAddress,
  backupRtmpUrl: info.rtmpsBackupIngestionAddress ?? info.backupIngestionAddress,
}
```

We prefer **RTMPS** when YouTube provides it. As of 2025 the API always
returns it; we keep the `?? info.ingestionAddress` fallback for safety.

## 6. Stream binding flow

### Step 5 of launch — `liveBroadcasts.bind`

```
POST /liveBroadcasts/bind?part=id,contentDetails&id=<broadcastId>&streamId=<streamId>
```

Returns the broadcast resource with `contentDetails.boundStreamId` set.

Three identity assertions:

1. `data.id === broadcastId` — bind response is for the broadcast we sent.
2. `data.contentDetails.boundStreamId` is present.
3. `data.contentDetails.boundStreamId === streamId` — YouTube bound to our
   stream, not someone else's.

Any failure throws with a precise message naming the actual vs expected
ids. The orchestrator's catch block then cleans up.

## 7. Transition-to-live flow

### Step 10 of launch — wait for active, then transition

`waitForStreamActive` is a **renderer-side** helper in
[`src/services/youtubeService.ts`](../src/services/youtubeService.ts). It
polls `getStreamStatus` (which calls `liveStreams.list?part=status`)
every 2 seconds until YouTube reports `active` or 90 seconds elapse.

```
launchService 'go-live' step:
   ├─ youtube.waitForStreamActive(stream.id, { signal, onTick })
   │    while (Date.now() < deadline) {
   │      if (signal.aborted) throw
   │      const status = await getStreamStatus(streamId)   ◄── ipc → youtube:get-stream-status
   │      onTick({ status, elapsedSeconds })               ◄── drives UI counter
   │      if (status === 'active') return
   │      if (status === 'error')  throw "YouTube reports stream in error state…"
   │      await sleep(2000, signal)
   │    }
   │    throw "Timed out waiting for YouTube to receive video from OBS. …"
   │
   └─ youtube.transitionToLive(broadcast)
        └─ window.keshucord.youtube.transitionToLive(broadcast.id)
             └─ POST /liveBroadcasts/transition?part=snippet,status,contentDetails
                  &broadcastStatus=live&id=<broadcastId>
                  → broadcast with status.lifeCycleStatus = 'live'
```

The transition call's response is merged with the local broadcast object:

```ts
return {
  ...broadcast,                    // keep the original snippet, watchUrl, etc.
  status: updated.status,          // ← the new lifeCycleStatus
  scheduledStartTime: updated.scheduledStartTime || broadcast.scheduledStartTime,
};
```

LaunchStatusScreen's `done = broadcast?.status === 'live'` check uses this
status to flip the ring + chips into the "live" state.

## 8. Cleanup-on-failure

Built into `_runLaunchSequence`'s outer `try/catch` block:

```ts
catch (err) {
  const deleted: string[] = [];
  const tasks: Promise<unknown>[] = [];
  if (broadcast) tasks.push(youtube.deleteBroadcast(broadcast.id).then(…));
  if (stream)    tasks.push(youtube.deleteLiveStream(stream.id).then(…));
  if (tasks.length > 0) {
    await Promise.allSettled(tasks);    // never blocks the original error
    if (deleted.length > 0) onEvent({ type: 'cleanup', deleted });
  }
  throw err;
}
```

Each delete is best-effort — if it fails (rare, but possible if YouTube
returns a transient 5xx), we log a warning and continue. The original
error is what the user sees.

Deletion APIs:

| Renderer | Main process | YouTube API |
|---|---|---|
| `youtube.deleteBroadcast(id)` | `electron/youtube.ts::deleteBroadcast` | `DELETE /liveBroadcasts?id=<id>` |
| `youtube.deleteLiveStream(id)` | `electron/youtube.ts::deleteLiveStream` | `DELETE /liveStreams?id=<id>` |

Both are simple — call, expect 204, throw via `explainError` on failure.

## 9. Error handling strategy

Three layers:

1. **YouTube API errors** — mapped by `explainError` in `electron/youtube.ts`
   to actionable user-facing messages. The error reason (`authError`,
   `quotaExceeded`, `liveStreamingNotEnabled`, etc.) drives the message.
   Unknown reasons fall through to `YouTube API error (${status}):
   ${message}`.
2. **Token-level errors** — `auth.getAccessToken()` returns `null` if the
   refresh fails; `call()` throws `'Not signed in to YouTube. Sign in from
   the login screen and try again.'`
3. **Orchestrator-level cleanup** — `_runLaunchSequence`'s catch deletes
   orphan resources and re-throws so the screen surfaces the original
   message.

All YouTube errors surface in the UI as red panels under the relevant
button/section. No toasts.

## 10. Rate limits

YouTube Data API v3 has a daily quota of **10,000 units** by default.
Per-call cost is documented at <https://developers.google.com/youtube/v3/determine_quota_cost>.

For one launch:

| Call | Cost |
|---|---|
| `liveBroadcasts.insert` | 50 |
| `videos.update` (category) | 50 |
| `liveStreams.insert` | 50 |
| `liveBroadcasts.bind` | 50 |
| `liveStreams.list` (ingestion) | 1 |
| `liveStreams.list` (status, polled ~5–45× during go-live) | 1 each |
| `liveBroadcasts.transition` | 50 |
| **Total** | ~250 + (1 per ~2 s polled) |

A user can comfortably launch ~30 broadcasts per day on the default
quota, less if they accumulate orphans (each cleanup `delete*` is 50).

We do **not** implement client-side rate-limit handling. If YouTube returns
`quotaExceeded` or `rateLimitExceeded`, `explainError` surfaces the message
and the launch fails. The user has to wait or request quota expansion in
Google Cloud Console.

## 11. Known API limitations / issues

- **Scheduling not implemented.** CreateScreen has a "Schedule" mode but
  the date/time inputs are disabled and the Go Live button refuses to
  submit. Wiring requires passing the user-provided `scheduledStartTime`
  into `createBroadcast` instead of `now + 30 s`, plus deciding whether to
  drive UI off of `liveBroadcastTransition` events.
- **Single account.** `tokenStore` holds one set of tokens. Multi-account
  switching requires `Record<accountId, StoredTokens>` and an
  `activeAccountId` pointer. The Settings → YouTube Account → Connect
  channel button is disabled accordingly.
- **No subscriber/viewer fetch.** YouTube exposes
  `channels.list?part=statistics` for sub count and
  `videos.list?part=liveStreamingDetails` for `concurrentViewers`. Neither
  is fetched today. Dash's preview overlay would benefit.
- **Best-effort category update.** Because `liveBroadcasts.insert` doesn't
  accept `categoryId`, we attempt `videos.update` after creation. If this
  fails (some account / broadcast states don't allow it), the broadcast
  is still created — but the category falls back to YouTube's default. We
  do not surface this as an error; only a console warning.
- **No tags / thumbnail support.** CreateScreen's tags input and
  thumbnail dropzone are UI-only. The tags field could be plumbed through
  the same `videos.update` call. Thumbnail upload requires
  `thumbnails.set` with multipart upload, which is more involved.
- **`isReusable: false` forces per-launch stream creation.** Reusable
  streams would cut quota usage but require maintaining a "user's
  preferred stream id" in settings. Not implemented.
- **No `monitorStream` mode.** We always set `monitorStream:
  enableMonitorStream: false`. Some streamers prefer the
  testing → live transition workflow that monitor-stream enables; that
  would require an extra UI affordance + an extra transition step.
- **Orphan cleanup is best-effort.** If a delete fails after a launch
  failure, we log + continue. The user could accumulate dead broadcasts
  in their YouTube Studio over time. There's no "list and clean up
  orphans" surface.

## 12. Constraints / assumptions

- **`.env` configured.** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are
  read from `process.env` at sign-in time. If missing, `signIn` throws
  with the message "Google OAuth is not configured. Create a Desktop OAuth
  client in Google Cloud Console and set GOOGLE_CLIENT_ID and
  GOOGLE_CLIENT_SECRET in Keshucord/.env. See docs/oauth-setup.md."
- **Test users.** During the OAuth consent screen's "Testing" status,
  only listed Test users can sign in. See `oauth-setup.md`.
- **OAuth state validated.** The loopback server rejects callbacks where
  `state` doesn't match.
- **`prompt=consent` always set.** Forces Google to return a refresh
  token every time. Without this, the second sign-in for a given account
  often only returns an access token.
- **No network-level retry.** A 5xx during any YouTube call fails the
  launch (and triggers cleanup of whatever was already created). The user
  retries manually.
