/**
 * XYRON CENTER - Windows ConPTY Terminal Manager
 * File: src/main/pty-manager.js
 * 
 * Manages native Windows ConPTY terminal sessions via node-pty (useConpty: true),
 * enforces Turkish UTF-8 code page (chcp 65001), provides zero-overhead CWD tracking
 * via OSC 0 / WindowTitle sequence interception, eliminates ANSI escape sequence buffer
 * pollution, ensures safe teardown and resize error suppression, and exposes clean
 * Electron IPC channels with leak-free registration lifecycle.
 */

let pty;
try {
  pty = require('node-pty');
} catch (_e) {
  pty = require('../../../2_Proje_Dosyalari_Source/node_modules/node-pty');
}

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');

let ElevationDaemon;
try {
  ElevationDaemon = require('./elevation-daemon');
} catch (_e) {
  ElevationDaemon = require('../../../2_Proje_Dosyalari_Source/src/main/elevation-daemon');
}

let shellHelpers;
try {
  shellHelpers = require('./shell-helpers');
} catch (_e) {
  shellHelpers = require('../../../2_Proje_Dosyalari_Source/src/main/shell-helpers');
}

// Cap on replayable terminal output kept in memory (characters).
const MAX_OUTPUT_HISTORY = 262144;

// Regex matching ANSI / VT cursor and control sequences (e.g. \x1b[A, \x1b[B, \x1b[C, \x1b[D, \x1b[H, \x1b[F, \x1b[1~, \x1b[4~)
const ANSI_CURSOR_ESCAPE_REGEX = /\x1b(?:\[[0-9;?]*[a-zA-Z~]|O[A-Za-z])/g;

class PtyManager extends EventEmitter {
  /**
   * @param {Object|Electron.BrowserWindow} [optionsOrWindow] - Options bag or Electron BrowserWindow
   * @param {Electron.BrowserWindow} [optionsOrWindow.mainWindow] - Target Electron BrowserWindow
   * @param {string} [optionsOrWindow.shellType] - 'powershell' or 'cmd' (default: 'powershell')
   * @param {string} [optionsOrWindow.cwd] - Initial working directory
   * @param {number} [optionsOrWindow.cols] - Terminal columns (default: 100)
   * @param {number} [optionsOrWindow.rows] - Terminal rows (default: 30)
   * @param {Object} [optionsOrWindow.elevationDaemon] - Elevation daemon instance for /op handling
   */
  constructor(optionsOrWindow = {}) {
    super();

    // Support both new PtyManager(mockWindow) and new PtyManager({ mainWindow: mockWindow })
    let options = {};
    if (optionsOrWindow && (optionsOrWindow.webContents || typeof optionsOrWindow.isDestroyed === 'function' || typeof optionsOrWindow.emit === 'function')) {
      options = { mainWindow: optionsOrWindow };
    } else if (typeof optionsOrWindow === 'object' && optionsOrWindow !== null) {
      options = optionsOrWindow;
    }

    this.mainWindow = options.mainWindow || null;
    this.shellType = options.shellType || 'powershell';
    this.currentCwd = this._resolveValidDirectory(options.cwd) || process.env.USERPROFILE || os.homedir() || process.cwd();
    this.initialCols = typeof options.cols === 'number' && options.cols > 0 ? options.cols : 100;
    this.initialRows = typeof options.rows === 'number' && options.rows > 0 ? options.rows : 30;
    
    // Hold shell output until the renderer's terminal view is attached, then
    // replay it, so the first prompt is never lost to a not-yet-created xterm.
    this.deferUntilRenderer = options.deferUntilRenderer === true;
    this._rendererReady = false;
    this._outputHistory = '';
    // Directory where the in-shell helper script (xcmd / xadmin / xsys) is written.
    this.helperDir = options.helperDir || null;
    this.helperPath = null;

    this.ptyProcess = null;
    this.inputInterceptor = null;
    this.oscBuffer = '';
    this._disposed = false;
    this._ipcRegistered = false;
    this._ipcMain = null;
    this._boundIpcHandlers = {};

    // Wire elevation daemon: use provided instance or instantiate default
    if (options.elevationDaemon) {
      this.elevationDaemon = options.elevationDaemon;
      if (typeof this.elevationDaemon.attachPtyManager === 'function') {
        this.elevationDaemon.attachPtyManager(this);
      }
    } else {
      this.elevationDaemon = new ElevationDaemon({
        mainWindow: this.mainWindow,
        cwd: this.currentCwd
      });
      this.elevationDaemon.attachPtyManager(this);
    }
  }

  /**
   * Initialize and spawn the native ConPTY terminal session.
   *
   * @param {string} [shellType] - Optional override: 'powershell' or 'cmd'
   */
  init(shellType) {
    if (this._disposed) {
      this._disposed = false;
    }

    if (shellType) {
      this.shellType = shellType;
    }

    // Destroy any existing session prior to re-initializing
    this._destroyInternalPty();

    const isPowershell = this.shellType.toLowerCase().includes('powershell');
    let shellExecutable;
    let shellArgs = [];

    if (isPowershell) {
      // Full path: a PC with a broken/trimmed PATH must still get a shell.
      const psFull = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      shellExecutable = fs.existsSync(psFull) ? psFull : 'powershell.exe';

      // Load the in-shell helpers (xcmd / xadmin / xsys) when a helper dir is configured.
      this.helperPath = this.helperDir ? shellHelpers.ensureHelperScript(this.helperDir) : null;
      const loadHelpers = this.helperPath
        ? `. ${shellHelpers.psQuote(this.helperPath)}; `
        : '';

      shellArgs = [
        '-NoExit',
        // -NoProfile: a user profile can add seconds to every startup and change the prompt.
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-NoLogo',
        '-Command',
        'chcp 65001 >$null; ' +
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
        '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; ' +
        '$OutputEncoding = [System.Text.Encoding]::UTF8; ' +
        'if (Get-Module PSReadLine) { Remove-Module PSReadLine }; ' +
        loadHelpers +
        'function prompt { $Host.UI.RawUI.WindowTitle = $PWD.Path; "XYRON " + $PWD.Path + "> " }'
      ];
    } else {
      this.helperPath = null;
      shellExecutable = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
      shellArgs = ['/K', 'chcp 65001 >nul'];
    }

    const env = Object.assign({}, process.env, {
      PYTHONIOENCODING: 'utf-8',
      LANG: 'tr_TR.UTF-8',
      LC_ALL: 'tr_TR.UTF-8',
      PROMPT: '$E]0;$P$E\\XYRON $P$G', // Branded prompt (XYRON C:\\path>) + OSC 0 WindowTitle CWD hook
      COLORTERM: 'truecolor',
      TERM: 'xterm-256color'
    });

    try {
      this.ptyProcess = pty.spawn(shellExecutable, shellArgs, {
        name: 'xterm-256color',
        cols: this.initialCols,
        rows: this.initialRows,
        cwd: this.currentCwd,
        env: env,
        useConpty: true
      });
    } catch (_err) {
      // Fallback if ConPTY initialization fails
      this.ptyProcess = pty.spawn(shellExecutable, shellArgs, {
        name: 'xterm-256color',
        cols: this.initialCols,
        rows: this.initialRows,
        cwd: this.currentCwd,
        env: env,
        useConpty: false
      });
    }

    // A fresh shell has a fresh screen: forget replay history from any previous session.
    this._outputHistory = '';

    // Update elevation daemon references
    if (this.elevationDaemon) {
      if (typeof this.elevationDaemon.setPtyProcess === 'function') {
        this.elevationDaemon.setPtyProcess(this.ptyProcess);
      }
      // /op may type commands straight into the shell only when the helper
      // functions (xcmd / xadmin / xsys) were loaded into it.
      if (typeof this.elevationDaemon.setHelpersAvailable === 'function') {
        this.elevationDaemon.setHelpersAvailable(!!this.helperPath, this.helperPath ? path.dirname(this.helperPath) : null);
      }
      if (typeof this.elevationDaemon.setCwd === 'function') {
        this.elevationDaemon.setCwd(this.currentCwd);
      }
      if (typeof this.elevationDaemon.setShellType === 'function') {
        this.elevationDaemon.setShellType(this.shellType);
      }
    }

    // Bind PTY stream listeners
    this.ptyProcess.onData((data) => {
      this._processOscBuffer(data);

      // Emit for internal / test consumers
      this.emit('data', data);
      this.emit('output', data);

      // Stream to Electron Renderer (held back until its terminal is attached)
      this._sendOutput(data);
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      // Disarm resize on exited instance immediately
      if (this.ptyProcess) {
        try {
          this.ptyProcess.resize = () => {};
          if (this.ptyProcess._agent) {
            this.ptyProcess._agent.resize = () => {};
          }
          if (Array.isArray(this.ptyProcess._deferreds)) {
            this.ptyProcess._deferreds.length = 0;
          }
        } catch (_e) {}
      }

      this.emit('exit', { exitCode, signal });
      if (this.mainWindow && !this.mainWindow.isDestroyed?.() && !this.mainWindow.webContents?.isDestroyed?.()) {
        try {
          this.mainWindow.webContents.send('terminal:exit', { exitCode, signal });
        } catch (_e) {}
      }
    });

    // Notify initial CWD state
    this.emit('cwd-change', this.currentCwd);
    if (this.mainWindow && !this.mainWindow.isDestroyed?.() && !this.mainWindow.webContents?.isDestroyed?.()) {
      try {
        this.mainWindow.webContents.send('terminal:cwd-change', this.currentCwd);
      } catch (_e) {}
    }
  }

  /**
   * Process incoming terminal data for OSC 0 / OSC 2 WindowTitle sequences.
   *
   * @param {string} data
   * @private
   */
  _processOscBuffer(data) {
    this.oscBuffer += data;
    // Intercept OSC 0 and OSC 2: \x1b]0;<TITLE>\x07 or \x1b]0;<TITLE>\x1b\
    const oscRegex = /\x1b\](?:0|2);([^\x07\x1b]+)(?:\x07|\x1b\\)/g;
    let match;
    let lastIndex = 0;

    while ((match = oscRegex.exec(this.oscBuffer)) !== null) {
      lastIndex = oscRegex.lastIndex;
      const rawTitle = match[1].trim();
      this._evaluateCwd(rawTitle);
    }

    if (lastIndex > 0) {
      this.oscBuffer = this.oscBuffer.slice(lastIndex);
    }
    // Prevent memory creep in long sessions without OSC escapes
    if (this.oscBuffer.length > 2048) {
      this.oscBuffer = this.oscBuffer.slice(-512);
    }
  }

  /**
   * Evaluate a WindowTitle string to determine if it represents a valid CWD.
   * Handles Windows case-insensitivity to avoid dropped or duplicate emissions.
   *
   * @param {string} title
   * @private
   */
  _evaluateCwd(title) {
    if (!title || typeof title !== 'string') return;
    // Filter out executable titles or command names like 'cmd.exe - chcp 65001'
    if (title.toLowerCase().endsWith('.exe') || title.includes('.exe -')) return;
    // Must begin with a Windows drive letter (e.g. C:\ or D:/)
    if (!/^[a-zA-Z]:[\\/]/.test(title)) return;

    try {
      if (fs.existsSync(title) && fs.statSync(title).isDirectory()) {
        const resolved = path.resolve(title);
        // Case-insensitive comparison for Windows filesystem
        if (resolved.toLowerCase() !== this.currentCwd.toLowerCase()) {
          this.currentCwd = resolved;
          if (this.elevationDaemon && typeof this.elevationDaemon.setCwd === 'function') {
            this.elevationDaemon.setCwd(resolved);
          }
          this.emit('cwd-change', resolved);

          if (this.mainWindow && !this.mainWindow.isDestroyed?.() && !this.mainWindow.webContents?.isDestroyed?.()) {
            try {
              this.mainWindow.webContents.send('terminal:cwd-change', resolved);
            } catch (_e) {}
          }
        }
      }
    } catch (_e) {}
  }

  /**
   * Validate if a directory path exists on the local filesystem.
   *
   * @param {string} dirPath
   * @returns {string|null}
   * @private
   */
  _resolveValidDirectory(dirPath) {
    if (!dirPath || typeof dirPath !== 'string') return null;
    try {
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        return path.resolve(dirPath);
      }
    } catch (_e) {}
    return null;
  }

  /**
   * Handle user keyboard/input stream from the renderer terminal.
   * Filters ANSI cursor escape sequences from the command buffer while passing
   * them through to the underlying PTY shell.
   *
   * @param {string} data
   */
  handleInput(data) {
    if (this._disposed || typeof data !== 'string' || !data) return;

    // 1. Delegate to explicit input interceptor if registered
    if (typeof this.inputInterceptor === 'function') {
      const consumed = this.inputInterceptor(data, this);
      if (consumed) return;
    }

    // 2. Filter ANSI cursor/control escape sequences (e.g. \x1b[A, \x1b[B, \x1b[1~, etc.)
    // to prevent bracket '[' and letter characters from polluting the elevation command buffer.
    // Bare ESC (\x1b) is preserved for buffer clearing.
    const sanitizedForDaemon = data.replace(ANSI_CURSOR_ESCAPE_REGEX, '');

    // 3. Delegate to attached elevation daemon if present and sanitized input is non-empty
    if (sanitizedForDaemon && this.elevationDaemon && typeof this.elevationDaemon.handleInput === 'function') {
      const consumed = this.elevationDaemon.handleInput(sanitizedForDaemon);
      if (consumed) return;
    }

    // 4. Normal PTY passthrough: forward the raw sequence to the child PTY shell
    if (!this._disposed && this.ptyProcess) {
      try {
        this.ptyProcess.write(data);
      } catch (_e) {}
    }
  }

  /**
   * Put a whole command line at the prompt (command palette, dropped paths).
   * Whatever the user had half-typed is erased first, so the line is never
   * glued onto it. With run=true it is executed like a typed line + Enter,
   * which means /xyron, color and /op lines are still intercepted as usual.
   *
   * @param {string} text - single line; embedded newlines become spaces
   * @param {boolean} [run=false]
   * @returns {boolean} true when something was sent
   */
  submitLine(text, run = false) {
    if (this._disposed || typeof text !== 'string') return false;
    const clean = text.replace(/[\r\n]+/g, ' ').slice(0, 8192);
    if (!clean.trim()) return false;
    if (this.elevationDaemon && typeof this.elevationDaemon.discardTypedLine === 'function') {
      this.elevationDaemon.discardTypedLine();
    }
    this.handleInput(clean);
    if (run) this.handleInput('\r');
    return true;
  }

  /**
   * Write raw data directly to the underlying PTY shell, bypassing interceptors.
   *
   * @param {string} data
   */
  writeDirect(data) {
    if (this._disposed || !this.ptyProcess || typeof data !== 'string') return;
    try {
      this.ptyProcess.write(data);
    } catch (_e) {}
  }

  /**
   * Inject text directly into the terminal viewport (used by elevation daemon).
   *
   * @param {string} text
   */
  writeToTerminal(text) {
    if (typeof text !== 'string') return;
    this.emit('data', text);
    this.emit('output', text);
    this._sendOutput(text);
  }

  /**
   * Single exit point for terminal output headed to the renderer. Always
   * records into a capped replay history; when `deferUntilRenderer` is on, the
   * renderer only receives output after it signalled `terminal:ready`, at which
   * point the whole history is replayed in order (so nothing is lost or reordered).
   *
   * @param {string} data
   * @private
   */
  _sendOutput(data) {
    this._outputHistory += data;
    if (this._outputHistory.length > MAX_OUTPUT_HISTORY) {
      this._outputHistory = this._outputHistory.slice(-MAX_OUTPUT_HISTORY);
    }
    if (this.deferUntilRenderer && !this._rendererReady) return;

    if (this.mainWindow && !this.mainWindow.isDestroyed?.() && !this.mainWindow.webContents?.isDestroyed?.()) {
      try {
        this.mainWindow.webContents.send('terminal:output', data);
      } catch (_e) {}
    }
  }

  /**
   * The renderer attached (or re-attached after a reload) a fresh terminal:
   * replay everything printed so far, then continue live.
   */
  handleRendererReady() {
    this._rendererReady = true;
    if (!this._outputHistory) return;
    if (this.mainWindow && !this.mainWindow.isDestroyed?.() && !this.mainWindow.webContents?.isDestroyed?.()) {
      try {
        this.mainWindow.webContents.send('terminal:output', this._outputHistory);
      } catch (_e) {}
    }
  }

  /**
   * Prompt redrawing helper: emits a carriage return to restore the shell prompt.
   */
  restorePrompt() {
    if (this._disposed || !this.ptyProcess) return;
    setTimeout(() => {
      try {
        if (!this._disposed && this.ptyProcess && typeof this.ptyProcess.write === 'function') {
          this.ptyProcess.write('\r');
        }
      } catch (_e) {}
    }, 50);
  }

  /**
   * Resize the virtual terminal viewport geometry.
   * Enforces boundary clamping and guards against unhandled teardown exceptions.
   *
   * @param {number} cols
   * @param {number} rows
   */
  resize(cols, rows) {
    if (this._disposed || !this.ptyProcess) return;
    const c = Math.max(10, Math.min(500, parseInt(cols, 10) || 100));
    const r = Math.max(5, Math.min(200, parseInt(rows, 10) || 30));
    try {
      if (this.ptyProcess && typeof this.ptyProcess.resize === 'function') {
        this.ptyProcess.resize(c, r);
      }
    } catch (_e) {
      // Suppress unhandled "Cannot resize a pty that has already exited" exceptions
    }
  }

  /**
   * Get the current active working directory.
   *
   * @returns {string}
   */
  getCwd() {
    return this.currentCwd;
  }

  /**
   * Synchronously set the active working directory by sending `cd` to the shell.
   * Notifies all listeners immediately and uses /d for CMD drive-switching.
   *
   * @param {string} dirPath
   * @returns {boolean}
   */
  setCwd(dirPath) {
    const valid = this._resolveValidDirectory(dirPath);
    if (!valid) return false;

    this.currentCwd = valid;
    if (this.elevationDaemon && typeof this.elevationDaemon.setCwd === 'function') {
      this.elevationDaemon.setCwd(valid);
    }

    // Immediately notify listeners and Renderer IPC of CWD change
    this.emit('cwd-change', valid);
    if (this.mainWindow && !this.mainWindow.isDestroyed?.() && !this.mainWindow.webContents?.isDestroyed?.()) {
      try {
        this.mainWindow.webContents.send('terminal:cwd-change', valid);
      } catch (_e) {}
    }

    // Write directory change to child shell (use /d for CMD multi-drive navigation)
    if (!this._disposed && this.ptyProcess) {
      try {
        const isCmd = !this.shellType.toLowerCase().includes('powershell');
        const cdCmd = isCmd ? `cd /d "${valid}"\r` : `cd "${valid}"\r`;
        this.ptyProcess.write(cdCmd);
      } catch (_e) {}
    }
    return true;
  }

  /**
   * Restart the terminal session with an optional new shell type.
   *
   * @param {string} [shellType]
   */
  restart(shellType) {
    this.init(shellType || this.shellType);
  }

  /**
   * Attach an elevation daemon instance.
   *
   * @param {Object} daemon
   */
  setElevationDaemon(daemon) {
    this.elevationDaemon = daemon;
    if (daemon && typeof daemon.attachPtyManager === 'function') {
      daemon.attachPtyManager(this);
    }
  }

  /**
   * Set a custom input interceptor callback.
   *
   * @param {Function} interceptor - (data, ptyManager) => boolean
   */
  setInputInterceptor(interceptor) {
    this.inputInterceptor = interceptor;
  }

  /**
   * Terminate child PTY process safely via Win32 process tree kill.
   * Defuses in-flight resize and socket callbacks to eliminate unhandled crashes.
   *
   * @private
   */
  _destroyInternalPty() {
    if (this.ptyProcess) {
      const proc = this.ptyProcess;
      const pid = proc.pid;
      this.ptyProcess = null;

      // Disarm resize and write on retiring instance to prevent unhandled exceptions
      try {
        proc.resize = () => {};
        proc.write = () => {};
        if (proc._agent) {
          proc._agent.resize = () => {};
        }
        if (Array.isArray(proc._deferreds)) {
          proc._deferreds.length = 0;
        }
      } catch (_e) {}

      if (pid) {
        try {
          // Forcefully kill entire process tree to prevent orphaned shells or conpty crashes
          cp.execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore', windowsHide: true });
        } catch (_e) {}
      }
    }
  }

  /**
   * Register Electron IPC handlers.
   *
   * @param {Electron.IpcMain} ipcMain
   */
  registerIpc(ipcMain) {
    if (!ipcMain || this._ipcRegistered) return;
    this._ipcRegistered = true;
    this._ipcMain = ipcMain;

    this._boundIpcHandlers['terminal:input'] = (_event, data) => {
      this.handleInput(data);
    };

    this._boundIpcHandlers['terminal:resize'] = (_event, payload) => {
      if (payload && typeof payload.cols === 'number' && typeof payload.rows === 'number') {
        this.resize(payload.cols, payload.rows);
      }
    };

    this._boundIpcHandlers['terminal:write'] = (_event, text) => {
      this.writeDirect(text);
    };

    this._boundIpcHandlers['terminal:ready'] = () => {
      this.handleRendererReady();
    };

    ipcMain.on('terminal:input', this._boundIpcHandlers['terminal:input']);
    ipcMain.on('terminal:resize', this._boundIpcHandlers['terminal:resize']);
    ipcMain.on('terminal:write', this._boundIpcHandlers['terminal:write']);
    ipcMain.on('terminal:ready', this._boundIpcHandlers['terminal:ready']);

    this._boundIpcHandlers['terminal:submit'] = (_event, payload) => {
      if (payload && typeof payload.text === 'string') this.submitLine(payload.text, payload.run === true);
    };
    ipcMain.on('terminal:submit', this._boundIpcHandlers['terminal:submit']);

    ipcMain.handle('terminal:cwd-get', async () => {
      return this.getCwd();
    });

    ipcMain.handle('terminal:set-cwd', async (_event, dirPath) => {
      return this.setCwd(dirPath);
    });

    ipcMain.handle('terminal:restart', async (_event, shellType) => {
      this.restart(shellType);
      return { success: true, cwd: this.getCwd(), shellType: this.shellType };
    });

    if (this.elevationDaemon && typeof this.elevationDaemon.registerIpc === 'function') {
      this.elevationDaemon.registerIpc(ipcMain);
    }
  }

  /**
   * Unregister Electron IPC handlers.
   *
   * @param {Electron.IpcMain} [ipcMain]
   */
  unregisterIpc(ipcMain) {
    const targetIpc = ipcMain || this._ipcMain;
    if (!targetIpc || !this._ipcRegistered) return;
    this._ipcRegistered = false;

    try {
      if (this._boundIpcHandlers['terminal:input']) {
        targetIpc.removeListener('terminal:input', this._boundIpcHandlers['terminal:input']);
      }
      if (this._boundIpcHandlers['terminal:resize']) {
        targetIpc.removeListener('terminal:resize', this._boundIpcHandlers['terminal:resize']);
      }
      if (this._boundIpcHandlers['terminal:write']) {
        targetIpc.removeListener('terminal:write', this._boundIpcHandlers['terminal:write']);
      }
      if (this._boundIpcHandlers['terminal:ready']) {
        targetIpc.removeListener('terminal:ready', this._boundIpcHandlers['terminal:ready']);
      }
      if (this._boundIpcHandlers['terminal:submit']) {
        targetIpc.removeListener('terminal:submit', this._boundIpcHandlers['terminal:submit']);
      }

      if (typeof targetIpc.removeHandler === 'function') {
        targetIpc.removeHandler('terminal:cwd-get');
        targetIpc.removeHandler('terminal:set-cwd');
        targetIpc.removeHandler('terminal:restart');
      }
    } catch (_e) {}

    this._boundIpcHandlers = {};

    if (this.elevationDaemon && typeof this.elevationDaemon.unregisterIpc === 'function') {
      try {
        this.elevationDaemon.unregisterIpc(targetIpc);
      } catch (_e) {}
    }

    this._ipcMain = null;
  }

  /**
   * Full teardown of the manager and child processes.
   * Guarantees IPC unregistration, PTY tree termination, and listener cleanup.
   *
   * @param {Electron.IpcMain} [ipcMain]
   */
  destroy(ipcMain) {
    this._disposed = true;

    // Cleanly unregister IPC handlers to prevent memory leaks or duplicate handler errors
    if (this._ipcRegistered || ipcMain || this._ipcMain) {
      this.unregisterIpc(ipcMain || this._ipcMain);
    }

    this._destroyInternalPty();

    if (this.elevationDaemon && typeof this.elevationDaemon.destroy === 'function') {
      this.elevationDaemon.destroy();
    }

    this.removeAllListeners();
  }
}

module.exports = PtyManager;
