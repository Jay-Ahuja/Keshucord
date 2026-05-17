// Screen identifiers used by App routing. `create` is the new name for what
// was previously `setup` — it matches the Keshucord design's nav slug. The
// extra `home`/`dash`/`history`/`help` entries are added here in Phase A so
// later phases (sidebar nav + per-screen migrations) compile incrementally.
export type Screen =
  | 'login'
  | 'home'
  | 'create'
  | 'launch'
  | 'dash'
  | 'history'
  | 'settings'
  | 'help';
