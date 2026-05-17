import crypto from 'node:crypto';
import fs from 'node:fs/promises';

/**
 * Write `data` to `path` atomically: writes to a sibling tmp file first, then
 * renames it over the destination. On both POSIX and Windows, `fs.rename`
 * replaces the destination in a single filesystem operation, so a reader can
 * never observe a half-written file. Prevents `tokens.enc` / `settings.enc`
 * corruption from crashes or power loss mid-write.
 *
 * On failure the tmp file is removed best-effort.
 */
export async function atomicWrite(
  destPath: string,
  data: Buffer | Uint8Array,
  mode: number,
): Promise<void> {
  const tmp = `${destPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await fs.writeFile(tmp, data, { mode });
    await fs.rename(tmp, destPath);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      // tmp may not exist if writeFile failed before creating it; ignore.
    }
    throw err;
  }
}
