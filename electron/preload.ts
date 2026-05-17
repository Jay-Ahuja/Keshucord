import { contextBridge, ipcRenderer } from 'electron';

export interface AuthUserPayload {
  id: string;
  name: string;
  email: string;
  channel: string;
  avatarUrl?: string;
  channelId?: string;
  channelThumbnailUrl?: string;
}

export interface CreateBroadcastPayload {
  title: string;
  description?: string;
  privacyStatus: 'public' | 'unlisted' | 'private';
  category?: string;
}

export interface CreateLiveStreamPayload {
  title: string;
}

export interface YouTubeBroadcastPayload {
  id: string;
  title: string;
  description: string;
  privacy: 'public' | 'unlisted' | 'private';
  category: string;
  status: string;
  watchUrl: string;
  scheduledStartTime: string;
  boundStreamId?: string;
}

export interface YouTubeLiveStreamPayload {
  id: string;
  title: string;
}

export interface StreamIngestionInfoPayload {
  streamId: string;
  streamKey: string;
  rtmpUrl: string;
  backupRtmpUrl?: string;
}

export interface PersistedSettingsPayload {
  obsPassword: string;
  defaultTitle: string;
  defaultDescription: string;
  defaultPrivacy: 'public' | 'unlisted' | 'private';
  defaultCategory: string;
  appearanceAccent: 'purple' | 'cobalt' | 'ember' | 'mono';
  appearanceDensity: 'comfortable' | 'compact';
  appearanceReduceMotion: boolean;
  sidebarCompact: boolean;
}

const api = {
  auth: {
    signIn: (): Promise<AuthUserPayload> => ipcRenderer.invoke('auth:sign-in'),
    signOut: (): Promise<void> => ipcRenderer.invoke('auth:sign-out'),
    getCurrentUser: (): Promise<AuthUserPayload | null> =>
      ipcRenderer.invoke('auth:get-current-user'),
  },
  youtube: {
    createBroadcast: (input: CreateBroadcastPayload): Promise<YouTubeBroadcastPayload> =>
      ipcRenderer.invoke('youtube:create-broadcast', input),
    createLiveStream: (input: CreateLiveStreamPayload): Promise<YouTubeLiveStreamPayload> =>
      ipcRenderer.invoke('youtube:create-stream', input),
    bindBroadcastToStream: (
      broadcastId: string,
      streamId: string,
    ): Promise<{ broadcastId: string; streamId: string }> =>
      ipcRenderer.invoke('youtube:bind', broadcastId, streamId),
    getStreamIngestionInfo: (streamId: string): Promise<StreamIngestionInfoPayload> =>
      ipcRenderer.invoke('youtube:get-ingestion', streamId),
    getStreamStatus: (streamId: string): Promise<string> =>
      ipcRenderer.invoke('youtube:get-stream-status', streamId),
    transitionToLive: (broadcastId: string): Promise<YouTubeBroadcastPayload> =>
      ipcRenderer.invoke('youtube:transition-live', broadcastId),
    deleteBroadcast: (broadcastId: string): Promise<void> =>
      ipcRenderer.invoke('youtube:delete-broadcast', broadcastId),
    deleteLiveStream: (streamId: string): Promise<void> =>
      ipcRenderer.invoke('youtube:delete-stream', streamId),
    /** Aborts every in-flight YouTube request currently running in main. */
    cancel: (): Promise<void> => ipcRenderer.invoke('youtube:cancel'),
  },
  settings: {
    load: (): Promise<PersistedSettingsPayload> => ipcRenderer.invoke('settings:load'),
    save: (s: PersistedSettingsPayload): Promise<void> => ipcRenderer.invoke('settings:save', s),
    reset: (): Promise<PersistedSettingsPayload> => ipcRenderer.invoke('settings:reset'),
  },
};

contextBridge.exposeInMainWorld('keshucord', api);

export type KeshucordAPI = typeof api;
