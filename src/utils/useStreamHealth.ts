import { useEffect, useState } from 'react';
import { obsService } from '../services';
import type { StreamHealth } from '../types';

/**
 * Subscribe to live OBS stream health snapshots.
 *
 * Returns `null` whenever OBS isn't streaming (or has disconnected).
 * The underlying polling loop in `obsService` only runs while OBS is in the
 * `streaming` state, so this hook never causes work when there's nothing to
 * report.
 */
export function useStreamHealth(): StreamHealth | null {
  const [health, setHealth] = useState<StreamHealth | null>(() => obsService.getStreamHealth());
  useEffect(() => obsService.subscribeHealth(setHealth), []);
  return health;
}
