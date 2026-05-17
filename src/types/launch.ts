export type LaunchStepId =
  | 'validate'
  | 'auth'
  | 'broadcast'
  | 'stream'
  | 'bind'
  | 'ingestion'
  | 'connect-obs'
  | 'configure-obs'
  | 'start-stream'
  | 'go-live';

export type LaunchStepStatus = 'pending' | 'active' | 'done' | 'error';

export interface LaunchStep {
  id: LaunchStepId;
  label: string;
  detail: string;
}
