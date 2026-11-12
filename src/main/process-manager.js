/**
 * XYRON CENTER - Windows Process Manager & Live Hex Matrix Generator
 * File: src/main/process-manager.js
 * 
 * 100% Live OS process enumeration, tree termination API, and Windows CNG
 * hardware entropy hex diagnostic matrix streaming with ZERO mock data.
 */

const cp = require('child_process');
const crypto = require('crypto');
const os = require('os');

/**
 * Safely convert any numeric, bigint, or string value into an unsigned 64-bit BigInt [0n, 2^64-1n].
 * Strips floating-point decimals to avoid RangeError and clamps out-of-range/negative values.
 *
 * @param {*} val
 * @returns {bigint}
 */
function toBigUInt64(val) {
  if (val === null || val === undefined) return 0n;
  const MAX_UINT64 = 0xFFFFFFFFFFFFFFFFn;
  if (typeof val === 'bigint') {
    if (val < 0n) return 0n;
    return val > MAX_UINT64 ? MAX_UINT64 : val;
  }
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || val <= 0) return 0n;
    const floored = Math.floor(val);
    if (floored <= Number.MAX_SAFE_INTEGER) return BigInt(floored);
    try {
      const b = BigInt(floored);
      return b > MAX_UINT64 ? MAX_UINT64 : b;
    } catch (_e) {
      return MAX_UINT64;
    }
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return 0n;
    if (trimmed.includes('.')) {
      const num = Number(trimmed);
      if (!Number.isFinite(num) || num <= 0) return 0n;
      return BigInt(Math.floor(num));
    }
    try {
      const b = BigInt(trimmed);
      if (b < 0n) return 0n;
      return b > MAX_UINT64 ? MAX_UINT64 : b;
    } catch (_e) {
      return 0n;
    }
  }
  return 0n;
}

/**
 * Safely convert any value into an unsigned 32-bit integer [0, 4294967295].
 *
 * @param {*} val
 * @returns {number}
 */
function toUInt32(val) {
  if (typeof val === 'bigint') {
    if (val <= 0n) return 0;
    return Number(val & 0xFFFFFFFFn);
  }
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return (Math.floor(num) >>> 0);
}

class ProcessManager {
  constructor(options = {}) {
    this.cachedProcesses = [];
    this.lastFetchTime = 0;
    this.baseHexOffset = 0x00400000; // Win32 Image Base default
    this.hexSequence = 0;
    this.isFetching = false;
    this.tasklistTimeoutMs = Number.isFinite(options.tasklistTimeoutMs) ? options.tasklistTimeoutMs : 4000;
  }

