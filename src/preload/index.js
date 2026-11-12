/**
 * XYRON CENTER - Preload Context Bridge
 * File: src/preload/index.js
 * 
 * Secure context-isolated bridge exposing strictly typed and validated APIs
 * to the Renderer process:
 * - window.telemetryApi: onUpdate(cb), getSnapshot()
 * - window.processApi: kill(pid), list()
 * - window.terminalApi: sendInput(data), resize(cols, rows), onOutput(cb), onCwdChange(cb), onExit(cb), setCwd(path), getCwd(), restart(shell)
 * - window.elevationApi: onStatus(cb), execute(cmd), getStatus()
 * - window.fsApi: readDir(path), watchDir(path), onDirUpdated(cb)
 * - window.windowApi: minimize(), maximize(), close()
 */

let electron;
try {
  electron = require('electron');
} catch (_e) {
  try {
    electron = require('../../2_Proje_Dosyalari_Source/node_modules/electron');
  } catch (_e2) {
    electron = null;
  }
}

const isElectron = typeof electron === 'object' && electron !== null;
const contextBridge = isElectron ? electron.contextBridge : null;
const ipcRenderer = isElectron ? electron.ipcRenderer : null;

/**
 * Helper to subscribe to IPC channels with an unsubscription closure
 * preventing memory leaks across view re-renders.
 *
 * @param {string} channel
 * @returns {Function} (callback: Function) => unsubscribeFunction
 */
function createSubscriber(channel) {
  return (callback) => {
    if (typeof callback !== 'function' || !ipcRenderer) {
      return () => {};
    }
    const handler = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, handler);
    return () => {
      try {
        ipcRenderer.removeListener(channel, handler);
      } catch (_e) {}
    };
  };
}

/**
 * Telemetry API
 */
const telemetryApi = {
  /**
   * Listen for continuous 3-tier telemetry updates from Main process.
   * @param {Function} callback - (telemetry: Object) => void
   * @returns {Function} Unsubscribe cleanup function
   */
  onUpdate: createSubscriber('telemetry:update'),

  /**
   * Fetch instantaneous telemetry snapshot on-demand.
   * @returns {Promise<Object|null>}
   */
  getSnapshot: async () => {
    if (!ipcRenderer) return null;
    return await ipcRenderer.invoke('telemetry:get-snapshot');
  }
};

/**
 * Process Management API
 */
const processApi = {
  /**
   * Forcefully terminate an OS process and its process tree via taskkill.
   * @param {number|string} pid - Process ID to terminate
   * @returns {Promise<{ success: boolean, message: string }>}
   */
  kill: async (pid) => {
    if (!ipcRenderer) {
      return { success: false, message: 'IPC bridge unavailable' };
    }
    return await ipcRenderer.invoke('process:kill', pid);
  },

  /**
   * Retrieve active OS running processes list.
   * @returns {Promise<Array<Object>>}
   */
  list: async () => {
    if (!ipcRenderer) return [];
    return await ipcRenderer.invoke('process:list');
  }
};

/**
 * ConPTY Terminal API
 */
const terminalApi = {
  /**
   * Send raw input or keystrokes into ConPTY shell.
   * @param {string} data
   */
  sendInput: (data) => {
    if (ipcRenderer && typeof data === 'string') {
      ipcRenderer.send('terminal:input', data);
    }
  },

  /**
   * Notify ConPTY terminal of geometry viewport resize.
   * @param {number} cols
   * @param {number} rows
   */
  resize: (cols, rows) => {
    if (ipcRenderer) {
      ipcRenderer.send('terminal:resize', {
        cols: Math.max(10, Math.min(500, parseInt(cols, 10) || 100)),
        rows: Math.max(5, Math.min(200, parseInt(rows, 10) || 30))
      });
    }
  },

  /**
   * Listen to virtual terminal stdout stream chunks.
   * @param {Function} callback - (chunk: string) => void
   * @returns {Function} Unsubscribe function
   */
  onOutput: createSubscriber('terminal:output'),

  /**
   * Listen for terminal active working directory changes.
   * @param {Function} callback - (dirPath: string) => void
   * @returns {Function} Unsubscribe function
   */
  onCwdChange: createSubscriber('terminal:cwd-change'),

  /**
   * Listen for terminal child process exit.
   * @param {Function} callback - ({ exitCode: number, signal?: string }) => void
   * @returns {Function} Unsubscribe function
   */
  onExit: createSubscriber('terminal:exit'),

  /**
   * Programmatically change active working directory of ConPTY session.
   * @param {string} dirPath
   * @returns {Promise<boolean>}
   */
  setCwd: async (dirPath) => {
    if (!ipcRenderer || typeof dirPath !== 'string') return false;
    return await ipcRenderer.invoke('terminal:set-cwd', dirPath);
  },

  /**
   * Retrieve current active working directory of the terminal.
   * @returns {Promise<string>}
   */
  getCwd: async () => {
    if (!ipcRenderer) return '';
    return await ipcRenderer.invoke('terminal:cwd-get');
  },

  /**
   * Put a full line at the prompt, replacing any half-typed text.
   * @param {string} text
   * @param {boolean} [run=false] - also press Enter
   */
  submitLine: (text, run = false) => {
    if (ipcRenderer && typeof text === 'string') ipcRenderer.send('terminal:submit', { text, run: run === true });
  },

  /**
   * Restart the terminal session with specified shell ('powershell' | 'cmd').
   * @param {string} [shell]
   * @returns {Promise<{ success: boolean, cwd: string, shellType: string }>}
   */
  restart: async (shell) => {
    if (!ipcRenderer) return { success: false, cwd: '', shellType: '' };
    return await ipcRenderer.invoke('terminal:restart', shell);
  }
};

