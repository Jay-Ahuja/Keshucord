import type { UserSettings } from '../types';

export async function load(): Promise<UserSettings> {
  return window.keshucord.settings.load();
}

export async function save(settings: UserSettings): Promise<void> {
  await window.keshucord.settings.save(settings);
}

export async function reset(): Promise<UserSettings> {
  return window.keshucord.settings.reset();
}
