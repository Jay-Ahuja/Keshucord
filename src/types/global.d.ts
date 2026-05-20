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
    cancelSignIn(): Promise<void>;
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
    transitionToComplete(broadcastId: string): Promise<void>;
    deleteBroadcast(broadcastId: string): Promise<void>;
    deleteLiveStream(streamId: string): Promise<void>;
    /**
     * Upload a JPEG/PNG thumbnail for an existing broadcast. The image
     * bytes are passed as a `Uint8Array`; Electron's structured-clone
     * algorithm preserves typed arrays across IPC. Single-attempt on the
     * main side — the renderer should not assume retry on transient
     * errors. Used by the launch flow's best-effort sub-step after step 3.
     */
    uploadThumbnail(
      videoId: string,
      imageData: Uint8Array,
      mimeType: 'image/jpeg' | 'image/png',
    ): Promise<void>;
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
   * isn't already running. Main-process implementation lives in
   * `electron/obsProcess.ts`.
   */
  obs: {
    /**
     * Whether an OBS process is currently running on this OS. Implemented
     * as a process-table check (tasklist / pgrep) in the main process —
     * NOT a port probe. MUST NOT mutate any OBS WebSocket state.
     *
     * Note: a `true` result only means the OBS *process* exists. The OBS
     * WebSocket server may not yet be accepting connections (e.g. during
     * startup, or if the user disabled it in OBS settings). For
     * "is OBS actually reachable?" callers should use
     * `obsService.probe()` (raw WebSocket open) in the renderer.
     */
    isRunning(): Promise<boolean>;
    /**
     * Spawn OBS via the main process. Returns `{ok: true}` if the launch
     * command was issued successfully; returns `{ok: false, reason}` with
     * a user-displayable string on failure (binary missing, permission
     * denied, etc). Does NOT wait for OBS to finish starting — for
     * readiness, callers should poll OBS WebSocket reachability via
     * `obsService.probe()` rather than `isRunning()`, since the process
     * exists before the WebSocket server binds its port.
     * `obsService.launchAndWait()` wraps this with the polling loop.
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
