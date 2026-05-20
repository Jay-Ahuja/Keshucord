export type Privacy = 'public' | 'unlisted' | 'private';

export interface StreamSettings {
  title: string;
  description: string;
  privacy: Privacy;
  category: string;
  obsPassword: string;
  /**
   * In-memory thumbnail picked by the user on CreateScreen. Ephemeral:
   * lives only in renderer memory, never crosses IPC as part of settings
   * persistence (UserSettings handles persisted prefs in
   * `src/types/settings.ts`; StreamSettings is the per-launch payload).
   * The launch flow uploads it to YouTube after broadcast creation; the
   * upload is best-effort and a failure does not abort the launch.
   */
  thumbnailFile?: File;
}