/**
 * In-Terminal Elevation API
 */
const elevationApi = {
  /**
   * Listen for OP mode transitions and security context changes.
   * @param {Function} callback - ({ unlocked: boolean, identity: string }) => void
   * @returns {Function} Unsubscribe function
   */
  onStatus: createSubscriber('op:status'),

  /**
   * Execute an in-terminal elevated command.
   * @param {string} cmd
   */
  execute: (cmd) => {
    if (ipcRenderer && typeof cmd === 'string') {
      ipcRenderer.send('op:execute', cmd);
    }
  },

  /**
   * Query current OP security status snapshot.
   * @returns {Promise<{ unlocked: boolean, identity: string }>}
   */
  getStatus: async () => {
    if (!ipcRenderer) return { unlocked: false, identity: 'UNKNOWN' };
    return await ipcRenderer.invoke('op:get-status');
  }
};

/**
 * Filesystem API (Active Directory Tree)
 */
const fsApi = {
  /**
   * Read directory entries with metadata.
   * @param {string} dirPath
   * @returns {Promise<Array<{ name: string, isDirectory: boolean, size: number, mtime: string|null }>>}
   */
  readDir: async (dirPath) => {
    if (!ipcRenderer || typeof dirPath !== 'string') return [];
    return await ipcRenderer.invoke('fs:read-dir', dirPath);
  },

  /**
   * Register filesystem watcher on active directory.
   * @param {string} dirPath
   * @returns {Promise<boolean>}
   */
  watchDir: async (dirPath) => {
    if (!ipcRenderer || typeof dirPath !== 'string') return false;
    return await ipcRenderer.invoke('fs:watch-dir', dirPath);
  },

  /**
   * Listen for filesystem update notifications for current CWD.
   * @param {Function} callback - (dirPath: string) => void
   * @returns {Function} Unsubscribe function
   */
  onDirUpdated: createSubscriber('fs:dir-updated')
};

/**
 * Customization / Configuration API (boot intro, driven by /xyron terminal commands)
 */
// Terminal attach handshake: tells the main process the xterm is ready, so it can
// replay the shell output printed so far (the first prompt) in order.
terminalApi.ready = () => {
  if (ipcRenderer) ipcRenderer.send('terminal:ready');
};

const xyronConfig = {
  /**
   * Fetch the current boot intro configuration.
   * @returns {Promise<Object|null>}
   */
  getBoot: async () => {
    if (!ipcRenderer) return null;
    return await ipcRenderer.invoke('config:get-boot');
  },

  /**
   * Fetch the full configuration object.
   * @returns {Promise<Object|null>}
   */
  getAll: async () => {
    if (!ipcRenderer) return null;
    return await ipcRenderer.invoke('config:get');
  },

  /**
   * Fetch the current live-theme configuration.
   * @returns {Promise<Object|null>}
   */
  getTheme: async () => {
    if (!ipcRenderer) return null;
    return await ipcRenderer.invoke('config:get-theme');
  },

  /**
   * Listen for live config updates emitted when the user runs `/xyron ...`.
   * Callback receives { boot: {...}, replay: boolean }.
   * @param {Function} callback
   * @returns {Function} Unsubscribe function
   */
  onBootUpdate: createSubscriber('config:boot-updated'),

  /**
   * Listen for live-theme updates emitted when the user runs `/xyron theme ...`.
   * Callback receives { theme: { accentColor, crtScanlines } }.
   * @param {Function} callback
   * @returns {Function} Unsubscribe function
   */
  onThemeUpdate: createSubscriber('config:theme-updated')
};

