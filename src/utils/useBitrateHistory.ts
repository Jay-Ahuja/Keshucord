import { useEffect, useState } from 'react';
import { obsService } from '../services';

/**
 * Subscribe to OBS's rolling bitrate history. Returns an array of kbps samples
 * with the newest at the end. Empty when not streaming.
 *
 * The buffer is populated by the same poll loop that drives `useStreamHealth`,
 * so this hook has zero polling cost on top of what's already running.
 */
export function useBitrateHistory(): readonly number[] {
  const [history, setHistory] = useState<readonly number[]>(() =>
    obsService.getBitrateHistory(),
  );
  useEffect(() => obsService.subscribeBitrateHistory(setHistory), []);
  return history;
}
