# Error Catalog

> Centralized reference for every user-facing and system-facing error
> the app can produce. Organized by subsystem. Use this when diagnosing
> failures or writing new error messages.

## 1. Conventions

All service logs use namespace prefixes:
- `[launch]` — `src/services/launchService.ts`
- `[obs]` — `src/services/obsService.ts`
- `[youtube]` — `electron/youtube.ts` (main process terminal)

Errors surface in the UI as **red inline banners**, never toasts. The
pattern: `<div className="alert err">` below the action that caused the
error. No global error boundary.

Abort errors (`DOMException('Aborted', 'AbortError')`) are silently
ignored by `LaunchStatusScreen` — they're navigation cancellations, not
failures.

---

## 2. Authentication errors

Thrown by `electron/auth.ts`, surfaced via IPC to the renderer.

### `auth:sign-in`

| Error message | Cause | Where shown |
|---|---|---|
| `"Google OAuth is not configured. Create a Desktop OAuth client in Google Cloud Console and set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Keshucord/.env. See docs/oauth-setup.md."` | `.env` missing `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` | LoginScreen red panel |
| `"Sign-in timed out after 5 minutes."` | User didn't complete Google consent within the 5-minute loopback server window | LoginScreen red panel |
| `"State mismatch. The sign-in attempt may have been tampered with — try again."` | `state` parameter in the OAuth callback doesn't match the generated value | LoginScreen red panel |
| `"No refresh token returned. Try again — Google sometimes skips returning it on subsequent authorizations."` | `prompt=consent` should prevent this; appears if the OAuth response lacks a refresh token | LoginScreen red panel |

### `auth:get-current-user` (used in launch step 2)

| Error message | Cause | Where shown |
|---|---|---|
| `"You are not signed in to YouTube. Sign out and sign back in."` | `tokens.enc` not found or decryption failed | Launch step 2 red banner |

### Token refresh (transparent, no separate channel)

Called inside `auth.getAccessToken()` before every YouTube API call:

| Condition | Effect |
|---|---|
| Access token still valid (> 60 s until expiry) | Returns token; no network call |
| Access token near expiry | Calls `oauth2.googleapis.com/token` with `refresh_token` |
| Refresh fails (any HTTP error) | Calls `tokenStore.clear()`; returns `null`; callers throw `"Not signed in to YouTube. Sign in from the login screen and try again."` |

---

## 3. YouTube API errors

Thrown by `electron/youtube.ts`. The `explainError(res)` helper maps
known YouTube error reason strings to user-readable messages.

### Mapped error reasons

| YouTube API reason | User-facing message |
|---|---|
| `authError` | `"YouTube authentication failed — your Google session may have expired. Sign out and sign back in."` |
| `insufficientPermissions` | `"Keshucord doesn't have permission to manage your YouTube channel. Sign out and sign back in to grant access."` |
| `quotaExceeded` | `"YouTube quota exceeded for today. The YouTube Data API has a daily usage limit. Wait until midnight Pacific Time or request a quota increase in Google Cloud Console."` |
| `rateLimitExceeded` | `"YouTube rate limit exceeded. Wait a moment and try again."` |
| `liveStreamingNotEnabled` | `"Live streaming is not enabled on your YouTube channel. Enable it at youtube.com/features (may take 24 hours to activate)."` |
| `liveBroadcastBindingNotAllowed` | `"YouTube couldn't bind the broadcast to the stream. This can happen if the broadcast is in an unexpected state. Try again."` |
| `errorStreamInactive` | `"YouTube reports the stream is in an error state. This usually means OBS stopped sending video. Check OBS and try again."` |
| `invalidTransition` | `"YouTube rejected the transition to live — the broadcast may not be in the expected state. Try again."` |
| `redundantTransition` | `"The broadcast is already live on YouTube."` (usually not a fatal error in the context of the launch flow) |
| `invalidValue` | `"YouTube rejected the request — one or more values were invalid. Check your stream settings and try again."` |
| `badRequest` | `"YouTube rejected the request — one or more values were invalid. Check your stream settings and try again."` |
| *(unknown reason)* | `` `YouTube API error (${status}): ${message}` `` |

