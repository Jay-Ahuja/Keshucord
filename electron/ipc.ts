import { ipcMain } from 'electron';
import * as auth from './auth';
import * as settingsStore from './settingsStore';
import * as youtube from './youtube';

export function registerIpcHandlers(): void {
  // Auth
  ipcMain.handle('auth:sign-in', () => auth.signIn());
  ipcMain.handle('auth:sign-out', () => auth.signOut());
  ipcMain.handle('auth:get-current-user', () => auth.getCurrentUser());

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
  ipcMain.handle('youtube:delete-broadcast', (_e, broadcastId: string) =>
    youtube.deleteBroadcast(broadcastId),
  );
  ipcMain.handle('youtube:delete-stream', (_e, streamId: string) =>
    youtube.deleteLiveStream(streamId),
  );
}
