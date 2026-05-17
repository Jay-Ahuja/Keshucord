import { useEffect, useState } from 'react';
import { obsService } from '../services';
import type { OBSConnectionStatus } from '../types';

export function useObsStatus(): OBSConnectionStatus {
  const [status, setStatus] = useState<OBSConnectionStatus>(() => obsService.getStatus());
  useEffect(() => obsService.subscribe(setStatus), []);
  return status;
}
