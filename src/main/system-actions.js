/**
 * XYRON CENTER - Desktop integration actions
 * File: src/main/system-actions.js
 *
 * Small, validated bridges between the interface and Windows:
 *   system:open-path      open a file/folder with its default program
 *   system:reveal-path    show a file/folder selected in Explorer
 *   system:open-external  open an http(s) link in the default browser
 *   system:save-log       write the terminal scrollback to a timestamped .txt
 *   system:drives         capacity / free space of every mounted drive letter
 *
 * The pure helpers are exported so they can be tested without Electron.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MAX_LOG_CHARS = 20 * 1024 * 1024;
const DRIVE_PROBE_TIMEOUT_MS = 1500;
// A: and B: are skipped: probing an empty floppy can pop a system dialog.
const DRIVE_LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/**
 * @param {unknown} url
 * @returns {boolean} true only for well-formed http:// or https:// URLs
 */
function isSafeExternalUrl(url) {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname;
  } catch (_e) {
    return false;
  }
}

/**
 * Normalize a path coming from the interface and make sure it exists.
 * Only absolute paths are accepted, so nothing is resolved against an
 * unexpected working directory.
 *
 * @param {unknown} target
 * @param {(p: string) => boolean} [exists]
 * @returns {string|null}
 */
function resolveExistingPath(target, exists = fs.existsSync) {
  const resolved = normalizeTargetPath(target);
  if (!resolved) return null;
  try {
    return exists(resolved) ? resolved : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Validation half of resolveExistingPath (no disk access).
 * @param {unknown} target
 * @returns {string|null} absolute, resolved path or null
 */
function normalizeTargetPath(target) {
  if (typeof target !== 'string') return null;
  const trimmed = target.trim().replace(/^"(.*)"$/, '$1');
  // A real Windows path never contains a double quote or NUL.
  if (!trimmed || trimmed.length > 32767 || /["\0]/.test(trimmed)) return null;
  // Device namespace (\\.\PhysicalDrive0, \\?\GLOBALROOT ...) is never a file to open.
  if (/^[\\/]{2}[.?][\\/]/.test(trimmed)) return null;
  if (!path.isAbsolute(trimmed)) return null;
  return path.resolve(trimmed);
}

// Existence checks still waiting on the OS. Capped so that clicks on paths of
// a dead network share cannot pile up and occupy libuv's whole threadpool.
let pendingAccessChecks = 0;
const MAX_PENDING_ACCESS_CHECKS = 2;

/**
 * Like resolveExistingPath, but never blocks the main process: the existence
 * check is asynchronous and gives up after `ms` (a dead network share would
 * otherwise freeze the whole window inside a synchronous fs call).
 *
 * @param {unknown} target
 * @param {number} [ms=3000]
 * @returns {Promise<string|null>}
 */
async function resolveExistingPathAsync(target, ms = 3000) {
  const resolved = normalizeTargetPath(target);
  if (!resolved || pendingAccessChecks >= MAX_PENDING_ACCESS_CHECKS) return null;
  pendingAccessChecks++;
  const check = fs.promises.access(resolved).then(() => true, () => false);
  // Released when the OS call returns, not when we stop waiting for it.
  check.finally(() => { pendingAccessChecks--; });
  const ok = await withTimeout(check, ms, false);
  return ok ? resolved : null;
}

/**
 * @param {Date} date
 * @returns {string} e.g. terminal-20261109-213005.txt
 */
function formatLogFileName(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `terminal-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.txt`;
}

/**
 * Write terminal text to <dir>/terminal-<timestamp>.txt (UTF-8 with BOM so
 * every Windows editor shows Turkish characters correctly).
 *
 * @param {unknown} text
 * @param {string} dir
 * @param {Date} [now]
 * @returns {{ok: true, path: string, chars: number} | {ok: false, message: string}}
 */
function saveTerminalLog(text, dir, now = new Date()) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, message: 'Kaydedilecek cikti yok.' };
  if (typeof dir !== 'string' || !dir) return { ok: false, message: 'Kayit klasoru bulunamadi.' };
  const body = text.length > MAX_LOG_CHARS ? text.slice(text.length - MAX_LOG_CHARS) : text;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const content = '\ufeff' + body.replace(/\r?\n/g, '\r\n');
    const base = formatLogFileName(now);
    // 'wx' = create only if missing (atomic), so two saves in the same second
    // can never overwrite each other: on EEXIST try the next suffix.
    for (let i = 1; i < 100; i++) {
      const file = path.join(dir, i === 1 ? base : base.replace(/\.txt$/, `-${i}.txt`));
      try {
        fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' });
        return { ok: true, path: file, chars: body.length };
      } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err;
      }
    }
    return { ok: false, message: 'Bu saniye icin cok fazla kayit var, tekrar dene.' };
  } catch (err) {
    return { ok: false, message: `Dosya yazilamadi: ${err && err.code ? err.code : 'bilinmeyen hata'}` };
  }
}