/**
 * Frameless Window API
 */
const windowApi = {
  /** Minimize window */
  minimize: () => {
    if (ipcRenderer) ipcRenderer.send('window:minimize');
  },

  /** Maximize / Unmaximize / Restore window */
  maximize: () => {
    if (ipcRenderer) ipcRenderer.send('window:maximize');
  },

  /** Close application window */
  close: () => {
    if (ipcRenderer) ipcRenderer.send('window:close');
  }
};

// Plain-text clipboard for the terminal (copy selection / paste).
const electronClipboard = electron && electron.clipboard ? electron.clipboard : null;
const clipboardApi = {
  readText: () => {
    try { return electronClipboard ? String(electronClipboard.readText() || '') : ''; } catch (_e) { return ''; }
  },
  writeText: (text) => {
    if (typeof text !== 'string' || !electronClipboard) return false;
    try { electronClipboard.writeText(text); return true; } catch (_e) { return false; }
  }
};

/**
 * Desktop integration: open files/links, save the terminal log, drive space.
 * Every call resolves to a result object and never throws into the page.
 */
const invokeSafe = async (channel, arg, fallback) => {
  if (!ipcRenderer) return fallback;
  try { return await ipcRenderer.invoke(channel, arg); } catch (_e) { return fallback; }
};
const failed = { ok: false, message: 'IPC kullanilamiyor.' };
const electronWebUtils = electron && electron.webUtils ? electron.webUtils : null;
const systemApi = {
  /** @param {string} p @returns {Promise<{ok:boolean,message?:string}>} */
  openPath: (p) => (typeof p === 'string' ? invokeSafe('system:open-path', p, failed) : Promise.resolve(failed)),
  /** @param {string} p @returns {Promise<{ok:boolean,message?:string}>} */
  revealPath: (p) => (typeof p === 'string' ? invokeSafe('system:reveal-path', p, failed) : Promise.resolve(failed)),
  /** @param {string} url @returns {Promise<{ok:boolean,message?:string}>} */
  openExternal: (url) => (typeof url === 'string' ? invokeSafe('system:open-external', url, failed) : Promise.resolve(failed)),
  /** @param {string} text @returns {Promise<{ok:boolean,path?:string,message?:string}>} */
  saveLog: (text) => (typeof text === 'string' ? invokeSafe('system:save-log', text, failed) : Promise.resolve(failed)),
  /** @returns {Promise<Array<{drive:string,totalBytes:number,freeBytes:number,usedPercent:number}>>} */
  getDrives: () => invokeSafe('system:drives', undefined, []),
  /**
   * Real disk path of a File dropped from Explorer ('' when unknown).
   * Electron removed File.path; webUtils is the supported replacement.
   * @param {File} file
   * @returns {string}
   */
  pathForFile: (file) => {
    try { return electronWebUtils ? String(electronWebUtils.getPathForFile(file) || '') : ''; } catch (_e) { return ''; }
  }
};

// Expose strictly into Main World when context isolation is enabled
if (contextBridge && typeof contextBridge.exposeInMainWorld === 'function') {
  try {
    contextBridge.exposeInMainWorld('clipboardApi', clipboardApi);
    contextBridge.exposeInMainWorld('telemetryApi', telemetryApi);
    contextBridge.exposeInMainWorld('processApi', processApi);
    contextBridge.exposeInMainWorld('terminalApi', terminalApi);
    contextBridge.exposeInMainWorld('elevationApi', elevationApi);
    contextBridge.exposeInMainWorld('fsApi', fsApi);
    contextBridge.exposeInMainWorld('windowApi', windowApi);
    contextBridge.exposeInMainWorld('xyronConfig', xyronConfig);
    contextBridge.exposeInMainWorld('systemApi', systemApi);
  } catch (err) {
    console.error('[Preload] Failed to expose APIs via contextBridge:', err);
  }
} else if (typeof window !== 'undefined') {
  window.telemetryApi = telemetryApi;
  window.processApi = processApi;
  window.terminalApi = terminalApi;
  window.elevationApi = elevationApi;
  window.fsApi = fsApi;
  window.windowApi = windowApi;
  window.xyronConfig = xyronConfig;
  window.clipboardApi = clipboardApi;
  window.systemApi = systemApi;
}

// Export for headless test harnesses
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    telemetryApi,
    processApi,
    terminalApi,
    elevationApi,
    fsApi,
    windowApi,
    xyronConfig,
    clipboardApi,
    systemApi,
    createSubscriber
  };
}
