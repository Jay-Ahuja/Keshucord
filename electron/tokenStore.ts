import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './atomicWrite';

export interface StoredUser {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  channelId?: string;
  channelTitle?: string;
  channelThumbnailUrl?: string;
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  scope: string;
  tokenType: string;
  user: StoredUser;
}

function tokenFile(): string {
  return path.join(app.getPath('userData'), 'tokens.enc');
}

export async function save(tokens: StoredTokens): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS-level encryption is unavailable on this machine; refusing to write tokens in plaintext.',
    );
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(tokens));
  // Atomic write via tmp+rename — a crash mid-write can no longer corrupt
  // tokens.enc and force the user to re-sign-in on next boot.
  await atomicWrite(tokenFile(), encrypted, 0o600);
}

export async function load(): Promise<StoredTokens | null> {
  try {
    const encrypted = await fs.readFile(tokenFile());
    const json = safeStorage.decryptString(encrypted);
    return JSON.parse(json) as StoredTokens;
  } catch {
    return null;
  }
}

export async function clear(): Promise<void> {
  try {
    await fs.unlink(tokenFile());
  } catch {
    // already gone
  }
}
