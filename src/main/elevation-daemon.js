/**
 * XYRON CENTER - In-Terminal /op Privilege Elevation Engine
 * Module: 2_Proje_Dosyalari_Source/src/main/elevation-daemon.js
 * 
 * Features:
 * - In-terminal command line buffer and parser (/op whoami, /op-unlock, /op-lock, /op <cmd>)
 * - Dynamic token identity inspection (whoami, whoami /user, whoami /groups, fltmc) with zero mock data
 * - Headless sub-command execution via exec with { windowsHide: true } and real-time streaming
 * - Effective persistent elevated mode (/op-unlock & /op-lock) executing commands elevated
 * - Process tree tracking with taskkill /F /PID /T cleanup on Ctrl+C and shutdown
 * - Clean Electron IPC registration and teardown without memory leaks
 * - Decoupled architecture supporting Electron BrowserWindow, attached PtyManager, and headless testing
 */

const { EventEmitter } = require('events');
const { exec, execFile, execSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Syntax-based shell router (resolve whether running from src/main or a test folder)
let routeCommand;
try {
  ({ routeCommand } = require('./shell-router'));
} catch (_e) {
  ({ routeCommand } = require('../../../2_Proje_Dosyalari_Source/src/main/shell-router'));
}

// ANSI message -> records printed by the in-shell `xmsg` helper
let buildMessageRecords;
try {
  ({ buildMessageRecords } = require('./shell-helpers'));
} catch (_e) {
  ({ buildMessageRecords } = require('../../../2_Proje_Dosyalari_Source/src/main/shell-helpers'));
}

// CMD-style `color` command parser (drives the live interface theme)
let isColorCommand, parseColorCommand, describePalette, DEFAULT_THEME;
try {
  ({ isColorCommand, parseColorCommand, describePalette, DEFAULT_THEME } = require('./color-command'));
} catch (_e) {
  ({ isColorCommand, parseColorCommand, describePalette, DEFAULT_THEME } =
    require('../../../2_Proje_Dosyalari_Source/src/main/color-command'));
}

/**
 * Absolute path of a System32 tool, so a same-named program earlier on PATH
 * (Git's coreutils whoami, for example) is never picked up on other PCs.
 * @param {string} name - exe name without extension
 * @param {boolean} [quoted=true] - wrap in quotes for use inside a shell string
 * @returns {string}
 */
function sysTool(name, quoted = true) {
  const full = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name + '.exe');
  const resolved = fs.existsSync(full) ? full : name;
  return quoted && resolved.includes(' ') ? `"${resolved}"` : resolved;
}