/**
 * Resolve with fallback after `ms` instead of waiting forever (an offline
 * network drive can stall a disk query for a long time).
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {T} fallback
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, fallback) {
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Capacity of every reachable drive letter.
 *
 * @param {(p: string) => Promise<{bsize: number, blocks: number, bavail: number}>} [statfs]
 * @returns {Promise<Array<{drive: string, totalBytes: number, freeBytes: number, usedPercent: number}>>}
 */
// Probes still running, per statfs function. A drive whose previous probe has
// not answered yet is skipped: every stuck probe holds one of libuv's few
// threadpool threads, and re-probing a dead network drive every poll would
// soon starve ALL async file I/O in the main process (directory panel, logs).
const inflightProbes = new WeakMap();

async function listDrives(statfs = defaultStatfs) {
  if (!inflightProbes.has(statfs)) inflightProbes.set(statfs, new Set());
  const inflight = inflightProbes.get(statfs);

  const probes = DRIVE_LETTERS.map((letter) => {
    if (inflight.has(letter)) return Promise.resolve(null);
    inflight.add(letter);
    const probe = Promise.resolve()
      .then(() => statfs(`${letter}:\\`))
      .then((s) => {
        const totalBytes = Number(s.bsize) * Number(s.blocks);
        const freeBytes = Number(s.bsize) * Number(s.bavail);
        if (!(totalBytes > 0) || !(freeBytes >= 0)) return null;
        const usedPercent = Math.max(0, Math.min(100, Math.round(((totalBytes - freeBytes) / totalBytes) * 100)));
        return { drive: `${letter}:`, totalBytes, freeBytes, usedPercent };
      })
      .catch(() => null);
    // Released only when the OS call really returns, not when we stop waiting.
    probe.finally(() => inflight.delete(letter));
    return withTimeout(probe, DRIVE_PROBE_TIMEOUT_MS, null);
  });
  return (await Promise.all(probes)).filter(Boolean);
}

function defaultStatfs(p) {
  return fs.promises.statfs(p);
}

/** @returns {number} probes currently waiting on the OS (for tests) */
function pendingProbeCount(statfs = defaultStatfs) {
  const set = inflightProbes.get(statfs);
  return set ? set.size : 0;
}

const CHANNELS = ['system:open-path', 'system:reveal-path', 'system:open-external', 'system:save-log', 'system:drives'];

/**
 * @param {Electron.IpcMain} ipcMain
 * @param {{ shell: Electron.Shell, getLogDir: () => string }} deps
 */
function registerSystemIpc(ipcMain, deps) {
  if (!ipcMain || !deps || !deps.shell) return;
  const { shell, getLogDir } = deps;

  ipcMain.handle('system:open-path', async (_e, target) => {
    const resolved = await resolveExistingPathAsync(target);
    if (!resolved) return { ok: false, message: 'Yol bulunamadi.' };
    const error = await shell.openPath(resolved);
    return error ? { ok: false, message: error } : { ok: true };
  });

  ipcMain.handle('system:reveal-path', async (_e, target) => {
    const resolved = await resolveExistingPathAsync(target);
    if (!resolved) return { ok: false, message: 'Yol bulunamadi.' };
    shell.showItemInFolder(resolved);
    return { ok: true };
  });

  ipcMain.handle('system:open-external', async (_e, url) => {
    if (!isSafeExternalUrl(url)) return { ok: false, message: 'Sadece http/https linkleri acilir.' };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle('system:save-log', async (_e, text) => saveTerminalLog(text, getLogDir()));

  ipcMain.handle('system:drives', async () => listDrives());
}

/** @param {Electron.IpcMain} ipcMain */
function unregisterSystemIpc(ipcMain) {
  if (!ipcMain || typeof ipcMain.removeHandler !== 'function') return;
  CHANNELS.forEach((ch) => { try { ipcMain.removeHandler(ch); } catch (_e) {} });
}

module.exports = {
  isSafeExternalUrl,
  resolveExistingPath,
  resolveExistingPathAsync,
  normalizeTargetPath,
  pendingProbeCount,
  formatLogFileName,
  saveTerminalLog,
  listDrives,
  withTimeout,
  registerSystemIpc,
  unregisterSystemIpc,
  CHANNELS
};
