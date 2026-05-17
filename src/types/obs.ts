export type OBSConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'streaming'
  | 'error';

export interface OBSConnectionStatus {
  state: OBSConnectionState;
  version?: string;
  currentScene?: string;
  error?: string;
}

/**
 * Snapshot of live streaming metrics pulled from OBS.
 *
 * `bitrateKbps` is `null` on the very first sample because we need two
 * `outputBytes` readings to compute a rate — subsequent samples are numbers.
 */
export interface StreamHealth {
  bitrateKbps: number | null;
  fps: number;
  droppedFrames: number;
  droppedFramePercent: number;
  /** OBS network-congestion proxy, 0 (healthy) → 1 (critical). */
  congestion: number;
  renderTimeMs: number;
  outputDurationMs: number;
  totalFrames: number;
  timestamp: number;
}