class ElevationDaemon extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {Electron.BrowserWindow} [options.mainWindow] - Electron BrowserWindow instance
   * @param {Object} [options.ptyProcess] - Active node-pty terminal instance
   * @param {string} [options.cwd] - Current working directory
   * @param {Function} [options.onOutput] - Callback for terminal output streaming (text: string)
   * @param {Function} [options.onStatus] - Callback for OP status updates ({ unlocked, identity })
   * @param {Function} [options.onRestorePrompt] - Callback to restore shell prompt
   * @param {string} [options.identity] - Override identity string (e.g. for testing)
   */
  constructor(options = {}) {
    super();

    this.mainWindow = options.mainWindow || null;
    this.ptyProcess = options.ptyProcess || null;
    this.ptyManager = null;
    this.cwd = options.cwd || process.env.USERPROFILE || process.cwd();
    this.isUnlocked = false;
    this.inputBuffer = '';
    this.overrideIdentity = options.identity || null;

    // sudo-style ergonomics: `/op !!` repeats the last /op command, and the
    // persistent unlock expires on its own like sudo's credential cache.
    this.lastOp = null; // { mode: 'op' | 'system', cmd: string }
    this.unlockTtlMs = Number.isFinite(options.unlockTtlMs) ? options.unlockTtlMs : 15 * 60 * 1000;
    this.unlockExpiresAt = null;
    this._lockTimer = null;

    // Active shell flavor for /op execution ('powershell' | 'cmd'). PowerShell is the
    // superset host: it runs native executables, PowerShell cmdlets AND the common CMD
    // aliases, so /op works for both command worlds out of the box.
    this.shellType = options.shellType || 'powershell';

    // Optional persistent config store, enabling in-terminal `/xyron` customization.
    this.configStore = options.configStore || null;

    // Whether this process is already elevated. When provided (the app resolves it
    // once at startup) the status badge never has to spawn processes to find out.
    this.elevated = typeof options.elevated === 'boolean' ? options.elevated : undefined;

    // Opt-in: run /op commands by typing them into the real shell (output flows
    // through ConPTY and stays in sync) instead of injecting captured output.
    // Only effective once the shell reports its helper functions are loaded.
    this.passThrough = options.passThrough === true;
    this._helpersAvailable = false;

    // Callbacks for headless testability
    this.outputHandler = options.onOutput || null;
    this.statusHandler = options.onStatus || null;
    this.promptRestorer = options.onRestorePrompt || null;

    // Set of active child processes for tree termination
    this.activeProcesses = new Set();
    this._ipcRegistered = false;
    this._boundIpcHandlers = {};
    this._ipcMain = null;

    // Cached token identity to avoid repeated execSync on keystrokes
    this._cachedToken = null;
  }

  /**
   * Bind active node-pty process instance.
   * @param {Object} ptyProcess
   */
  setPtyProcess(ptyProcess) {
    this.ptyProcess = ptyProcess;
  }

  /**
   * Tell the daemon whether the shell has the xcmd / xadmin / xsys helpers loaded.
   * @param {boolean} available
   */
  setHelpersAvailable(available, helperDir) {
    this._helpersAvailable = !!available;
    this._helperDir = available && typeof helperDir === 'string' ? helperDir : null;
  }

  /**
   * True when informational messages (/op usage, whoami, /xyron, color hints)
   * should be printed by the shell itself via `xmsg` instead of being injected
   * into the view. Injected text bypasses ConPTY, which then still thinks the
   * cursor sits on the old prompt line and draws later output on top of it.
   * @returns {boolean}
   * @private
   */
  _shellMessagesActive() {
    return this._shellPassThroughActive() && !!this._helperDir;
  }

  /**
   * Start collecting writeToTerminal output for one intercepted command line.
   * @param {string} typed
   * @private
   */
  _beginMessageCapture(typed) {
    this._msgCapture = this._shellMessagesActive() ? { typed, chunks: [] } : null;
  }

  /**
   * Finish a capture: print what was collected through the shell, or nothing
   * when the command was silent.
   * @private
   */
  _endMessageCapture() {
    if (!this._msgCapture) return;
    if (this._msgCapture.chunks.length) this._flushShellMessage();
    else this._msgCapture = null;
  }

  /**
   * Hand the captured message to the shell: write the records file and type
   * `xmsg <id>`. Falls back to direct injection if the file cannot be written.
   * @private
   */
  _flushShellMessage() {
    const cap = this._msgCapture;
    this._msgCapture = null;
    if (!cap) return;
    const text = cap.chunks.join('');
    this._msgSeq = ((this._msgSeq || 0) + 1) % 1000000;
    const id = `${process.pid % 10000}${this._msgSeq}`;
    try {
      const file = path.join(this._helperDir, `xyron-msg-${id}.txt`);
      fs.writeFileSync(file, buildMessageRecords(cap.typed, text).join('\n'), 'utf8');
      this._typeIntoShell(`xmsg ${id}`);
    } catch (_e) {
      this.writeToTerminal(text);
      this.restorePrompt();
    }
  }

  /**
   * Erase what the user typed on the shell's input line, without running it.
   * A bare ESC was used for this, but through ConPTY a lone ESC does not clear
   * the cooked-mode line, so "/op" stayed in the shell and got glued to the
   * next thing typed. End + one Backspace per typed character is reliable.
   * @private
   */
  _clearShellLine() {
    if (!this.ptyProcess || typeof this.ptyProcess.write !== 'function') return;
    const n = Math.max(0, this._lastLineLength || 0);
    this._lastLineLength = 0;
    if (!n) return;
    try {
      this.ptyProcess.write('\x1b[F' + '\x7f'.repeat(n));
    } catch (_e) {}
  }

  /**
   * Forget the half-typed line and erase it from the shell's input line.
   * Used before the app puts a whole line at the prompt (command palette).
   */
  discardTypedLine() {
    this._lastLineLength = Array.from(this.inputBuffer || '').length;
    this.inputBuffer = '';
    this._clearShellLine();
  }

  /**
   * Whether pressing Enter on this line will be handled by the daemon
   * (mirrors the branches of _handleSingleInput for '\r').
   * @param {string} line - trimmed line
   * @returns {boolean}
   * @private
   */
  _wouldInterceptLine(line) {
    if (this.isOpCommand(line) || this.isXyronCommand(line) || isColorCommand(line) || this.isShellRouteCommand(line)) {
      return true;
    }
    if (this.isUnlocked && line.length > 0) {
      return !(
        this._shellPassThroughActive() &&
        this.elevated === true &&
        routeCommand(line, { default: this.shellType }).shell === 'powershell'
      );
    }
    return false;
  }

  /**
   * True when /op commands should be typed straight into the live shell.
   * @returns {boolean}
   * @private
   */
  _shellPassThroughActive() {
    return (
      this.passThrough &&
      this._helpersAvailable &&
      this.shellType === 'powershell' &&
      !!this.ptyProcess &&
      typeof this.ptyProcess.write === 'function'
    );
  }

  /**
   * Build the single line to type into the PowerShell host for a routed command.
   *  - already admin + PowerShell syntax -> the command itself (no wrapper at all)
   *  - already admin + CMD syntax        -> xcmd '<line>'   (raw to cmd.exe)
   *  - not admin                         -> xadmin ps|cmd '<line>' (one UAC prompt)
   *
   * @param {string} targetCmd
   * @returns {string}
   * @private
   */
  _buildShellLine(targetCmd) {
    const route = routeCommand(targetCmd, { default: this.shellType });
    const cmd = route.command || targetCmd;
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

    if (this.elevated === false) {
      return `xadmin ${route.shell === 'cmd' ? 'cmd' : 'ps'} ${q(cmd)}`;
    }
    return route.shell === 'cmd' ? `xcmd ${q(cmd)}` : cmd;
  }

  /**
   * Mark a shell line as launched through /op: appends a PowerShell comment
   * ("  # (op)") so the echoed prompt line shows it, without changing what runs.
   * A line ending in a backtick (line continuation) is left untouched, because
   * the comment would be swallowed into the next line.
   *
   * @param {string} line
   * @param {string} [tag]
   * @returns {string}
   * @private
   */
  _tagShellLine(line, tag) {
    const clean = String(line).replace(/\s+$/, '');
    if (!tag || clean.endsWith('`')) return clean;
    return `${clean}  # (${tag})`;
  }

  /**
   * Type a command line into the live shell (as if the user entered it).
   * @param {string} line
   * @private
   */
  _typeIntoShell(line) {
    if (!this.ptyProcess || typeof this.ptyProcess.write !== 'function') return;
    try {
      this.ptyProcess.write(line + '\r');
    } catch (_e) {}
  }

  /**
   * Attach owning PtyManager instance.
   * @param {Object} ptyManager
   */
  attachPtyManager(ptyManager) {
    this.ptyManager = ptyManager;
    if (ptyManager.ptyProcess) {
      this.setPtyProcess(ptyManager.ptyProcess);
    }
    if (ptyManager.currentCwd) {
      this.setCwd(ptyManager.currentCwd);
    }
    if (ptyManager.mainWindow && !this.mainWindow) {
      this.mainWindow = ptyManager.mainWindow;
    }
    if (ptyManager.shellType) {
      this.setShellType(ptyManager.shellType);
    }
  }

  /**
   * Update the active shell flavor used for /op command execution.
   * @param {string} shellType - 'powershell' or 'cmd'
   */
  setShellType(shellType) {
    if (shellType && typeof shellType === 'string') {
      this.shellType = shellType.toLowerCase().includes('cmd') ? 'cmd' : 'powershell';
    }
  }

  /**
   * Update active working directory.
   * @param {string} cwd
   */
  setCwd(cwd) {
    if (cwd && typeof cwd === 'string') {
      this.cwd = cwd.trim();
    }
  }

  /**
   * Set Electron BrowserWindow instance.
   * @param {Electron.BrowserWindow} mainWindow
   */
  setMainWindow(mainWindow) {
    this.mainWindow = mainWindow;
  }

  /**
   * Write formatted data directly to xterm terminal stream.
   * @param {string} data
   */
  writeToTerminal(data) {
    if (!data) return;
    if (this._msgCapture) {
      this._msgCapture.chunks.push(data);
      return;
    }
    this.emit('output', data);

    if (typeof this.outputHandler === 'function') {
      try {
        this.outputHandler(data);
      } catch (_e) {}
    }

    if (this.ptyManager && typeof this.ptyManager.writeToTerminal === 'function') {
      this.ptyManager.writeToTerminal(data);
    } else if (this.mainWindow && !this.mainWindow.isDestroyed?.() && !this.mainWindow.webContents?.isDestroyed?.()) {
      try {
        this.mainWindow.webContents.send('terminal:output', data);
      } catch (_e) {}
    }
  }

  /**
   * Broadcast op:status update to Renderer HUD and listeners.
   */
  /**
   * Current privilege status. The (slow, process-spawning) token lookup only
   * happens when it is actually needed: the identity is shown while unlocked,
   * and elevation is read from the startup flag when the app supplied it.
   *
   * @returns {{ unlocked: boolean, elevated: boolean, identity: string }}
   */
  _buildStatus() {
    const needsToken = this.isUnlocked || typeof this.elevated !== 'boolean';
    const token = needsToken ? this.resolveTokenIdentity() : null;
    return {
      unlocked: this.isUnlocked,
      elevated: typeof this.elevated === 'boolean' ? this.elevated : !!(token && token.isElevated),
      identity: this.isUnlocked && token ? token.identity : 'STANDARD',
      expiresAt: this.isUnlocked ? this.unlockExpiresAt : null
    };
  }

  broadcastStatus() {
    const status = this._buildStatus();

    this.emit('status', status);

    if (typeof this.statusHandler === 'function') {
      try {
        this.statusHandler(status);
      } catch (_e) {}
    }

    if (this.mainWindow && !this.mainWindow.isDestroyed?.() && !this.mainWindow.webContents?.isDestroyed?.()) {
      try {
        this.mainWindow.webContents.send('op:status', status);
      } catch (_e) {}
    }
  }

  /**
   * Redraw shell prompt at current CWD.
   */
  restorePrompt() {
    // A captured message is printed by the shell, which draws its own prompt.
    if (this._msgCapture) {
      this._flushShellMessage();
      return;
    }
    if (typeof this.promptRestorer === 'function') {
      try {
        this.promptRestorer();
        return;
      } catch (_e) {}
    }

    if (this.ptyManager && typeof this.ptyManager.restorePrompt === 'function') {
      this.ptyManager.restorePrompt();
      return;
    }

    if (this.ptyProcess && typeof this.ptyProcess.write === 'function') {
      setTimeout(() => {
        try {
          if (this.ptyProcess) {
            this.ptyProcess.write('\r');
          }
        } catch (_e) {}
      }, 50);
    }
  }

  /**
   * Resolve elevated token identity details dynamically from Windows OS.
   * Zero mock data: dynamically inspects fltmc elevation, whoami username, whoami /user SID, and whoami /groups mandatory integrity.
   * Results are cached to avoid repeated process execution.
   * 
   * @param {boolean} [forceRefresh=false]
   * @returns {{ identity: string, sid: string, mandatoryLevel: string, isElevated: boolean }}
   */
  resolveTokenIdentity(forceRefresh = false) {
    if (this.overrideIdentity) {
      const isSys = this.overrideIdentity.toLowerCase().includes('system');
      return {
        identity: this.overrideIdentity,
        sid: this._cachedToken && this._cachedToken.sid ? this._cachedToken.sid : (isSys ? 'S-1-5-18' : 'S-1-5-32-544'),
        mandatoryLevel: isSys ? 'S-1-16-16384 (System)' : 'S-1-16-12288 (High)',
        isElevated: true
      };
    }

    if (this._cachedToken && !forceRefresh) {
      return this._cachedToken;
    }

    // 1. Authentically test elevation via fltmc (standard Win32 elevation probe)
    let isElevated = false;
    try {
      execSync(sysTool('fltmc'), { stdio: 'ignore', windowsHide: true });
      isElevated = true;
    } catch (_e) {
      isElevated = false;
    }

    // 2. Query authentic username
    let username = '';
    try {
      username = execSync(sysTool('whoami'), { encoding: 'utf8', windowsHide: true }).trim();
    } catch (_e) {
      username = process.env.USERNAME
        ? (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME)
        : '';
    }

    // 3. Query authentic user SID via CSV format
    let userSid = '';
    try {
      const userCsv = execSync(sysTool('whoami') + ' /user /fo csv /nh', { encoding: 'utf8', windowsHide: true }).trim();
      const match = userCsv.match(/"([^"]+)"\s*,\s*"([^"]+)"/);
      if (match) {
        userSid = match[2];
        if (!username) username = match[1];
      } else {
        const parts = userCsv.split(',').map(s => s.replace(/^"|"$/g, '').trim());
        if (parts.length >= 2) userSid = parts[1];
      }
    } catch (_e) {}

    // 4. Query authentic token integrity level via group SIDs
    let mandatoryLevel = 'S-1-16-8192 (Medium)';
    let integritySid = 'S-1-16-8192';
    try {
      const groupsOutput = execSync(sysTool('whoami') + ' /groups', { encoding: 'utf8', windowsHide: true });
      if (groupsOutput.includes('S-1-16-16384')) {
        integritySid = 'S-1-16-16384';
        mandatoryLevel = 'S-1-16-16384 (System)';
      } else if (groupsOutput.includes('S-1-16-12288')) {
        integritySid = 'S-1-16-12288';
        mandatoryLevel = 'S-1-16-12288 (High)';
      } else if (groupsOutput.includes('S-1-16-8192')) {
        integritySid = 'S-1-16-8192';
        mandatoryLevel = 'S-1-16-8192 (Medium)';
      } else if (groupsOutput.includes('S-1-16-4096')) {
        integritySid = 'S-1-16-4096';
        mandatoryLevel = 'S-1-16-4096 (Low)';
      } else if (groupsOutput.includes('S-1-16-0')) {
        integritySid = 'S-1-16-0';
        mandatoryLevel = 'S-1-16-0 (Untrusted)';
      }
    } catch (_e) {}

    // 5. Derive genuine identity representation without hardcoded fallbacks
    let identity = username || 'UNKNOWN';
    if (integritySid === 'S-1-16-16384' || username.toUpperCase() === 'SYSTEM' || username.toUpperCase() === 'NT AUTHORITY\\SYSTEM') {
      identity = 'NT AUTHORITY\\SYSTEM';
      isElevated = true;
    } else if (isElevated || integritySid === 'S-1-16-12288') {
      identity = username ? `${username} (Elevated Administrator)` : 'Elevated Administrator';
      isElevated = true;
    }

    this._cachedToken = {
      identity,
      sid: userSid || (isElevated && integritySid === 'S-1-16-16384' ? 'S-1-5-18' : 'UNKNOWN'),
      mandatoryLevel,
      isElevated
    };

    return this._cachedToken;
  }

  /**
   * Check if a given command line matches /op syntax.
   * Handles arbitrary whitespace (/op     whoami, /op    ).
   * 
   * @param {string} line
   * @returns {boolean}
   */
  isOpCommand(line) {
    if (!line || typeof line !== 'string') return false;
    const trimmed = this._normalizeSudoAlias(line.trim());
    const normalized = trimmed.replace(/\s+/g, ' ');
    return (
      normalized === '/op-unlock' ||
      /^\/op-unlock \d{1,4}$/.test(normalized) ||
      normalized === '/op-lock' ||
      normalized === '/op whoami' ||
      normalized === '/op' ||
      normalized === '/op-system' ||
      normalized.startsWith('/op ') ||
      normalized.startsWith('/op-system ')
    );
  }

  /**
   * Treat `/sudo` as a friendly alias for `/op` (Linux-style ergonomics).
   * `/sudo <cmd>` -> `/op <cmd>`, bare `/sudo` -> `/op`.
   * @param {string} line
   * @returns {string}
   * @private
   */
  _normalizeSudoAlias(line) {
    if (/^\/sudo\b/i.test(line)) {
      return line.replace(/^\/sudo\b/i, '/op');
    }
    return line;
  }

  /**
   * In-terminal input keystroke interceptor.
   * Call from PtyManager.handleInput(data).
   * 
   * @param {string} data - Raw input string/chunk from terminal
   * @returns {boolean} - Returns true if intercepted and handled; false if passed to shell
   */
  handleInput(data) {
    if (!data || typeof data !== 'string') return false;

    // 1. Single ESC (\x1b) or Ctrl+U (\x15) clears typed input buffer
    if (data === '\x1b' || data === '\x15') {
      this.inputBuffer = '';
      return false; // Passthrough to underlying shell
    }

    // 2. Reject multi-byte ANSI / VT escape control sequences (arrow keys, function keys, cursor jumps)
    // from polluting inputBuffer with trailing characters like "[A" or "[B"
    if (data.startsWith('\x1b')) {
      return false; // Passthrough to underlying shell without polluting buffer
    }

    // 3. Handle multi-character strings (pasted text, buffered command strings, CRLF chunks)
    // A chunk holding an intercepted line (e.g. a paste "dir\r/op\recho x\r")
    // used to be swallowed whole, so the other lines never reached the shell.
    // Now the daemon forwards the non-intercepted parts itself, in order.
    if (data.length > 1) {
      const canForward = !!(this.ptyProcess && typeof this.ptyProcess.write === 'function');
      let interceptedAny = false;
      let pending = '';   // already-complete text not yet sent to the shell
      let lineChars = ''; // characters of the line being typed in this chunk
      const flushPending = () => {
        if (pending && canForward) {
          try { this.ptyProcess.write(pending); } catch (_e) {}
        }
        pending = '';
      };
      for (let i = 0; i < data.length; i++) {
        let char = data[i];
        if (char === '\r' && data[i + 1] === '\n') i++; // CRLF counts as one Enter
        if (char === '\n') char = '\r';

        const willIntercept = char === '\r'
          ? this._wouldInterceptLine(this.inputBuffer.trim())
          : (char === '\x03' && this.activeProcesses.size > 0);

        if (willIntercept) {
          interceptedAny = true;
          flushPending();   // earlier lines first, so order is preserved
          // Characters of this line that came in this chunk never reached the shell.
          this._unsentChars = Array.from(lineChars).length;
          lineChars = '';
          try { this._handleSingleInput(char); } finally { this._unsentChars = 0; }
          continue;
        }

        this._handleSingleInput(char);
        lineChars += char;
        if (char === '\r') {
          pending += lineChars;
          lineChars = '';
        }
      }
      if (!interceptedAny) return false; // caller forwards the raw chunk unchanged
      pending += lineChars;
      flushPending();
      return true;
    }

    return this._handleSingleInput(data);
  }

  /**
   * Internal processor for single input character or signal.
   * @param {string} data
   * @returns {boolean}
   * @private
   */
  _handleSingleInput(data) {
    // 1. Handle Enter (\r or \n)
    if (data === '\r' || data === '\n') {
      // Only characters the shell really received can be erased there.
      this._lastLineLength = Math.max(0, Array.from(this.inputBuffer).length - (this._unsentChars || 0));
      const line = this.inputBuffer.trim();
      this.inputBuffer = '';

      if (this.isOpCommand(line)) {
        // Silently clear typed characters from ConPTY shell buffer
        this._clearShellLine();

        // Informational /op commands print through the shell; /op <cmd> types
        // its command into the shell itself and must not be captured.
        if (!this._opRunsInShell(line)) this._beginMessageCapture(line);
        try {
          this.executeOpCommand(line);
        } finally {
          this._endMessageCapture();
        }
        return true; // Intercepted: do NOT forward \r to shell
      }

      if (this.isXyronCommand(line)) {
        // Silently clear typed characters from the shell line buffer
        this._clearShellLine();
        this._beginMessageCapture(line);
        try {
          this.writeToTerminal('\r\n');
          this.executeXyronCommand(line);
          this.restorePrompt();
        } finally {
          this._endMessageCapture();
        }
        return true; // Intercepted
      }

      // CMD-style `color a` / `color f0` / `color` recolors the whole interface.
      // Silent on success: just clear the typed line, no output is injected.
      if (isColorCommand(line)) {
        this._clearShellLine();
        this._beginMessageCapture(line);
        try {
          this.executeColorCommand(line);
        } finally {
          this._endMessageCapture();
        }
        return true; // Intercepted: do NOT forward \r to shell
      }

      // Explicit shell-route prefixes (/cmd ..., /ps ...) run one-shot through the
      // routed shell regardless of elevation lock state.
      if (this.isShellRouteCommand(line)) {
        this._clearShellLine();
        // Typed straight into the shell -> no injected newline (it would desync ConPTY).
        if (!this._shellPassThroughActive()) this.writeToTerminal('\r\n');
        this.executeSubCommand(line);
        return true; // Intercepted
      }

      // If persistent elevated mode is unlocked, execute standard commands under elevated executor
      if (this.isUnlocked && line.length > 0) {
        // Elevated app + PowerShell-syntax command: the shell already does exactly
        // the right thing, so just let the Enter key through (zero rewriting).
        if (
          this._shellPassThroughActive() &&
          this.elevated === true &&
          routeCommand(line, { default: this.shellType }).shell === 'powershell'
        ) {
          return false;
        }

        this._clearShellLine();

        if (!this._shellPassThroughActive()) this.writeToTerminal('\r\n');
        this.executeSubCommand(line);
        return true; // Intercepted: executed with elevated privileges
      }

      return false; // Passthrough to shell
    }

    // 2. Handle Backspace (\x7f or \b)
    if (data === '\x7f' || data === '\b') {
      if (this.inputBuffer.length > 0) {
        this.inputBuffer = this.inputBuffer.slice(0, -1);
      }
      return false; // Let shell handle visual character erasure
    }

    // 3. Handle Ctrl+C (\x03)
    if (data === '\x03') {
      this.inputBuffer = '';

      // If an OP sub-process is running, kill it
      if (this.activeProcesses.size > 0) {
        this.terminateActiveProcesses();
        this.writeToTerminal('\r\n\x1b[31m[Interrupted by User (^C)]\x1b[0m\r\n');
        this.restorePrompt();
        return true;
      }

      return false; // Let shell handle standard ^C
    }

    // 4. Handle Ctrl+U (\x15) or Escape (\x1b)
    if (data === '\x15' || data === '\x1b') {
      this.inputBuffer = '';
      return false;
    }

    // 5. Ignore ANSI escape control sequences
    if (data.startsWith('\x1b')) {
      return false;
    }

    // 6. Accumulate printable characters (including Turkish UTF-8)
    this.inputBuffer += data;
    return false;
  }

  /**
   * True when this /op line types a real command into the shell (its output
   * then flows through ConPTY on its own), as opposed to an informational one.
   * @param {string} line
   * @returns {boolean}
   * @private
   */
  _opRunsInShell(line) {
    const normalized = this._normalizeSudoAlias(String(line || '').trim()).replace(/\s+/g, ' ');
    // whoami / status print information; `/op !!` with nothing to repeat too.
    return this._shellPassThroughActive() &&
      /^(\/op\s+(?!(whoami|status)\s*$)\S|\/op-system\s+\S)/i.test(normalized) &&
      !(normalized === '/op !!' && !this.lastOp);
  }

  /**
   * Execute intercepted /op command.
   * Normalizes whitespace so /op     whoami routes properly.
   * 
   * @param {string} line
   */
  executeOpCommand(line) {
    const trimmed = this._normalizeSudoAlias(line.trim());
    const normalized = trimmed.replace(/\s+/g, ' ');

    // Commands typed into the real shell print their own output; injecting a
    // newline first would desync ConPTY. Informational commands (whoami, usage,
    // lock/unlock) still inject their text, so they keep the leading newline.
    if (!this._opRunsInShell(line)) this.writeToTerminal('\r\n');

    // sudo's "!!": repeat the last /op or /op-system command.
    if (normalized === '/op !!') {
      if (!this.lastOp) {
        this.writeToTerminal('\x1b[33m[OP] Tekrarlanacak onceki komut yok.\x1b[0m\r\n');
        this.restorePrompt();
        return;
      }
      const { mode, cmd } = this.lastOp;
      if (mode === 'system') this.executeAsSystem(cmd);
      else this.executeSubCommand(cmd, undefined, { tag: 'op' });
      return;
    }

    // /op status -> one-screen summary of the privilege state.
    if (normalized === '/op status') {
      this.showStatus();
      return;
    }

    // /op-unlock <minutes> -> timed unlock (0 = until /op-lock).
    const timedUnlock = normalized.match(/^\/op-unlock (\d{1,4})$/);
    if (timedUnlock) {
      this.unlock(Number(timedUnlock[1]) * 60 * 1000);
      return;
    }

    // 0. /op-system <command> -> run with full NT AUTHORITY\SYSTEM authority
    if (normalized === '/op-system') {
      this.writeToTerminal(
        '\x1b[1;35m[OP SYSTEM]\x1b[0m Kullanim: /op-system <komut>  ' +
        '\x1b[90m(komutu NT AUTHORITY\\SYSTEM yetkisiyle calistirir)\x1b[0m\r\n'
      );
      this.restorePrompt();
      return;
    }
    if (normalized.startsWith('/op-system ')) {
      const sysCmd = trimmed.replace(/^\/op-system\s+/, '').trim();
      if (!sysCmd) { this.showUsage(); return; }
      this.lastOp = { mode: 'system', cmd: sysCmd };
      this.executeAsSystem(sysCmd);
      return;
    }

    // 1. /op-unlock
    if (normalized === '/op-unlock') {
      this.unlock();
      return;
    }

    // 2. /op-lock
    if (normalized === '/op-lock') {
      this.lock();
      return;
    }

    // 3. /op whoami (including multiple spaces like "/op     whoami")
    if (normalized === '/op whoami') {
      this.handleWhoami();
      return;
    }

    // 4. /op (Usage help, including trailing whitespace like "/op   ")
    if (normalized === '/op') {
      this.showUsage();
      return;
    }

    // 5. /op <subcommand>
    if (normalized.startsWith('/op ')) {
      const targetCmd = trimmed.replace(/^\/op\s+/, '').trim();
      if (!targetCmd) {
        this.showUsage();
        return;
      }
      this.lastOp = { mode: 'op', cmd: targetCmd };
      this.executeSubCommand(targetCmd, undefined, { tag: 'op' });
    }
  }

  /**
   * Enable persistent elevated OP mode. Like sudo's credential cache it expires
   * on its own (default 15 min); 0 means "until /op-lock".
   *
   * The expiry is silent on purpose: printing at a random moment would have to
   * type into the shell while the user may be typing or a command may be
   * running. The header badge drops the "OP" mark and /op status shows it.
   *
   * @param {number} [ttlMs] - lifetime in ms; omitted -> this.unlockTtlMs
   */
  unlock(ttlMs) {
    this.isUnlocked = true;
    this._clearLockTimer();
    const ttl = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : this.unlockTtlMs;
    if (ttl > 0) {
      this.unlockExpiresAt = Date.now() + ttl;
      this._lockTimer = setTimeout(() => {
        this._lockTimer = null;
        if (!this.isUnlocked) return;
        this.isUnlocked = false;
        this.unlockExpiresAt = null;
        this.broadcastStatus();
      }, ttl);
      if (typeof this._lockTimer.unref === 'function') this._lockTimer.unref();
    }
    const token = this.resolveTokenIdentity();
    const expiry = ttl > 0
      ? `Auto-lock in ${Math.max(1, Math.round(ttl / 60000))} min (change: /op-unlock <minutes>, 0 = never)\r\n`
      : 'No auto-lock (use /op-lock to end)\r\n';
    this.writeToTerminal(
      '\x1b[1;31m' +
      '====================================================================\r\n' +
      '[OP ENGINE] ELEVATED PRIVILEGE MODE: UNLOCKED\r\n' +
      'Active Security Context: ' + token.identity + '\r\n' +
      'Mandatory Integrity: ' + token.mandatoryLevel + '\r\n' +
      expiry +
      'All subsequent commands execute with unrestricted administrative rights.\r\n' +
      '====================================================================\x1b[0m\r\n'
    );
    this.broadcastStatus();
    this.restorePrompt();
  }

  /**
   * Disable persistent elevated OP mode.
   */
  lock() {
    this.isUnlocked = false;
    this._clearLockTimer();
    this.writeToTerminal(
      '\x1b[1;36m' +
      '====================================================================\r\n' +
      '[OP ENGINE] ELEVATED PRIVILEGE MODE: LOCKED\r\n' +
      'Standard User Security Context Restored.\r\n' +
      '====================================================================\x1b[0m\r\n'
    );
    this.broadcastStatus();
    this.restorePrompt();
  }

  /** @private */
  _clearLockTimer() {
    if (this._lockTimer) clearTimeout(this._lockTimer);
    this._lockTimer = null;
    this.unlockExpiresAt = null;
  }

  /**
   * Compact summary of the privilege state (/op status).
   */
  showStatus() {
    const token = this.resolveTokenIdentity();
    const left = this.unlockExpiresAt
      ? Math.max(0, Math.ceil((this.unlockExpiresAt - Date.now()) / 60000)) + ' dk'
      : (this.isUnlocked ? 'yok (kalici)' : '-');
    const mode = this.isUnlocked ? 'ACIK' : 'kapali';
    const appLevel = this.elevated === true ? 'yonetici'
      : (this.elevated === false ? 'sinirli (UAC gerekir)' : 'bilinmiyor');
    const last = this.lastOp
      ? `${this.lastOp.mode === 'system' ? '/op-system' : '/op'} ${this.lastOp.cmd}`
      : '-';
    this.writeToTerminal(
      '\x1b[1;36m[OP STATUS]\x1b[0m\r\n' +
      '  Kimlik        : ' + token.identity + '\r\n' +
      '  Seviye        : ' + token.mandatoryLevel + '\r\n' +
      '  Uygulama      : ' + appLevel + '\r\n' +
      '  Kalici mod    : ' + mode + '\r\n' +
      '  Otomatik kilit: ' + left + '\r\n' +
      '  Son komut     : ' + last + '\r\n'
    );
    this.restorePrompt();
  }

  /**
   * Display active token identity details.
   */
  handleWhoami() {
    const token = this.resolveTokenIdentity();
    this.writeToTerminal(
      '\x1b[1;32m[OP PRIVILEGE IDENTITY]\x1b[0m\r\n' +
      '\x1b[1;37m' + token.identity + '\x1b[0m\r\n' +
      '\x1b[90mSID: ' + token.sid + ' | Mandatory Level: ' + token.mandatoryLevel + '\x1b[0m\r\n'
    );
    this.restorePrompt();
  }

  /**
   * Display in-terminal OP engine manual.
   */
  showUsage() {
    this.writeToTerminal(
      '\x1b[1;36m[OP ENGINE] In-Terminal Privilege Elevation Subsystem\x1b[0m\r\n' +
      'Usage:\r\n' +
      '  /op whoami        - Display active elevated token identity & SID\r\n' +
      '  /op status        - Privilege state, auto-lock countdown, last /op\r\n' +
      '  /op !!            - Repeat the last /op or /op-system command\r\n' +
      '  /op <command>     - Run with full administrator authority (sudo)\r\n' +
      '  /sudo <command>   - Alias for /op <command>\r\n' +
      '  /op-system <cmd>  - Run with full NT AUTHORITY\\SYSTEM authority\r\n' +
      '  /op-unlock [min]  - Persistent elevated mode (auto-locks, default 15 min; 0 = never)\r\n' +
      '  /op-lock          - Disable persistent elevated mode\r\n' +
      '\x1b[90m  Shell routing : commands auto-route to CMD or PowerShell by syntax.\x1b[0m\r\n' +
      '\x1b[90m  Force a shell : /cmd <command>  or  /ps <command>\x1b[0m\r\n' +
      '\x1b[90m  Tip: /xyron  - customize the boot intro & live theme\x1b[0m\r\n'
    );
    this.restorePrompt();
  }

  /**
   * Check whether a command line targets the /xyron customization subsystem.
   * @param {string} line
   * @returns {boolean}
   */
  isXyronCommand(line) {
    if (!line || typeof line !== 'string') return false;
    const normalized = line.trim().replace(/\s+/g, ' ');
    return normalized === '/xyron' || normalized.startsWith('/xyron ');
  }

  /**
   * Check whether a line uses an explicit shell-route prefix (/cmd or /ps).
   * @param {string} line
   * @returns {boolean}
   */
  isShellRouteCommand(line) {
    if (!line || typeof line !== 'string') return false;
    return /^\/(cmd|ps|powershell)\b\s+\S/i.test(line.trim());
  }

  /**
   * Handle the in-terminal /xyron customization command set.
   * Currently drives the fully customizable cinematic boot intro.
   * @param {string} line
   */
  executeXyronCommand(line) {
    const cyan = (t) => '\x1b[1;36m' + t + '\x1b[0m';
    const green = (t) => '\x1b[1;32m' + t + '\x1b[0m';
    const red = (t) => '\x1b[1;31m' + t + '\x1b[0m';
    const dim = (t) => '\x1b[90m' + t + '\x1b[0m';

    const parts = line.trim().split(/\s+/);
    parts.shift(); // drop "/xyron"
    const section = (parts.shift() || '').toLowerCase();

    if (!this.configStore) {
      this.writeToTerminal(red('[XYRON] Configuration store unavailable.') + '\r\n');
      return;
    }

    if (section === '' || section === 'help') {
      this.writeToTerminal(
        cyan('[XYRON CENTER] In-Terminal Customization') + '\r\n' +
        'Boot intro:\r\n' +
        '  /xyron boot status            - Show current boot settings\r\n' +
        '  /xyron boot on | off          - Enable / disable the intro\r\n' +
        '  /xyron boot duration <ms>     - Intro length (500 - 15000)\r\n' +
        '  /xyron boot logo <text>       - Center logo text\r\n' +
        '  /xyron boot sub <text>        - Logo subtitle\r\n' +
        '  /xyron boot color <#hex>      - Neon accent color\r\n' +
        '  /xyron boot sound on | off    - Procedural boot audio\r\n' +
        '  /xyron boot crt on | off      - CRT scanline overlay\r\n' +
        '  /xyron boot reset             - Restore defaults\r\n' +
        dim('  Changes apply on the next launch (or /xyron boot preview).') + '\r\n' +
        'Live theme (applies instantly to the whole interface):\r\n' +
        '  color <kod>                   - CMD gibi: color a, color c, color f0 (liste: color ?)\r\n' +
        '  /xyron theme status           - Show current live theme\r\n' +
        '  /xyron theme color <#hex>     - Set text color\r\n' +
        '  /xyron theme bg <#hex>        - Set background color\r\n' +
        '  /xyron theme preset <name>    - white|green|amber|red|cyan|magenta|blue|yellow\r\n' +
        '  /xyron theme reset            - Pure black & white (default)\r\n'
      );
      return;
    }

    if (section === 'theme') {
      this.executeThemeCommand(parts, { cyan, green, red, dim });
      return;
    }

    if (section !== 'boot') {
      this.writeToTerminal(red(`[XYRON] Unknown section: ${section}`) + ' ' + dim('(try /xyron help)') + '\r\n');
      return;
    }

    const action = (parts.shift() || 'status').toLowerCase();

    if (action === 'status') {
      const b = this.configStore.getBoot();
      this.writeToTerminal(
        cyan('[XYRON] Boot Intro Settings') + '\r\n' +
        `  enabled   : ${b.enabled ? green('ON') : red('OFF')}\r\n` +
        `  duration  : ${b.durationMs} ms\r\n` +
        `  logo      : ${b.logoText}\r\n` +
        `  subtitle  : ${b.subText}\r\n` +
        `  accent    : ${b.accentColor}\r\n` +
        `  sound     : ${b.sound ? green('ON') : red('OFF')}\r\n` +
        `  crt       : ${b.crtScanlines ? green('ON') : red('OFF')}\r\n`
      );
      return;
    }

    if (action === 'reset') {
      this.configStore.resetBoot();
      this.broadcastConfig();
      this.writeToTerminal(green('[XYRON] Boot intro restored to defaults.') + '\r\n');
      return;
    }

    if (action === 'preview') {
      this.broadcastConfig(true);
      this.writeToTerminal(green('[XYRON] Replaying boot intro with current settings...') + '\r\n');
      return;
    }

    // Map action -> config key + remaining value
    const rest = parts.join(' ');
    let key = null;
    let value = rest;
    switch (action) {
      case 'on':      key = 'enabled'; value = true; break;
      case 'off':     key = 'enabled'; value = false; break;
      case 'enable':  key = 'enabled'; value = true; break;
      case 'disable': key = 'enabled'; value = false; break;
      case 'duration': key = 'durationMs'; break;
      case 'logo':     key = 'logoText'; break;
      case 'sub':      key = 'subText'; break;
      case 'subtitle': key = 'subText'; break;
      case 'color':    key = 'accentColor'; break;
      case 'accent':   key = 'accentColor'; break;
      case 'sound':    key = 'sound'; break;
      case 'crt':      key = 'crtScanlines'; break;
      default:
        this.writeToTerminal(red(`[XYRON] Unknown boot action: ${action}`) + ' ' + dim('(try /xyron boot)') + '\r\n');
        return;
    }

    const result = this.configStore.setBoot(key, value);
    if (result.ok) {
      this.broadcastConfig();
      this.writeToTerminal(green(`[XYRON] boot.${result.key} = ${result.value}`) + '\r\n');
    } else {
      this.writeToTerminal(red(`[XYRON] ${result.key}: ${result.message}`) + '\r\n');
    }
  }

  /**
   * Handle the `/xyron theme ...` command set, which recolors the LIVE HUD and
   * terminal instantly (no relaunch), unlike boot settings.
   * @param {string[]} parts - tokens after "/xyron theme"
   * @param {Object} fmt - color formatter helpers { cyan, green, red, dim }
   */
  executeThemeCommand(parts, fmt) {
    const { cyan, green, red, dim } = fmt;

    if (!this.configStore) {
      this.writeToTerminal(red('[XYRON] Configuration store unavailable.') + '\r\n');
      return;
    }

    const action = (parts.shift() || 'status').toLowerCase();

    if (action === 'status') {
      const t = this.configStore.getTheme();
      this.writeToTerminal(
        cyan('[XYRON] Live Theme') + '\r\n' +
        `  text       : ${t.fgColor}\r\n` +
        `  background : ${t.bgColor}\r\n` +
        dim('  Change with: color a | /xyron theme color <#hex> | /xyron theme preset <name>') + '\r\n'
      );
      return;
    }

    if (action === 'reset') {
      this.configStore.resetTheme();
      this.broadcastTheme();
      this.writeToTerminal(green('[XYRON] Live theme restored to defaults.') + '\r\n');
      return;
    }

    if (action === 'preset') {
      const result = this.configStore.setThemePreset(parts.join(' '));
      if (result.ok) {
        this.broadcastTheme();
        this.writeToTerminal(green(`[XYRON] theme preset = ${result.value}`) + '\r\n');
      } else {
        this.writeToTerminal(red(`[XYRON] ${result.message}`) + '\r\n');
      }
      return;
    }

    let key = null;
    let value = parts.join(' ');
    switch (action) {
      case 'color':  key = 'fgColor'; break;
      case 'text':   key = 'fgColor'; break;
      case 'accent': key = 'fgColor'; break;
      case 'bg':     key = 'bgColor'; break;
      case 'background': key = 'bgColor'; break;
      default:
        this.writeToTerminal(red(`[XYRON] Unknown theme action: ${action}`) + ' ' + dim('(try /xyron theme)') + '\r\n');
        return;
    }

    const result = this.configStore.setTheme(key, value);
    if (result.ok) {
      this.broadcastTheme();
      this.writeToTerminal(green(`[XYRON] theme.${result.key} = ${result.value}`) + '\r\n');
    } else {
      this.writeToTerminal(red(`[XYRON] ${result.key}: ${result.message}`) + '\r\n');
    }
  }

  /**
   * Execute a CMD-style `color` line. Success is SILENT (the interface itself
   * recoloring is the feedback, exactly like cmd.exe); only help and errors
   * print text, so no extra output is injected into the terminal on the happy
   * path.
   * @param {string} line
   */
  executeColorCommand(line) {
    const parsed = parseColorCommand(line);
    if (!parsed) return;

    if (!parsed.ok) {
      this.writeToTerminal('\r\n\x1b[31m' + parsed.message + '\x1b[0m\r\n');
      this.restorePrompt();
      return;
    }

    if (parsed.action === 'help') {
      this.writeToTerminal(
        '\r\n\x1b[1mcolor\x1b[0m [zemin][yazi]   ornek: color a  |  color f0  |  color #ff8800\r\n' +
        describePalette().join('\r\n') + '\r\n' +
        '\x1b[90m  color        -> varsayilan (siyah zemin, beyaz yazi)\x1b[0m\r\n'
      );
      this.restorePrompt();
      return;
    }

    if (parsed.action === 'reset') {
      if (this.configStore) this.configStore.resetTheme();
      this.broadcastTheme(this.configStore ? undefined : { bgColor: DEFAULT_THEME.bg, fgColor: DEFAULT_THEME.fg });
      return;
    }

    // action === 'set'
    if (this.configStore) {
      const saved = this.configStore.setThemeColors(parsed.bg, parsed.fg);
      if (!saved.ok) {
        this.writeToTerminal('\r\n\x1b[31m' + saved.message + '\x1b[0m\r\n');
        this.restorePrompt();
        return;
      }
      this.broadcastTheme();
    } else {
      this.broadcastTheme({ bgColor: parsed.bg, fgColor: parsed.fg });
    }
  }

  /**
   * Broadcast an updated live-theme snapshot to the renderer HUD.
   * @param {Object} [themeOverride] - explicit theme (used when no config store)
   */
  broadcastTheme(themeOverride) {
    if (!this.configStore && !themeOverride) return;
    const payload = { theme: themeOverride || this.configStore.getTheme() };
    this.emit('theme', payload);
    if (this.mainWindow && !this.mainWindow.isDestroyed?.() && !this.mainWindow.webContents?.isDestroyed?.()) {
      try {
        this.mainWindow.webContents.send('config:theme-updated', payload);
      } catch (_e) {}
    }
  }

  /**
   * Broadcast an updated config snapshot to the renderer (HUD / boot sequence).
   * @param {boolean} [replay=false] - request the renderer to replay the boot intro now
   */
  broadcastConfig(replay = false) {
    if (!this.configStore) return;
    const payload = { boot: this.configStore.getBoot(), replay: !!replay };
    this.emit('config', payload);
    if (this.mainWindow && !this.mainWindow.isDestroyed?.() && !this.mainWindow.webContents?.isDestroyed?.()) {
      try {
        this.mainWindow.webContents.send('config:boot-updated', payload);
      } catch (_e) {}
    }
  }

  /**
   * Execute sub-command via exec with { windowsHide: true } and real-time streaming.
   * 
   * @param {string} targetCmd - Command string to execute
   * @param {Function} [onComplete] - Optional completion callback (code, err)
   * @param {{tag?: string}} [opts] - tag: label shown on the shell line, e.g. 'op'
   * @returns {ChildProcess|null}
   */
  executeSubCommand(targetCmd, onComplete, opts = {}) {
    // Real app: type the (routed) command into the live shell. Its output flows
    // through ConPTY, so nothing is ever injected out-of-band and lines can no
    // longer land on top of each other.
    if (this._shellPassThroughActive()) {
      this._typeIntoShell(this._tagShellLine(this._buildShellLine(targetCmd), opts && opts.tag));
      if (typeof onComplete === 'function') onComplete(0, null);
      return null;
    }

    // Headless / non-shell fallback. Route the command to the shell that understands its syntax. Explicit
    // /cmd and /ps prefixes win; otherwise CMD-only or PS-5.1-breaking syntax
    // (&&, %VAR%, for /f, >nul, dir /b ...) goes to cmd.exe, genuine PowerShell
    // stays on PowerShell, and neutral commands default to the active host.
    const route = routeCommand(targetCmd, { default: this.shellType });
    const effectiveCmd = route.command || targetCmd;
    const shell = route.shell;
    const shellTag = route.explicit ? `${shell.toUpperCase()} (forced)` : shell.toUpperCase();

    // Keep the banner literal "[OP EXEC: <cmd>]" (tools and tests match on it); the
    // chosen shell is appended as a dim suffix.
    this.writeToTerminal(
      `\x1b[1;33m[OP EXEC: ${effectiveCmd}]\x1b[0m \x1b[90m(${shellTag})\x1b[0m\r\n`
    );

    const options = {
      cwd: this.cwd,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large outputs
      env: Object.assign({}, process.env, {
        PYTHONIOENCODING: 'utf-8',
        LANG: 'tr_TR.UTF-8'
      })
    };

    let child;
    try {
      if (shell === 'cmd') {
        // CMD world: exec() already routes through cmd.exe /d /s /c, handling CMD
        // built-ins, switches (dir /b), pipes and chaining natively.
        child = exec(effectiveCmd, options);
      } else {
        // PowerShell host (default): run via an -EncodedCommand payload so ANY command
        // string — PowerShell cmdlets, native .exe calls, and the common CMD aliases —
        // executes with zero quote-escaping problems and full UTF-8 (Turkish) output.
        const psInner =
          "$ProgressPreference='SilentlyContinue'; " +
          "[Console]::OutputEncoding=[Console]::InputEncoding=[System.Text.Encoding]::UTF8; " +
          "$OutputEncoding=[System.Text.Encoding]::UTF8; " +
          effectiveCmd;
        const encoded = Buffer.from(psInner, 'utf16le').toString('base64');
        child = execFile(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoLogo', '-EncodedCommand', encoded],
          options
        );
      }
    } catch (err) {
      this.writeToTerminal(`\x1b[31m[Spawn Error: ${err.message}]\x1b[0m\r\n`);
      this.restorePrompt();
      if (typeof onComplete === 'function') onComplete(1, err);
      return null;
    }

    this.activeProcesses.add(child);

    // Stream stdout chunks directly to terminal
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        const formatted = chunk.toString().replace(/\r?\n/g, '\r\n');
        this.writeToTerminal(formatted);
      });
    }

    // Stream stderr chunks in red
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const formatted = chunk.toString().replace(/\r?\n/g, '\r\n');
        this.writeToTerminal(`\x1b[31m${formatted}\x1b[0m`);
      });
    }

    // Handle completion
    child.on('close', (code) => {
      this.activeProcesses.delete(child);
      if (code !== 0 && code !== null) {
        this.writeToTerminal(`\x1b[31m[Process Exited with Code: ${code}]\x1b[0m\r\n`);
      }
      this.restorePrompt();
      if (typeof onComplete === 'function') onComplete(code, null);
    });

    // Handle spawn/runtime errors
    child.on('error', (err) => {
      this.activeProcesses.delete(child);
      this.writeToTerminal(`\x1b[31m[Process Error: ${err.message}]\x1b[0m\r\n`);
      this.restorePrompt();
      if (typeof onComplete === 'function') onComplete(1, err);
    });

    return child;
  }

  /**
   * Execute a command with full NT AUTHORITY\SYSTEM authority via a transient
   * scheduled task (the standard, consent-based Windows mechanism; it requires
   * the app to already be elevated, which the packaged EXE always is).
   *
   * Output is captured to a temp file and streamed back into the terminal. If
   * the SYSTEM task cannot be created or run (e.g. the app is not elevated),
   * it degrades gracefully to the normal elevated (administrator) executor so
   * the command still runs rather than failing silently.
   *
   * @param {string} targetCmd
   * @param {Function} [onComplete]
   */
  executeAsSystem(targetCmd, onComplete) {
    // Real app: the shell-side xsys helper creates the SYSTEM task and prints the
    // result through ConPTY. SYSTEM commands are PowerShell, whatever the router says.
    if (this._shellPassThroughActive()) {
      const bare = routeCommand(targetCmd, { default: this.shellType }).command || targetCmd;
      this._typeIntoShell(this._tagShellLine(`xsys '${bare.replace(/'/g, "''")}'`, 'op-system'));
      if (typeof onComplete === 'function') onComplete(0, null);
      return;
    }

    const stamp = `${process.pid}_${Date.now()}`;
    const taskName = `XyronOp_${stamp}`;
    const outFile = path.join(os.tmpdir(), `${taskName}.out`);
    const scriptFile = path.join(os.tmpdir(), `${taskName}.ps1`);

    const fallback = (reason) => {
      if (reason) {
        this.writeToTerminal(
          `\x1b[33m[OP SYSTEM] ${reason} - yonetici yetkisiyle calistiriliyor.\x1b[0m\r\n`
        );
      }
      try { if (fs.existsSync(scriptFile)) fs.unlinkSync(scriptFile); } catch (_e) {}
      try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (_e) {}
      this.executeSubCommand(targetCmd, onComplete);
    };

    // 1. Write the payload to a temp PowerShell script (avoids schtasks quoting hell).
    const scriptBody =
      "$ProgressPreference='SilentlyContinue'\r\n" +
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\r\n" +
      "$OutputEncoding=[System.Text.Encoding]::UTF8\r\n" +
      "try {\r\n" + targetCmd + "\r\n} catch { $_ | Out-String }\r\n";
    try {
      fs.writeFileSync(scriptFile, scriptBody, { encoding: 'utf8' });
    } catch (err) {
      fallback(`Gecici betik yazilamadi (${err.message})`);
      return;
    }

    this.writeToTerminal(`\x1b[1;35m[OP SYSTEM EXEC: ${targetCmd}]\x1b[0m\r\n`);

    // 2. Create a one-shot SYSTEM task. The /tr wraps cmd so stdout+stderr
    //    redirect into outFile; execFile passes /tr as a single argv entry.
    const runLine =
      `cmd /c powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}" > "${outFile}" 2>&1`;
    const createArgs = [
      '/create', '/tn', taskName, '/tr', runLine,
      '/sc', 'once', '/st', '00:00', '/ru', 'SYSTEM', '/rl', 'HIGHEST', '/f'
    ];

    execFile(sysTool('schtasks', false), createArgs, { windowsHide: true }, (createErr) => {
      if (createErr) {
        fallback('SYSTEM gorevi olusturulamadi (yonetici gerekli)');
        return;
      }
      // 3. Run it now.
      execFile(sysTool('schtasks', false), ['/run', '/tn', taskName], { windowsHide: true }, (runErr) => {
        if (runErr) {
          this._cleanupSystemTask(taskName, scriptFile);
          fallback('SYSTEM gorevi baslatilamadi');
          return;
        }
        // 4. Poll until the task finishes (Status leaves "Running"), then read output.
        let waited = 0;
        const stepMs = 350;
        const maxMs = 120000; // 2 min safety cap
        const poll = setInterval(() => {
          waited += stepMs;
          execFile(sysTool('schtasks', false), ['/query', '/tn', taskName, '/fo', 'list'],
            { windowsHide: true, encoding: 'utf8' }, (qErr, stdout) => {
              const running = !qErr && /Status:\s*Running/i.test(stdout || '');
              if (running && waited < maxMs) return; // keep waiting

              clearInterval(poll);
              // Give the redirect a moment to flush, then stream the output file.
              setTimeout(() => {
                let output = '';
                try { output = fs.readFileSync(outFile, 'utf8'); } catch (_e) {}
                if (output) {
                  this.writeToTerminal(output.replace(/\r?\n/g, '\r\n'));
                  if (!/\n$/.test(output)) this.writeToTerminal('\r\n');
                } else if (waited >= maxMs) {
                  this.writeToTerminal('\x1b[31m[OP SYSTEM] Zaman asimi (120s).\x1b[0m\r\n');
                }
                this._cleanupSystemTask(taskName, scriptFile, outFile);
                this.restorePrompt();
                if (typeof onComplete === 'function') onComplete(0, null);
              }, 250);
            });
        }, stepMs);
      });
    });
  }

  /**
   * Best-effort removal of a transient SYSTEM task and its temp files.
   * @private
   */
  _cleanupSystemTask(taskName, scriptFile, outFile) {
    try {
      execFile(sysTool('schtasks', false), ['/delete', '/tn', taskName, '/f'], { windowsHide: true }, () => {});
    } catch (_e) {}
    try { if (scriptFile && fs.existsSync(scriptFile)) fs.unlinkSync(scriptFile); } catch (_e) {}
    try { if (outFile && fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (_e) {}
  }

  /**
   * Terminate all active child processes via taskkill process tree kill.
   */
  terminateActiveProcesses() {
    for (const child of this.activeProcesses) {
      if (child && child.pid) {
        try {
          execSync(`${sysTool('taskkill')} /F /PID ${child.pid} /T`, { stdio: 'ignore', windowsHide: true });
        } catch (_e) {
          // Process may have already exited
        }
      }
    }
    this.activeProcesses.clear();
  }

  /**
   * Register Electron IPC handlers.
   * @param {Electron.IpcMain} ipcMain
   */
  registerIpc(ipcMain) {
    if (!ipcMain || this._ipcRegistered) return;
    this._ipcRegistered = true;
    this._ipcMain = ipcMain;

    this._boundIpcHandlers['op:execute'] = (_event, cmd) => {
      if (typeof cmd === 'string') {
        this.executeOpCommand(cmd);
      }
    };

    this._boundIpcHandlers['op:get-status'] = async () => this._buildStatus();

    ipcMain.on('op:execute', this._boundIpcHandlers['op:execute']);
    ipcMain.handle('op:get-status', this._boundIpcHandlers['op:get-status']);
  }

  /**
   * Unregister Electron IPC handlers.
   * @param {Electron.IpcMain} [ipcMain]
   */
  unregisterIpc(ipcMain) {
    const targetIpc = ipcMain || this._ipcMain;
    if (!targetIpc || !this._ipcRegistered) return;
    this._ipcRegistered = false;

    if (this._boundIpcHandlers['op:execute']) {
      try {
        targetIpc.removeListener('op:execute', this._boundIpcHandlers['op:execute']);
      } catch (_e) {}
    }
    try {
      targetIpc.removeHandler('op:get-status');
    } catch (_e) {}

    this._boundIpcHandlers = {};
    this._ipcMain = null;
  }

  /**
   * Cleanup daemon state and child processes upon application exit.
   */
  destroy() {
    this._clearLockTimer();
    this.unregisterIpc();
    this.terminateActiveProcesses();
    this.inputBuffer = '';
    this.ptyProcess = null;
    this.ptyManager = null;
    this.mainWindow = null;
    this.outputHandler = null;
    this.statusHandler = null;
    this.promptRestorer = null;
    this._cachedToken = null;
    this.removeAllListeners();
  }
}

module.exports = ElevationDaemon;