  /**
   * Split a single CSV line into tokens conforming to RFC 4180.
   * Handles quoted strings, embedded commas, and escaped quotes ("").
   *
   * @param {string} line - Raw CSV line from tasklist
   * @returns {string[]} Array of token strings
   */
  parseCsvLine(line) {
    if (!line || typeof line !== 'string') return [];
    const tokens = [];
    let cur = '';
    let inQuotes = false;
    const len = line.length;

    for (let i = 0; i < len; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuotes && i + 1 < len && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (c === ',' && !inQuotes) {
        tokens.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    }
    tokens.push(cur.trim());
    return tokens;
  }

  /**
   * Enumerate real running Windows processes using `tasklist /FO CSV /NH`.
   * Parses image name, PID, session name, session number, and exact memory working set.
   *
   * @returns {Promise<ProcessEntry[]>}
   */
  async getProcesses() {
    // Prevent overlapping tasklist executions
    if (this.isFetching && this.cachedProcesses.length > 0) {
      return this.cachedProcesses;
    }

    this.isFetching = true;

    return new Promise((resolve) => {
      cp.execFile(
        'tasklist',
        ['/FO', 'CSV', '/NH'],
        {
          maxBuffer: 10 * 1024 * 1024,
          timeout: this.tasklistTimeoutMs,
          windowsHide: true
        },
        (err, stdout, stderr) => {
          this.isFetching = false;

          if (err) {
            if (err.killed || err.signal === 'SIGTERM') {
              console.error(`[ProcessManager] tasklist execution timed out after ${this.tasklistTimeoutMs}ms`);
            } else {
              console.error('[ProcessManager] tasklist execution failed:', err.message);
            }
            resolve(this.cachedProcesses);
            return;
          }

          const lines = stdout.trim().split(/\r?\n/).filter(l => l.trim().length > 0);
          const results = [];

          for (const line of lines) {
            const tokens = this.parseCsvLine(line);
            if (tokens.length >= 5) {
              const nameRaw = tokens[0];
              const pidStr = tokens[1];
              const sessionRaw = tokens[2];
              const sessionNumStr = tokens[3];
              const memStr = tokens[4];

              const name = nameRaw.replace(/^"|"$/g, '');
              const pid = parseInt(pidStr.replace(/^"|"$/g, ''), 10);
              const session = sessionRaw.replace(/^"|"$/g, '');
              const sessionNum = parseInt(sessionNumStr.replace(/^"|"$/g, ''), 10);

              // Universal numeric sanitization: removes localized thousand dots/commas
              // E.g. "1.652 K" (TR), "1,652 K" (EN), "3.282.180 K" -> pure integer KB
              const numericMem = memStr.replace(/[^\d]/g, '');
              const memKb = numericMem ? parseInt(numericMem, 10) : 0;
              const memBytes = memKb * 1024;

              results.push({
                pid: isNaN(pid) ? 0 : pid,
                name: name || 'unknown',
                session: session || 'unknown',
                sessionNum: isNaN(sessionNum) ? 0 : sessionNum,
                memUsage: memStr.replace(/^"|"$/g, '') || '0 K',
                memBytes: memBytes
              });
            }
          }

          this.cachedProcesses = results;
          this.lastFetchTime = Date.now();
          resolve(results);
        }
      );
    });
  }

  /**
   * Alias for getProcesses() to satisfy interface contract.
   * @returns {Promise<ProcessEntry[]>}
   */
  async getProcessList() {
    return await this.getProcesses();
  }

  /**
   * Terminate an OS process and its child process tree via `taskkill /F /PID <pid> /T`.
   * Enforces strict type checking, guards kernel processes, and provides clean status messages.
   *
   * @param {number|string} pid - Process ID to terminate
   * @returns {Promise<{ success: boolean, message: string }>}
   */
  async killProcess(pid) {
    // 1. Strict type validation: reject booleans, objects, arrays, null, undefined, functions, symbols
    if (typeof pid !== 'number' && typeof pid !== 'string') {
      return {
        success: false,
        message: `Invalid PID type: received ${typeof pid}. PID must be a positive integer.`
      };
    }

    // 2. Reject empty or whitespace-only strings
    if (typeof pid === 'string' && pid.trim() === '') {
      return {
        success: false,
        message: 'Invalid PID: empty string. PID must be a positive integer.'
      };
    }

    const numericPid = Number(pid);

    // 3. Reject non-integer, NaN, or negative representations
    if (!Number.isInteger(numericPid) || numericPid < 0) {
      return {
        success: false,
        message: `Invalid PID: "${pid}". PID must be a positive integer.`
      };
    }

    // 4. Guard against terminating critical Windows kernel structures (PID 0 System Idle, PID 4 System Kernel)
    if (numericPid === 0 || numericPid === 4) {
      return {
        success: false,
        message: `Protected Windows Kernel process (PID ${numericPid}) cannot be terminated.`
      };
    }

    return new Promise((resolve) => {
      cp.execFile(
        'taskkill',
        ['/F', '/PID', String(numericPid), '/T'],
        { timeout: 4000, windowsHide: true },
        (err, stdout, stderr) => {
          const out = (stdout || '').trim();
          const errOut = (stderr || '').trim();

          if (err) {
            const rawMsg = errOut || out || err.message;
            let friendlyMsg = rawMsg;

            const lower = rawMsg.toLowerCase();
            if (lower.includes('not found') || lower.includes('bulunamad')) {
              friendlyMsg = `Process with PID ${numericPid} was not found (it may have already exited).`;
            } else if (lower.includes('critical system process') || lower.includes('kritik sistem')) {
              friendlyMsg = `Process with PID ${numericPid} is a critical Windows system process and cannot be terminated.`;
            } else if (
              lower.includes('access is denied') ||
              lower.includes('erisim engellendi') ||
              lower.includes('erişim engellendi')
            ) {
              friendlyMsg = `Access denied terminating PID ${numericPid}. Administrator privileges required.`;
            }

            resolve({
              success: false,
              message: friendlyMsg
            });
          } else {
            resolve({
              success: true,
              message: out || `Process with PID ${numericPid} and child processes were terminated.`
            });
          }
        }
      );
    });
  }

  /**
   * Generate Live Hex Diagnostic Matrix with zero static or mock data.
   * Packs real performance counters, timestamps, memory stats, and Windows CNG hardware entropy.
   *
   * @param {Object} [telemetryContext={}] - Live system context (rxBytes, txBytes, cpuLoad, procCount)
   * @param {number} [rowCount=8] - Rows of 16-byte hex output (minimum 4 rows / 64 bytes)
   * @returns {HexDiagnosticSnapshot}
   */
  generateLiveHexMatrix(telemetryContext = {}, rowCount = 8) {
    // 1. Buffer sizing guard: Enforce minimum 4 rows (64 bytes) to safely accommodate
    // the 4 telemetry header blocks (offsets 0..63) and clamp to safe ceiling.
    const rawRows = typeof rowCount === 'number' ? rowCount : parseInt(rowCount, 10);
    const safeRowCount = Number.isFinite(rawRows) ? Math.min(256, Math.max(4, Math.floor(rawRows))) : 8;
    const totalBytes = safeRowCount * 16;
    const buf = Buffer.alloc(totalBytes);

    // Defensive context unwrap
    const ctx = (telemetryContext && typeof telemetryContext === 'object') ? telemetryContext : {};

    // 2. High-Resolution Timestamps (16 bytes, offsets 0..15)
    const nowMs = toBigUInt64(Date.now());
    const hr = typeof process.hrtime.bigint === 'function' ? toBigUInt64(process.hrtime.bigint()) : 0n;
    buf.writeBigUInt64BE(nowMs, 0);
    buf.writeBigUInt64BE(hr, 8);

    // 3. Physical Memory and System Uptime (16 bytes, offsets 16..31)
    const freeMem = toBigUInt64(os.freemem());
    const uptimeSec = toUInt32(os.uptime());
    const seq = toUInt32((this.hexSequence++) & 0xFFFFFFFF);
    buf.writeBigUInt64BE(freeMem, 16);
    buf.writeUInt32BE(uptimeSec, 24);
    buf.writeUInt32BE(seq, 28);

    // 4. Clean BigInt Network Byte Deltas (16 bytes, offsets 32..47)
    const rx = toBigUInt64(ctx.rxBytes);
    const tx = toBigUInt64(ctx.txBytes);
    buf.writeBigUInt64BE(rx, 32);
    buf.writeBigUInt64BE(tx, 40);

    // 5. Process / CPU Statistics & Hardware Topology (16 bytes, offsets 48..63)
    const procCount = toUInt32(ctx.procCount !== undefined ? ctx.procCount : (this.cachedProcesses.length || 0));
    const cpuLoad = toUInt32(Math.round(Math.max(0, Number(ctx.cpuLoad) || 0) * 100));
    const pid = toUInt32(process.pid);
    const cores = toUInt32(os.cpus().length);
    buf.writeUInt32BE(procCount, 48);
    buf.writeUInt32BE(cpuLoad, 52);
    buf.writeUInt32BE(pid, 56);
    buf.writeUInt32BE(cores, 60);

    // 6. Windows CNG Hardware Entropy (BCryptGenRandom via crypto.randomBytes)
    if (totalBytes > 64) {
      const entropySize = totalBytes - 64;
      const entropy = crypto.randomBytes(entropySize);
      entropy.copy(buf, 64);
    }

    // 7. Format into 16-byte rows with address offsets, hex bytes, and ASCII representation
    const rows = [];
    const currentBase = (this.baseHexOffset + ((this.hexSequence * 16) & 0x00FFFFFF)) >>> 0;

    for (let i = 0; i < totalBytes; i += 16) {
      const slice = buf.subarray(i, i + 16);
      const rowOffset = (currentBase + i).toString(16).toUpperCase().padStart(8, '0');

      const hexParts = [];
      let ascii = '';
      for (let j = 0; j < 16; j++) {
        const byte = slice[j];
        hexParts.push(byte.toString(16).toUpperCase().padStart(2, '0'));
        // Standard printable ASCII characters (32..126)
        if (byte >= 32 && byte <= 126) {
          ascii += String.fromCharCode(byte);
        } else {
          ascii += '.';
        }
      }

      const hexBytes = `${hexParts.slice(0, 8).join(' ')}   ${hexParts.slice(8, 16).join(' ')}`;
      const formattedLine = `0x${rowOffset}:  ${hexBytes}  |${ascii}|`;

      rows.push({
        offset: `0x${rowOffset}`,
        hexBytes: hexBytes,
        ascii: ascii,
        raw: formattedLine
      });
    }

    return {
      baseOffset: `0x${currentBase.toString(16).toUpperCase().padStart(8, '0')}`,
      sequence: this.hexSequence,
      rows: rows,
      timestamp: Date.now()
    };
  }

  /**
   * Generate single hex frame representation for telemetry payload compatibility.
   * @param {Object} telemetryContext
   * @returns {{ offset: string, hexBytes: string, ascii: string, rows: Array }}
   */
  generateHexFrame(telemetryContext = {}) {
    const matrix = this.generateLiveHexMatrix(telemetryContext, 8);
    const firstRow = matrix.rows[0] || {
      offset: '0x00400000',
      hexBytes: '00 00 00 00 00 00 00 00   00 00 00 00 00 00 00 00',
      ascii: '................'
    };

    return {
      offset: firstRow.offset,
      hexBytes: firstRow.hexBytes,
      ascii: firstRow.ascii,
      rows: matrix.rows
    };
  }

  /**
   * Register Electron IPC main handlers.
   *
   * @param {Electron.IpcMain} ipcMain
   */
  registerIpc(ipcMain) {
    if (!ipcMain) return;

    ipcMain.handle('process:list', async () => {
      return await this.getProcesses();
    });

    ipcMain.handle('process:kill', async (_event, payload) => {
      const pid = payload && payload.pid !== undefined ? payload.pid : payload;
      return await this.killProcess(pid);
    });

    ipcMain.handle('hex:snapshot', async (_event, context) => {
      return this.generateLiveHexMatrix(context || {}, 8);
    });
  }
}

module.exports = ProcessManager;
