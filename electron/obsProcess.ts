import { exec, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * OS-process side of the OBS pre-flight: detect whether OBS Studio is
 * currently running, and launch it if it isn't.
 *
 * This module is intentionally NOT about the OBS WebSocket — see
 * `src/services/obsService.ts` for the renderer-side WebSocket client.
 * Here we only care about the OS process (is it alive? can we start it?).
 *
 * All OS-specific branching is contained in this file so the rest of the
 * electron main process stays portable.
 */

const LOG_PREFIX = '[obs-process]';
const DETECTION_TIMEOUT_MS = 2_000;

const WINDOWS_FALLBACK_EXE = 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe';

/**
 * Result of a launch attempt. On success the caller knows OBS was handed
 * off to the OS; the renderer is responsible for then polling the OBS
 * WebSocket until it becomes reachable.
 */
export type LaunchResult = { ok: true } | { ok: false; reason: string };

/**
 * Returns true iff an OBS Studio process is currently running.
 *
 * Detection method per OS:
 *   - Windows: `tasklist` filtered to `obs64.exe`.
 *   - macOS:   `pgrep -x OBS` (the .app's executable is named `OBS`).
 *   - Linux:   `pgrep -x obs`.
 *
 * Every call is bounded by a 2-second timeout so that an unresponsive
 * shell tool (rare but possible) cannot wedge the IPC handler.
 */
export async function isObsRunning(): Promise<boolean> {
  const platform = process.platform;
  if (platform === 'win32') {
    return detectWindows();
  }
  if (platform === 'darwin') {
    return detectMac();
  }
  return detectLinux();
}

/**
 * Spawn OBS Studio detached from the Electron main process. The child is
 * `unref()`-ed so quitting Keshucord does not also kill OBS.
 *
 * CRITICAL on Windows: OBS will silently crash on start if its working
 * directory is not `<install>/bin/64bit/`. We therefore always set `cwd`
 * to the directory of the resolved exe.
 *
 * On macOS we delegate to `open -a OBS` which handles the .app bundle
 * activation correctly. On Linux we assume `obs` is on PATH.
 */
export async function launchObs(): Promise<LaunchResult> {
  const platform = process.platform;
  console.log(`${LOG_PREFIX} launchObs invoked on platform=${platform}`);

  try {
    if (platform === 'win32') {
      return await launchWindows();
    }
    if (platform === 'darwin') {
      return launchMac();
    }
    return await launchLinux();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} unexpected launch error:`, message);
    return { ok: false, reason: `Failed to launch OBS: ${message}` };
  }
}

// ─── Detection ────────────────────────────────────────────────────────────

function detectWindows(): Promise<boolean> {
  // /FI filter on image name, /NH suppresses the header row. If OBS is not
  // running, tasklist prints "INFO: No tasks are running…" to stdout (not
  // stderr) and still exits 0, so we have to inspect stdout content.
  const cmd = 'tasklist /FI "IMAGENAME eq obs64.exe" /NH';
  console.log(`${LOG_PREFIX} detection method: tasklist (win32)`);
  return runDetection(cmd, (stdout) => /obs64\.exe/i.test(stdout));
}

function detectMac(): Promise<boolean> {
  // pgrep exits 0 if matches found, 1 if none. Either is a successful run
  // from our perspective — we use the exit code as the signal.
  const cmd = 'pgrep -x OBS';
  console.log(`${LOG_PREFIX} detection method: pgrep -x OBS (darwin)`);
  return runDetectionByExitCode(cmd);
}

function detectLinux(): Promise<boolean> {
  const cmd = 'pgrep -x obs';
  console.log(`${LOG_PREFIX} detection method: pgrep -x obs (linux)`);
  return runDetectionByExitCode(cmd);
}

/**
 * Run `cmd` with a hard timeout; on success pass stdout to `match` to
 * decide whether the target process is considered running. Errors and
 * timeouts are treated as "not running" — the failure mode for the
 * caller is a follow-up `launchObs`, which is safe.
 */
function runDetection(cmd: string, match: (stdout: string) => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    exec(cmd, { timeout: DETECTION_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) {
        // exec sets err.killed when the timeout fired.
        const reason = (err as NodeJS.ErrnoException).code ?? err.message;
        console.warn(`${LOG_PREFIX} detection command failed (${reason}); treating as not-running`);
        resolve(false);
        return;
      }
      resolve(match(stdout));
    });
  });
}

function runDetectionByExitCode(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    exec(cmd, { timeout: DETECTION_TIMEOUT_MS }, (err) => {
      if (!err) {
        resolve(true);
        return;
      }
      // pgrep exits 1 when no process matches — that's the "not running"
      // signal, not an error. Anything else (timeout, command missing) is
      // still safe to treat as not-running.
      const code = (err as { code?: number | string }).code;
      if (code === 1 || code === '1') {
        resolve(false);
        return;
      }
      console.warn(
        `${LOG_PREFIX} detection command failed (code=${String(code)}); treating as not-running`,
      );
      resolve(false);
    });
  });
}

// ─── Launch ───────────────────────────────────────────────────────────────

async function launchWindows(): Promise<LaunchResult> {
  const exePath = await resolveWindowsObsPath();
  if (!exePath) {
    console.warn(`${LOG_PREFIX} could not resolve OBS install path on Windows`);
    return {
      ok: false,
      reason: 'OBS Studio is not installed at the expected location',
    };
  }

  // OBS requires cwd === bin/64bit/ or it crashes silently on start.
  const cwd = path.dirname(exePath);
  console.log(`${LOG_PREFIX} resolved exe=${exePath} cwd=${cwd}`);

  return spawnDetached(exePath, cwd);
}

function launchMac(): LaunchResult {
  // `open -a OBS` is the canonical "activate this .app bundle" command.
  // It handles cwd/Info.plist/etc for us. The `open` process itself
  // exits immediately after handing off — we still detach to be safe.
  console.log(`${LOG_PREFIX} launching via: open -a OBS`);
  try {
    const child = spawn('open', ['-a', 'OBS'], { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      console.error(`${LOG_PREFIX} 'open -a OBS' emitted error:`, err.message);
    });
    child.unref();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} 'open -a OBS' threw:`, message);
    return { ok: false, reason: `Failed to launch OBS: ${message}` };
  }
}

