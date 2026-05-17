import type { UserSettings } from './settings';
import type {
  CreateBroadcastInput,
  CreateLiveStreamInput,
  StreamIngestionInfo,
  YouTubeBroadcast,
  YouTubeLiveStream,
  YouTubeUser,
} from './youtube';

export interface KeshucordAPI {
  auth: {
    signIn(): Promise<YouTubeUser>;
    signOut(): Promise<void>;
    getCurrentUser(): Promise<YouTubeUser | null>;
  };
  youtube: {
    createBroadcast(input: CreateBroadcastInput): Promise<YouTubeBroadcast>;
    createLiveStream(input: CreateLiveStreamInput): Promise<YouTubeLiveStream>;
    bindBroadcastToStream(
      broadcastId: string,
      streamId: string,
    ): Promise<{ broadcastId: string; streamId: string }>;
    getStreamIngestionInfo(streamId: string): Promise<StreamIngestionInfo>;
    getStreamStatus(streamId: string): Promise<string>;
    transitionToLive(broadcastId: string): Promise<YouTubeBroadcast>;
    deleteBroadcast(broadcastId: string): Promise<void>;
    deleteLiveStream(streamId: string): Promise<void>;
    /** Aborts every in-flight YouTube request currently running in main. */
    cancel(): Promise<void>;
  };
  settings: {
    load(): Promise<UserSettings>;
    save(settings: UserSettings): Promise<void>;
    reset(): Promise<UserSettings>;
  };
}

declare global {
  interface Window {
    keshucord: KeshucordAPI;
  }
}

export {};