### Not-signed-in error (from `call()` helper)

```
"Not signed in to YouTube. Sign in from the login screen and try again."
```

Thrown when `auth.getAccessToken()` returns `null`. This can happen
if the refresh token is invalid or the user signed out from another
device.

### Identity assertion errors (in `youtube.ts`)

These are internal guards — they indicate a YouTube API consistency
failure, not a user error:

| Context | Error |
|---|---|
| `createBroadcast` — response has no `id` | `"YouTube did not return a broadcast ID."` |
| `createLiveStream` — response has no `id` | `"YouTube did not return a stream ID."` |
| `bindBroadcastToStream` — response ID mismatch | `` `Bind response broadcast ID "${data.id}" doesn't match expected "${broadcastId}". Aborting.` `` |
| `bindBroadcastToStream` — `boundStreamId` missing | `"YouTube did not return a bound stream ID after binding."` |
| `bindBroadcastToStream` — `boundStreamId` mismatch | `` `YouTube bound the broadcast to stream "${data.contentDetails.boundStreamId}" instead of our stream "${streamId}". Aborting to avoid streaming to the wrong destination.` `` |
| `getStreamIngestionInfo` — stream not found | `` `Stream ${streamId} not found.` `` |
| `getStreamIngestionInfo` — returned ID mismatch | `` `YouTube returned ingestion info for stream "${item.id}" but we requested "${streamId}". Aborting.` `` |

### `waitForStreamActive` polling errors (renderer-side)

```ts
// src/services/youtubeService.ts
```

| Condition | Error |
|---|---|
| YouTube reports stream status `'error'` | `"YouTube reports the stream is in an error state. Check that OBS is sending video to the correct RTMP URL and stream key, then try again."` |
| 90-second timeout reached | `"Timed out waiting for YouTube to receive video from OBS (90 s). Make sure OBS is actively pushing RTMP to the stream key shown above."` |

---

## 4. OBS WebSocket errors

Thrown by `src/services/obsService.ts`. The `explainObsError(err)`
helper maps error messages and codes to user-readable strings.

### Connection errors (from `connect()`)

| Condition | OBS error indicator | User-facing message |
|---|---|---|
| OBS not running / connection refused | WebSocket error; `lowered.includes('econnrefused' \| 'failed to connect' \| ...)` | `"Could not reach OBS at ws://localhost:4455. Make sure OBS Studio is open and that Tools → WebSocket Server Settings has the server enabled on port 4455."` |
| Wrong WebSocket password | Error code `4009` | `"OBS rejected the password. Open OBS → Tools → WebSocket Server Settings → Show Connect Info to copy the correct password."` |
| Already streaming | Status check before connect | `"Stop the stream before reconnecting to OBS. End the current stream from the dashboard or from inside OBS before starting a new broadcast."` |
| *(unknown OBS error)* | *(none of the above matched)* | `` `OBS WebSocket error: ${err.message || String(err)}` `` |

### Stream configuration errors (from `configureStreamService()`)

| Condition | Error |
|---|---|
| Not in `connected` state | `"Cannot configure stream service: OBS is not connected."` |
| Empty `rtmpUrl` or `streamKey` | `"Cannot configure stream service: rtmpUrl and streamKey are required."` |
| OBS in streaming state | `"Cannot change stream service while OBS is already streaming."` |
| Post-write verification timeout — type mismatch | `` `OBS stream service type is still "${actual.streamServiceType}" after ${CONFIGURE_VERIFY_TIMEOUT_MS}ms ... If OBS has a YouTube account connected via Settings → Stream → "Connect Account", disconnect it and try again.` `` |
| Post-write verification timeout — server mismatch | `` `OBS stream server is "${actual.server}" but we wanted "${expected.server}". Same OBS YouTube account fix applies.` `` |
| Post-write verification timeout — key mismatch | `"OBS stream key didn't change to the new value. Same OBS YouTube account fix applies."` |

### Pre-StartStream assertion errors (from `assertActiveStreamServiceSettings()`)

