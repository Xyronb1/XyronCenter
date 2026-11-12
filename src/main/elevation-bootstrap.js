/**
 * XYRON CENTER - Self-elevation bootstrap
 * File: src/main/elevation-bootstrap.js
 *
 * On launch the app makes sure it is running as Administrator. If it is not,
 * it relaunches itself through the standard Windows consent flow (ShellExecute
 * "runas" -> the normal UAC prompt) and the unelevated copy exits. Nothing here
 * bypasses UAC:
 *   - UAC enabled  -> the usual consent dialog appears once per launch.
 *   - UAC disabled / already elevated -> nothing is asked.
 *   - User declines -> the app still opens, in standard (limited) mode.
 *
 * A marker argument on the relaunched copy guarantees we can never loop, even
 * if elevation detection were wrong.
 *
 * Pure helpers are exported separately so they can be unit-tested without
 * Electron and without ever triggering a real UAC prompt.
 */

'use strict';

const { execFileSync, spawn } = require('child_process');

/** Marker passed to the relaunched (elevated) copy to prevent relaunch loops. */
const ELEVATED_MARKER = '--xyron-elevated';

/** Mandatory-integrity SIDs: High (elevated admin) and System. */
const ELEVATED_INTEGRITY_SIDS = ['S-1-16-12288', 'S-1-16-16384'];

/**
 * Detect whether the current process token is elevated, by looking for a High
 * (or System) mandatory integrity level in `whoami /groups`. SID-based, so it
 * is independent of the Windows display language and of service state.
 *
 * @param {Object} [deps]
 * @param {Function} [deps.exec] - execFileSync-compatible function (injectable for tests)
 * @returns {boolean}
 */
function isElevated(deps = {}) {
  const exec = deps.exec || execFileSync;
  try {
    const out = exec(require('path').join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), ['/groups', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const text = String(out || '');
    return ELEVATED_INTEGRITY_SIDS.some((sid) => text.includes(sid));
  } catch (_e) {
    return false;
  }
}

/**
 * Decide whether this launch should try to self-elevate.
 *
 * @param {Object} ctx
 * @param {string} ctx.platform
 * @param {Object} ctx.env
 * @param {string[]} ctx.argv
 * @param {boolean} ctx.elevated
 * @returns {boolean}
 */
function shouldSelfElevate(ctx) {
  const { platform, env = {}, argv = [], elevated } = ctx;
  if (platform !== 'win32') return false;
  if (elevated) return false;
  if (argv.includes(ELEVATED_MARKER)) return false;           // already relaunched once
  if (env.XYRON_NO_ELEVATE) return false;                      // explicit opt-out (dev / CI)
  if (env.XYRON_SMOKE || env.XYRON_WINDOWED) return false;    // test harness modes
  return true;
}

/**
 * Build the PowerShell invocation that relaunches the app with the "runas" verb.
 *
 * @param {Object} opts
 * @param {string} opts.exePath - executable to relaunch
 * @param {string[]} [opts.args] - arguments to pass through
 * @param {string} [opts.cwd] - working directory for the relaunched copy
 * @returns {{ file: string, args: string[], script: string }}
 */
function buildRelaunch(opts) {
  const { exePath, args = [], cwd } = opts;
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;     // PowerShell single-quote escape

  const passArgs = args.filter((a) => a !== ELEVATED_MARKER).concat(ELEVATED_MARKER);
  const argList = `@(${passArgs.map(q).join(',')})`;
  const wd = cwd ? ` -WorkingDirectory ${q(cwd)}` : '';

  const script =
    "$ErrorActionPreference='Stop'; " +
    'try { ' +
    `Start-Process -FilePath ${q(exePath)} -ArgumentList ${argList}${wd} -Verb RunAs; exit 0 ` +
    '} catch { exit 1 }';

  return {
    file: 'powershell.exe',
    args: [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
    ],
    script
  };
}

/**
 * Relaunch elevated. Resolves true when the elevated copy was started (the
 * caller should quit), false when the user declined or it failed (the caller
 * should keep running in standard mode).
 *
 * @param {Object} opts - see buildRelaunch
 * @param {Object} [deps]
 * @param {Function} [deps.spawnFn] - child_process.spawn (injectable for tests)
 * @returns {Promise<boolean>}
 */
function relaunchElevated(opts, deps = {}) {
  const spawnFn = deps.spawnFn || spawn;
  const { file, args } = buildRelaunch(opts);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const child = spawnFn(file, args, { windowsHide: true, stdio: 'ignore' });
      child.on('error', () => done(false));
      child.on('exit', (code) => done(code === 0));
      // Safety net: never hang startup forever on a stuck prompt (5 min).
      setTimeout(() => done(false), 5 * 60 * 1000).unref?.();
    } catch (_e) {
      done(false);
    }
  });
}

/**
 * Resolve the executable that should be relaunched. For an electron-builder
 * portable build the real launcher path is in PORTABLE_EXECUTABLE_FILE (the
 * running exe lives in a temp extraction folder that disappears on exit).
 *
 * @param {Object} env
 * @param {string} execPath
 * @returns {string}
 */
function resolveRelaunchExe(env, execPath) {
  return (env && env.PORTABLE_EXECUTABLE_FILE) || execPath;
}

module.exports = {
  ELEVATED_MARKER,
  isElevated,
  shouldSelfElevate,
  buildRelaunch,
  relaunchElevated,
  resolveRelaunchExe
};
