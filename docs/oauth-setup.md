# Google OAuth setup

Keshucord uses **OAuth 2.0 for Installed Apps** (loopback IP redirect + PKCE) to talk to YouTube. You bring your own Google Cloud project; the app never sees other users' credentials.

Total time: ~5 minutes.

---

## 1. Create / pick a Google Cloud project

1. Go to <https://console.cloud.google.com/>.
2. Top-bar project picker → **New project**.
3. Name it something like `keshucord-dev`. Click Create.

## 2. Enable the YouTube Data API v3

LiveBroadcasts and LiveStreams endpoints live inside this API.

1. **APIs & Services → Library**.
2. Search "YouTube Data API v3" → **Enable**.

## 3. Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen**.
2. **User type: External** (unless you're on a Google Workspace org and want Internal-only).
3. App information:
   - App name: `Keshucord`
   - User support email: your address
   - Developer contact: your address
4. **Scopes** — click "Add or remove scopes" and add exactly these four:
   - `openid`
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
   - `.../auth/youtube.force-ssl` ← the only "sensitive" one; grants read/write on the user's YouTube account (broadcasts, streams, etc.)
5. **Test users** — add your own Google account email.
   > ⚠️ While the consent screen is in **Testing** status, only listed test users can sign in. To let anyone sign in you'd need to **Publish** the app, which requires Google review for the `youtube.force-ssl` scope. For personal use, leave it in Testing.

## 4. Create the OAuth client

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. **Application type: Desktop app**.
3. Name: `Keshucord desktop`.
4. Click **Create**. A dialog shows your **Client ID** and **Client secret** — copy them.

> Why a "secret" for a desktop app? Google still issues one for desktop clients, but it isn't truly secret — it's distributed with the app. The flow is hardened with **PKCE** (the app proves it started the request by sending a code verifier that matches the challenge it sent earlier). Don't reuse this client_id/secret in a server-side flow.

## 5. Drop the credentials into Keshucord

Create `Keshucord/.env`:

```env
GOOGLE_CLIENT_ID=1234567890-xxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxx
```

`.env` is in `.gitignore` — do not commit it.

`npm run dev` reads `.env` on startup. For a packaged build, set the env vars in the shell that launches the app.

---

## What the app does at runtime

When you click **Sign in with YouTube**, the Electron main process:

1. Generates a random `state` and a **PKCE pair** (`code_verifier` + `code_challenge` = base64url(SHA-256(verifier))).
2. Starts a one-shot HTTP server on `http://127.0.0.1:<random_port>`.
3. Opens your default browser at `accounts.google.com/o/oauth2/v2/auth` with:
   - `client_id`
   - `redirect_uri=http://127.0.0.1:<port>`
   - `scope=openid email profile https://www.googleapis.com/auth/youtube.force-ssl`
   - `state`, `code_challenge`, `code_challenge_method=S256`
   - `access_type=offline`, `prompt=consent` (forces Google to return a refresh token)
4. Google redirects back to the loopback server with `?code=…&state=…`.
5. The main process POSTs to `oauth2.googleapis.com/token` with `code + client_secret + code_verifier` and gets `access_token`, `refresh_token`, `expires_in`.
6. Fetches `openidconnect.googleapis.com/v1/userinfo` and `youtube/v3/channels?mine=true` to identify the user + channel.
7. Encrypts the token blob with Electron's [`safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage) (DPAPI on Windows, Keychain on macOS, libsecret on Linux) and writes it to `<userData>/tokens.enc`.
8. The renderer only ever sees a `YouTubeUser` object — never the raw tokens.

Subsequent launches read `tokens.enc`, decrypt, and skip sign-in. Access tokens refresh silently within 60 s of expiry. Sign out revokes the refresh token via `oauth2.googleapis.com/revoke` and deletes `tokens.enc`.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Error 403: access_denied` in the browser | Your account isn't in the OAuth consent screen's Test users list. |
| `redirect_uri_mismatch` | The OAuth client type is wrong. For Desktop apps Google accepts any `http://127.0.0.1:<port>` automatically — re-create the client as "Desktop app". |
| `invalid_client` on token exchange | `GOOGLE_CLIENT_SECRET` typo in `.env`. |
| `Sign-in timed out after 5 minutes` | You closed the browser tab without finishing. Click sign-in again. |
| No refresh token returned | The app forces `prompt=consent` so this shouldn't happen — but if it does, revoke access at <https://myaccount.google.com/permissions> and sign in again. |