| Condition | Error |
|---|---|
| Service type is not `rtmp_custom` | `` `OBS stream service type is "${type}" — expected "rtmp_custom". This means the stream key may have been changed since we configured it. If OBS has a YouTube account connected via Settings → Stream → "Connect Account", disconnect it first.` `` |
| Server mismatch | `` `OBS stream server is "${server}" — expected "${expected.rtmpUrl}". Aborting to avoid streaming to the wrong destination.` `` |
| Key mismatch | `` `OBS stream key doesn't match the YouTube stream key we configured. Aborting to avoid streaming to the wrong destination.` `` |

### StartStream verification errors (from `startStreaming()`)

| Condition | Error |
|---|---|
| `outputActive` never flips `true` within 5 s | `"OBS accepted the StartStream command but is not actually streaming after 5 seconds. OBS may be showing a popup — check for a 'You must select a broadcast first.' dialog. If you see it, click Cancel, go to OBS Settings → Stream → disconnect your YouTube account, then try again."` |

---

## 5. Launch orchestration errors

Produced by `src/services/launchService.ts`.

### Validation errors (step 1)

| Rule | Error |
|---|---|
| Title is empty | `"Stream title is required."` |
| Title > 100 chars | `` `Stream title is ${n} characters — YouTube allows at most 100.` `` |
| Description > 5000 chars | `` `Description is ${n} characters — YouTube allows at most 5000.` `` |
| OBS password is empty | `"OBS WebSocket password is required. Add it in Settings → Connections."` |
| Privacy is not a valid value | `` `Invalid privacy value "${privacy}". Expected one of: public, unlisted, private.` `` |

### Ingestion identity mismatch (step 6, orchestrator-level)

```
"Ingestion info stream ID does not match the stream we created.
Expected: <streamId>, got: <ingestion.streamId>.
This is an unexpected API consistency failure — please try again."
```

This check is belt-and-suspenders on top of `electron/youtube.ts`'s own
assertion — it fires if the IPC return value diverges from what was sent.

### Abort (user navigation / cancel)

`DOMException` with `name === 'AbortError'`. Silently ignored by
`LaunchStatusScreen`. The cleanup block still runs to delete any
orphaned YouTube resources.

---

## 6. Settings errors

Produced by `electron/settingsStore.ts`, surfaced in the renderer via
`SettingsScreen`'s `SyncStatusChip`.

| Condition | Error |
|---|---|
| `safeStorage.isEncryptionAvailable()` is `false` on save | `"OS-level encryption is unavailable; refusing to write settings in plaintext."` |
| Any other save failure | `` `Failed to save settings: ${err.message}` `` |
| Load failure (file missing) | Returns `DEFAULT_PERSISTED_SETTINGS` silently (not an error) |
| Load failure (decryption or JSON parse failed) | Returns `DEFAULT_PERSISTED_SETTINGS` silently (not an error) |
| Reset failure | Propagates the `fs.unlink` error |

The `SyncStatusChip` in `SettingsScreen` shows:
- `"Saved · just now"` after a successful save.
- `"Save failed"` in red with the message in the `title` attribute after
  a failed save.

---

## 7. CreateScreen pre-flight gates

These are not errors — they are inline block reasons that disable the
Go Live button before the user tries to submit:

| Condition | Message shown |
|---|---|
| Title is empty | `"Add a title to continue."` |
| OBS password not set | `"Set the OBS WebSocket password in Settings → Connections first."` |
| OBS is already streaming | `"OBS is already streaming — stop it before launching a managed broadcast."` |
| Schedule mode selected | `"Scheduling lands in a follow-up — switch to 'Start now' to launch."` |

---

## 8. Guidance for writing new error messages

1. **Be specific.** Name the thing that failed and the exact condition.
   "OBS rejected the password" is better than "Connection failed."
2. **Give the fix.** Always end with what the user should do. "Open OBS →
   Tools → WebSocket Server Settings → Show Connect Info to copy the
   correct password."
3. **Don't surface implementation details.** Don't show HTTP status codes
   or raw exception stack traces to the user. Map them in
   `explainError`/`explainObsError`.
4. **Log the full error.** Even if the user-facing message is simplified,
   `console.warn` or `console.error` the original error for debugging.
5. **Inline, not toast.** All errors render adjacent to the action that
   caused them. No global toast system exists.