function launchLinux(): Promise<LaunchResult> {
  // Assume `obs` is on PATH — the standard for distro packages and Flatpak
  // wrapper scripts. No cwd requirement on Linux.
  //
  // spawn() returns synchronously, but the 'error' event (ENOENT for a
  // missing binary, EACCES, etc.) fires asynchronously on the next tick.
  // We therefore wait a brief moment after spawn before resolving { ok: true }
  // so a missing-binary error has time to propagate up as { ok: false } with
  // an actionable message — instead of the previous behavior of returning
  // success synchronously while the error fired into the void.
  console.log(`${LOG_PREFIX} launching via PATH: obs`);
  return new Promise<LaunchResult>((resolve) => {
    let settled = false;
    const settle = (result: LaunchResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn('obs', [], { detached: true, stdio: 'ignore' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_PREFIX} spawning 'obs' threw:`, message);
      settle({ ok: false, reason: `Failed to launch OBS: ${message}` });
      return;
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      console.error(`${LOG_PREFIX} spawning 'obs' emitted error:`, err.message);
      if (err.code === 'ENOENT') {
        settle({
          ok: false,
          reason:
            'OBS Studio is not on your PATH — install via your distro package manager or set up a PATH entry.',
        });
        return;
      }
      settle({ ok: false, reason: `Failed to launch OBS: ${err.message}` });
    });

    child.unref();

    // Give the 'error' event a chance to fire before we declare success.
    // 200ms is plenty for libuv to drain a spawn-time failure.
    setTimeout(() => settle({ ok: true }), 200);
  });
}

/**
 * Resolve the full path to obs64.exe on Windows.
 *
 * Strategy:
 *   1. Query `HKLM\SOFTWARE\OBS Studio` for the install root.
 *   2. Append `bin\64bit\obs64.exe`.
 *   3. Verify the file exists.
 *   4. Fall back to the canonical install path under Program Files.
 *
 * Returns null if neither the registry-resolved nor the fallback path
 * points to an existing file.
 */
async function resolveWindowsObsPath(): Promise<string | null> {
  const fromRegistry = await readObsInstallPathFromRegistry();
  if (fromRegistry) {
    const exe = path.join(fromRegistry, 'bin', '64bit', 'obs64.exe');
    if (await fileExists(exe)) {
      console.log(`${LOG_PREFIX} install path from registry: ${exe}`);
      return exe;
    }
    console.warn(
      `${LOG_PREFIX} registry-resolved exe missing on disk (${exe}); trying fallback`,
    );
  }

  if (await fileExists(WINDOWS_FALLBACK_EXE)) {
    console.log(`${LOG_PREFIX} install path from fallback: ${WINDOWS_FALLBACK_EXE}`);
    return WINDOWS_FALLBACK_EXE;
  }

  return null;
}

/**
 * Shell out to `reg query` to fetch the OBS install directory. We avoid
 * pulling in a native registry binding for one read — `reg.exe` ships
 * with every Windows install and parses fine.
 *
 * The 64-bit installer writes its root path to the default value of
 * `HKLM\SOFTWARE\OBS Studio`. On systems where the 32-bit view is in
 * use we also try the Wow6432Node mirror.
 */
async function readObsInstallPathFromRegistry(): Promise<string | null> {
  const keys = ['HKLM\\SOFTWARE\\OBS Studio', 'HKLM\\SOFTWARE\\WOW6432Node\\OBS Studio'];
  for (const key of keys) {
    const installRoot = await regQueryDefault(key);
    if (installRoot) return installRoot;
  }
  return null;
}

function regQueryDefault(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    exec(
      `reg query "${key}" /ve`,
      { timeout: DETECTION_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        // Expected line format (whitespace-separated):
        //   (Default)    REG_SZ    C:\Program Files\obs-studio
        const match = stdout.match(/REG_SZ\s+(.+?)\s*$/m);
        if (!match) {
          resolve(null);
          return;
        }
        resolve(match[1].trim());
      },
    );
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function spawnDetached(exe: string, cwd: string): LaunchResult {
  try {
    const child = spawn(exe, [], { cwd, detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      console.error(`${LOG_PREFIX} spawn error from '${exe}':`, err.message);
    });
    child.unref();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} spawn threw for '${exe}':`, message);
    return { ok: false, reason: `Failed to launch OBS: ${message}` };
  }
}
