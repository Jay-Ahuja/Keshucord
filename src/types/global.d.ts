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
  /**
   * OBS process control — pre-flight gate uses these to launch OBS if it
   * isn't already running. Frozen contract owned by the main-process side
   * (see electron/obs.ts in Agent A's branch).
   */
  obs: {
    /**
     * Cheap check used by the renderer-side preflight before deciding to
     * show the launch-OBS dialog. Implementation MAY be a port probe; it
     * MUST NOT mutate any OBS WebSocket state.
     */
    isRunning(): Promise<boolean>;
    /**
     * Spawn OBS via the main process. Returns `{ok: true}` if the launch
     * command was issued successfully; returns `{ok: false, reason}` with
     * a user-displayable string on failure (binary missing, permission
     * denied, etc). Does NOT wait for OBS to finish starting — callers
     * must poll `isRunning()` themselves.
     */
    launch(): Promise<{ ok: true } | { ok: false; reason: string }>;
  };
}

declare global {
  interface Window {
    keshucord: KeshucordAPI;
  }
}

export {};
