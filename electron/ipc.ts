import { ipcMain } from 'electron';
import * as auth from './auth';
import * as obsProcess from './obsProcess';
import * as settingsStore from './settingsStore';
import * as youtube from './youtube';

export function registerIpcHandlers(): void {
  // Auth
  ipcMain.handle('auth:sign-in', () => auth.signIn());
  ipcMain.handle('auth:sign-out', () => auth.signOut());
  ipcMain.handle('auth:get-current-user', () => auth.getCurrentUser());
  ipcMain.handle('auth:cancel-sign-in', () => auth.cancelSignIn());

  // Settings
  ipcMain.handle('settings:load', () => settingsStore.load());
  ipcMain.handle('settings:save', (_e, s: settingsStore.PersistedSettings) =>
    settingsStore.save(s),
  );
  ipcMain.handle('settings:reset', () => settingsStore.reset());

  // YouTube Live
  ipcMain.handle('youtube:create-broadcast', (_e, input: youtube.CreateBroadcastInput) =>
    youtube.createBroadcast(input),
  );
  ipcMain.handle('youtube:create-stream', (_e, input: youtube.CreateLiveStreamInput) =>
    youtube.createLiveStream(input),
  );
  ipcMain.handle('youtube:bind', (_e, broadcastId: string, streamId: string) =>
    youtube.bindBroadcastToStream(broadcastId, streamId),
  );
  ipcMain.handle('youtube:get-ingestion', (_e, streamId: string) =>
    youtube.getStreamIngestionInfo(streamId),
  );
  ipcMain.handle('youtube:get-stream-status', (_e, streamId: string) =>
    youtube.getStreamStatus(streamId),
  );
  ipcMain.handle('youtube:transition-live', (_e, broadcastId: string) =>
    youtube.transitionToLive(broadcastId),
  );
  ipcMain.handle('youtube:transition-complete', (_e, broadcastId: string) =>
    youtube.transitionToComplete(broadcastId),
  );
  ipcMain.handle('youtube:delete-broadcast', (_e, broadcastId: string) =>
    youtube.deleteBroadcast(broadcastId),
  );
  ipcMain.handle('youtube:delete-stream', (_e, streamId: string) =>
    youtube.deleteLiveStream(streamId),
  );
  // Thumbnail upload: image bytes cross IPC as a Uint8Array (Electron's
  // structured-clone algorithm preserves them). We coerce to Buffer in
  // the handler so the main-process fetch can hand it straight to
  // `body: Buffer`. mimeType narrowing is done in the renderer-side
  // facade; main re-validates because IPC is a trust boundary.
  ipcMain.handle(
    'youtube:upload-thumbnail',
    (_e, videoId: string, imageData: Uint8Array, mimeType: string) => {
      if (mimeType !== 'image/jpeg' && mimeType !== 'image/png') {
        throw new Error(`Unsupported thumbnail mime type "${mimeType}". Use JPEG or PNG.`);
      }
      return youtube.uploadThumbnail(videoId, Buffer.from(imageData), mimeType);
    },
  );
  // Renderer-driven abort: AbortSignal can't cross IPC, so when the launch
  // orchestrator aborts we instead fire this channel to interrupt any
  // in-flight YouTube fetches on the main side.
  ipcMain.handle('youtube:cancel', () => {
    youtube.cancelAllInFlight();
  });

  // OBS process (pre-flight): detect a running OBS Studio and, if needed,
  // launch it from disk. Distinct from the OBS WebSocket calls in the
  // renderer's obsService — this layer only deals with the OS process.
  ipcMain.handle('obs:is-running', () => obsProcess.isObsRunning());
  ipcMain.handle('obs:launch', () => obsProcess.launchObs());
}
