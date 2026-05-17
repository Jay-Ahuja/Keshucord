export type Privacy = 'public' | 'unlisted' | 'private';

export interface StreamSettings {
  title: string;
  description: string;
  privacy: Privacy;
  category: string;
  obsPassword: string;
}
