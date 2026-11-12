/**
 * XYRON CENTER - Terminal viewport
 * File: src/renderer/js/terminal-view.js
 *
 * xterm.js attached to the native Windows ConPTY. Pure black background with
 * white text by default; the whole palette follows the live theme (the `color`
 * command / `/xyron theme`). Created at startup (under the intro overlay) and
 * announces itself with `terminal:ready`, so the shell's first prompt is
 * replayed instead of lost.
 */

/** Relative luminance (0..1) of a #rrggbb color. */
function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** "r, g, b" string for a #rrggbb color (used for rgba()). */
function rgbTriplet(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

const ANSI_ON_DARK = {
  black: '#5c5c5c', red: '#ff5f6a', green: '#3ddc57', yellow: '#f5d142',
  blue: '#6c9cff', magenta: '#d98bff', cyan: '#5fe0ec', white: '#d9d9d9',
  brightBlack: '#8a8a8a', brightRed: '#ff8088', brightGreen: '#7dff95', brightYellow: '#ffe97a',
  brightBlue: '#9dbbff', brightMagenta: '#ecb0ff', brightCyan: '#9cf3fb', brightWhite: '#ffffff'
};

const ANSI_ON_LIGHT = {
  black: '#000000', red: '#c4151f', green: '#12842b', yellow: '#8a6d00',
  blue: '#1b4fd8', magenta: '#8a1fb0', cyan: '#0a7a86', white: '#555555',
  brightBlack: '#444444', brightRed: '#e02a35', brightGreen: '#1ea03c', brightYellow: '#a5830a',
  brightBlue: '#3a69f0', brightMagenta: '#a63dcb', brightCyan: '#1595a3', brightWhite: '#000000'
};

/**
 * Build an xterm theme from the interface colors. Default text and cursor use
 * the interface text color; ANSI colors switch to a darker set on light
 * backgrounds so nothing becomes unreadable.
 *
 * @param {string} bg - #rrggbb
 * @param {string} fg - #rrggbb
 * @returns {Object} xterm ITheme
 */
function buildTerminalTheme(bg, fg) {
  const light = luminance(bg) > 0.5;
  return Object.assign({}, light ? ANSI_ON_LIGHT : ANSI_ON_DARK, {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: `rgba(${rgbTriplet(fg)}, 0.28)`
  });
}

class TerminalView {
  constructor(options = {}) {
    this.containerId = options.containerId || 'terminal-container';
    this.outer = document.getElementById(this.containerId);
    // xterm opens in an unpadded inner host so FitAddon's math is exact;
    // older markup without the host falls back to the outer container.
    this.container = document.getElementById(options.hostId || 'terminal-host') || this.outer;
    this.fontSize = TerminalView.loadFontSize();
    this.toastTimer = null;
    this.search = { term: '', hits: [], index: -1 };
    this.onCwdChange = options.onCwdChange || (() => {});
    this.onPalette = options.onPalette || null;
    this._linkProvider = null;
    this.lastLogPath = '';

    this.terminal = null;
    this.fitAddon = null;
    this.resizeObserver = null;
    this.resizeDebounceTimer = null;

    this.colors = { bg: '#000000', fg: '#ffffff' };

    this.unsubscribeOutput = null;
    this.unsubscribeCwd = null;

    this.dom = {
      geometry: document.getElementById('term-geometry'),
      cwdDisplay: document.getElementById('term-cwd-display'),
      shellBadge: document.getElementById('term-shell-badge')
    };
  }

  /**
   * Translate a keyboard chunk before it reaches the shell.
   * A bare ESC wipes the whole line in PowerShell/CMD; here it deletes one
   * character instead (sent as DEL, exactly what Backspace sends), so holding
   * it erases letter by letter through normal key repeat. Full-screen programs
   * (alternate screen: vim, less, ...) still get a real ESC.
   *
   * @param {string} data - chunk from xterm onData
   * @param {boolean} [alternateScreen=false]
   * @returns {string}
   */
  static mapInput(data, alternateScreen = false) {
    if (data === '\x1b' && !alternateScreen) return '\x7f';
    return data;
  }

  /**
   * @returns {boolean} true while a full-screen app has the alternate buffer active
   * @private
   */
  _isAlternateScreen() {
    const buffer = this.terminal && this.terminal.buffer;
    return !!(buffer && buffer.active && buffer.active.type === 'alternate');
  }

  /**
   * Initializes xterm.js, binds IPC streams, then tells the main process the
   * terminal is attached (which replays everything the shell printed so far).
   */
  init() {
    if (!this.container || this.terminal) return;

    const TerminalClass = (typeof window !== 'undefined' && window.Terminal) ? window.Terminal : null;
    if (!TerminalClass) {
      console.error('[TerminalView] xterm.js library not loaded in window!');
      return;
    }

    this.terminal = new TerminalClass({
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      fontSize: this.fontSize,
      fontFamily: "'Cascadia Mono', 'Cascadia Code', 'Consolas', 'Courier New', monospace",
      fontWeight: '400',
      fontWeightBold: '700',
      letterSpacing: 0,
      lineHeight: 1.2,
      // Must stay off for a PTY: ConPTY positions the cursor itself, and a bare
      // LF from it means "down one row, same column". convertEol turned that
      // into CR+LF, shifting the column so later text landed on earlier text.
      convertEol: false,
      // Opaque on purpose: transparency leaves ghost glyphs behind in some
      // renderers, which looked like typed lines piling on top of each other.
      allowTransparency: false,
      scrollback: 5000,
      theme: buildTerminalTheme(this.colors.bg, this.colors.fg)
    });

    const FitAddonModule = (typeof window !== 'undefined' && window.FitAddon) ? window.FitAddon : null;
    const FitAddonClass = (FitAddonModule && FitAddonModule.FitAddon) ? FitAddonModule.FitAddon : FitAddonModule;
    if (FitAddonClass) {
      this.fitAddon = new FitAddonClass();
      this.terminal.loadAddon(this.fitAddon);
    }

    this.terminal.open(this.container);
    this._bindProFeatures();
    this._bindLinks();
    this._bindDrop();
    this.fit();
    // The terminal now starts under the intro, before fonts and layout have
    // settled, so the first measurement can be wrong. Re-measure as they settle.
    this._scheduleRefits();

    // Keyboard -> ConPTY
    this.terminal.onData((data) => {
      if (window.terminalApi && typeof window.terminalApi.sendInput === 'function') {
        window.terminalApi.sendInput(TerminalView.mapInput(data, this._isAlternateScreen()));
      }
    });

    // ConPTY output -> viewport
    if (window.terminalApi && typeof window.terminalApi.onOutput === 'function') {
      this.unsubscribeOutput = window.terminalApi.onOutput((chunk) => {
        if (this.terminal && typeof chunk === 'string') this.terminal.write(chunk);
      });
    }

    // CWD sync
    if (window.terminalApi && typeof window.terminalApi.onCwdChange === 'function') {
      this.unsubscribeCwd = window.terminalApi.onCwdChange((newCwd) => this.handleCwdChange(newCwd));
    }
    if (window.terminalApi && typeof window.terminalApi.getCwd === 'function') {
      window.terminalApi.getCwd().then((cwd) => { if (cwd) this.handleCwdChange(cwd); }).catch(() => {});
    }

    this._bindResizeObserver();

    // Subscribed and sized: now the main process may replay buffered output.
    if (window.terminalApi && typeof window.terminalApi.ready === 'function') {
      window.terminalApi.ready();
    }
  }

  /**
   * Recolor the terminal live (background + text) from the interface theme.
   * Safe to call before init(): the colors are stored and applied on open.
   *
   * @param {{bg: string, fg: string}} colors
   */
  setColors(colors) {
    if (!colors || typeof colors.bg !== 'string' || typeof colors.fg !== 'string') return;
    this.colors = { bg: colors.bg, fg: colors.fg };
    if (!this.terminal) return;
    try {
      this.terminal.options.theme = buildTerminalTheme(this.colors.bg, this.colors.fg);
    } catch (_e) {
      // theme not assignable in this xterm build: next terminal picks it up
    }
  }

  /** Re-fit once fonts load and again as the layout settles. @private */
  _scheduleRefits() {
    const refit = () => this.fit();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(refit);
    if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
      document.fonts.ready.then(refit).catch(() => {});
    }
    setTimeout(refit, 150);
    setTimeout(refit, 700);
  }

  /** Fits the terminal to its container and tells the ConPTY the new geometry. */
  fit() {
    if (!this.terminal || !this.fitAddon || !this.container) return;

    const rect = this.container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    try {
      this.fitAddon.fit();
      const cols = this.terminal.cols;
      const rows = this.terminal.rows;
      // A degenerate measurement (fonts or layout not ready yet) must never reach
      // the ConPTY: resizing the shell to a few columns scrambles its output.
      if (!(cols >= 20 && rows >= 4)) return;
      if (this.dom.geometry) this.dom.geometry.textContent = `${cols}x${rows}`;
      if (window.terminalApi && typeof window.terminalApi.resize === 'function') {
        window.terminalApi.resize(cols, rows);
      }
    } catch (_e) {
      // transient geometry errors while the layout settles
    }
  }

  focus() {
    if (this.terminal) this.terminal.focus();
  }

  /**
   * Updates the CWD readout and notifies the directory tree.
   * @param {string} newCwd
   */
  handleCwdChange(newCwd) {
    if (!newCwd || typeof newCwd !== 'string') return;
    if (this.dom.cwdDisplay) {
      this.dom.cwdDisplay.textContent = newCwd;
      this.dom.cwdDisplay.title = newCwd;
    }
    if (typeof this.onCwdChange === 'function') this.onCwdChange(newCwd);
  }

  /** @private */
  _bindResizeObserver() {
    if (typeof ResizeObserver === 'undefined' || !this.container) return;
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeDebounceTimer) clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = setTimeout(() => this.fit(), 60);
    });
    this.resizeObserver.observe(this.container);
  }

  // ---------------------------------------------------------------------------
  // Pro features: clipboard, font zoom, scrollback search, clear
  // ---------------------------------------------------------------------------

  /** @returns {number} saved font size (10..28), default 14 */
  static loadFontSize() {
    try {
      const v = parseInt(window.localStorage.getItem('xyron.term.fontSize'), 10);
      if (v >= TerminalView.FONT_MIN && v <= TerminalView.FONT_MAX) return v;
    } catch (_e) {}
    return 14;
  }

  /**
   * Decide what a key combination does. Pure, so it can be unit tested.
   * @param {{type:string,key:string,ctrlKey:boolean,shiftKey:boolean,altKey:boolean,metaKey:boolean}} e
   * @param {boolean} hasSelection
   * @returns {string|null} action name, or null to let xterm handle the key
   */
  static keyAction(e, hasSelection) {
    if (!e || e.type !== 'keydown' || e.altKey || e.metaKey) return null;
    const key = String(e.key || '').toLowerCase();
    if (e.ctrlKey && e.shiftKey) {
      if (key === 'c') return 'copy';
      if (key === 'v') return 'paste';
      if (key === 'f') return 'search';
      if (key === 'k') return 'clear';
      if (key === 's') return 'save-log';
      if (key === 'p') return 'palette';
      return null;
    }
    if (e.ctrlKey) {
      // Ctrl+C copies when text is selected, otherwise it stays SIGINT.
      if (key === 'c' && hasSelection) return 'copy';
      if (key === 'v') return 'paste';
      if (key === '=' || key === '+') return 'font-up';
      if (key === '-') return 'font-down';
      if (key === '0') return 'font-reset';
      return null;
    }
    if (e.shiftKey && key === 'insert') return 'paste';
    return null;
  }

  /**
   * Normalize pasted text for the shell: CRLF/CR -> CR (Enter), and drop a
   * trailing newline so a pasted line is not executed by accident.
   * @param {string} text
   * @returns {string}
   */
  static preparePaste(text) {
    if (typeof text !== 'string' || !text) return '';
    return text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').replace(/\n/g, '\r');
  }

  /**
   * Find clickable things in one line of terminal text: http(s) links and
   * absolute Windows paths (C:\..., no spaces). Trailing punctuation that is
   * almost always sentence text ("see C:\x." / "(https://a.b)") is left out.
   * Pure, so it can be unit tested.
   *
   * @param {string} text
   * @returns {Array<{start: number, end: number, text: string, kind: 'url'|'path'}>} end is exclusive
   */
  static findLinks(text) {
    const links = [];
    if (typeof text !== 'string' || !text) return links;
    // Drive paths with either separator: C:\Users\x and C:/Users/x (git, node, compilers).
    const re = /\bhttps?:\/\/[^\s"'<>`]+|(?<![\w\\/])[A-Za-z]:[\\/][^\s"'<>|*?`]*/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      let value = m[0];
      // Drop trailing sentence punctuation, and a closing bracket with no opener.
      for (;;) {
        const last = value[value.length - 1];
        if (/[.,;:!?'"]/.test(last)) { value = value.slice(0, -1); continue; }
        const pairs = { ')': '(', ']': '[', '}': '{' };
        if (pairs[last] && value.split(pairs[last]).length - 1 < value.split(last).length - 1) {
          value = value.slice(0, -1);
          continue;
        }
        break;
      }
      const kind = /^https?:/i.test(value) ? 'url' : 'path';
      if (kind === 'url' && !/^https?:\/\/[^/\s]+/i.test(value)) continue;
      if (kind === 'path' && value.length < 3) continue;
      links.push({ start: m.index, end: m.index + value.length, text: value, kind });
    }
    return links;
  }

  /**
   * Quote a filesystem path for the PowerShell prompt. Plain paths stay as they
   * are; anything with spaces or special characters is single-quoted (where
   * nothing is expanded), doubling any embedded single quote.
   *
   * @param {string} p
   * @returns {string}
   */
  static quotePath(p) {
    const s = String(p == null ? '' : p);
    if (!s) return '';
    if (/^[A-Za-z0-9_:\\/.\-]+$/.test(s)) return s;
    return `'${s.replace(/'/g, "''")}'`;
  }

  /**
   * All terminal text (scrollback included), trailing blank lines removed.
   * @returns {string}
   */
  getBufferText() {
    const buf = this.terminal && this.terminal.buffer ? this.terminal.buffer.active : null;
    if (!buf) return '';
    const lines = [];
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      // A soft-wrapped row continues the previous one rather than starting a line.
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join('\n');
  }

  /**
   * Put a full line at the prompt (replacing half-typed text); optionally run it.
   * Refused while a full-screen program (vim, less ...) owns the screen.
   *
   * @param {string} text
   * @param {boolean} [run=false]
   * @returns {boolean}
   */
  insertLine(text, run = false) {
    if (!text || this._isAlternateScreen()) {
      if (text) this.toast('FULL-SCREEN APP ACTIVE');
      return false;
    }
    if (!window.terminalApi || typeof window.terminalApi.submitLine !== 'function') return false;
    window.terminalApi.submitLine(text, run);
    this.focus();
    return true;
  }

  /**
   * Append text at the cursor exactly as if it had been typed (dropped paths).
   * @param {string} text
   */
  typeText(text) {
    if (!text || !this.terminal) return;
    if (typeof this.terminal.paste === 'function') this.terminal.paste(text);
    else if (window.terminalApi) window.terminalApi.sendInput(text);
    this.focus();
  }

  /** Make links and paths in the output Ctrl+clickable. @private */
  _bindLinks() {
    const term = this.terminal;
    if (!term || typeof term.registerLinkProvider !== 'function') return;
    this._linkProvider = term.registerLinkProvider({
      provideLinks: (lineNumber, callback) => {
        const line = term.buffer.active.getLine(lineNumber - 1);
        if (!line) { callback(undefined); return; }
        const found = TerminalView.findLinks(line.translateToString(true));
        if (!found.length) { callback(undefined); return; }
        callback(found.map((link) => ({
          text: link.text,
          range: { start: { x: link.start + 1, y: lineNumber }, end: { x: link.end, y: lineNumber } },
          decorations: { underline: true, pointerCursor: true },
          activate: (event) => this._activateLink(link, event)
        })));
      }
    });
  }

  /**
   * Ctrl+click opens a link in the browser or shows a path in Explorer. A plain
   * click does nothing, so selecting text never launches anything by accident.
   * @private
   */
  _activateLink(link, event) {
    if (!event || !event.ctrlKey) {
      this.toast('CTRL+CLICK TO OPEN');
      return;
    }
    const api = window.systemApi;
    if (!api) return;
    const done = (res) => { if (!res || !res.ok) this.toast((res && res.message) || 'ACILAMADI'); };
    if (link.kind === 'url') api.openExternal(link.text).then(done);
    // "C:/proj/a.js:12:5" (compiler / stack trace output) -> the file itself.
    else api.revealPath(link.text.replace(/:\d+(?::\d+)?$/, '')).then(done);
  }

  /** Drop files from Explorer or the directory panel = type their quoted paths. @private */
  _bindDrop() {
    const target = this.outer || this.container;
    if (!target) return;
    target.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      target.classList.add('drop-active');
    });
    target.addEventListener('dragleave', (e) => {
      if (!target.contains(e.relatedTarget)) target.classList.remove('drop-active');
    });
    target.addEventListener('drop', (e) => {
      e.preventDefault();
      target.classList.remove('drop-active');
      const dt = e.dataTransfer;
      if (!dt) return;
      const paths = [];
      const internal = dt.getData('application/x-xyron-path');
      if (internal) paths.push(internal);
      else if (dt.files && dt.files.length && window.systemApi) {
        for (const file of Array.from(dt.files)) {
          const p = window.systemApi.pathForFile(file);
          if (p) paths.push(p);
        }
      }
      if (!paths.length) {
        const text = dt.getData('text/plain');
        if (text) this.typeText(TerminalView.preparePaste(text));
        return;
      }
      this.typeText(paths.map(TerminalView.quotePath).join(' ') + ' ');
    });
  }

  /** Write the whole scrollback to Documents\XyronCenter\logs. */
  async saveLog() {
    const text = this.getBufferText();
    if (!text.trim()) { this.toast('NOTHING TO SAVE'); return; }
    if (!window.systemApi) return;
    const res = await window.systemApi.saveLog(text);
    if (res && res.ok) {
      this.toast('SAVED: ' + String(res.path).split('\\').pop());
      this.lastLogPath = res.path;
    } else {
      this.toast((res && res.message) || 'SAVE FAILED');
    }
  }

  /** @private */
  _bindProFeatures() {
    const term = this.terminal;
    if (typeof term.attachCustomKeyEventHandler === 'function') {
      term.attachCustomKeyEventHandler((e) => {
        const action = TerminalView.keyAction(e, term.hasSelection());
        if (!action) return true;
        e.preventDefault();
        this.runAction(action);
        return false;
      });
    }

    // Right click: copy if something is selected, otherwise paste (Windows Terminal style).
    this.container.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.runAction(term.hasSelection() ? 'copy' : 'paste');
    });

    // Ctrl + mouse wheel zooms the text.
    this.container.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.runAction(e.deltaY < 0 ? 'font-up' : 'font-down');
    }, { passive: false });

    document.querySelectorAll('[data-term-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-term-action');
        this.runAction(action);
        if (action !== 'search' && action !== 'palette') this.focus();
      });
    });

    this._bindSearchBar();
  }

  /** Run a named terminal action (keyboard, buttons and right click all go through here). */
  runAction(action) {
    const term = this.terminal;
    if (!term) return;
    switch (action) {
      case 'copy': {
        const text = term.getSelection();
        if (text && window.clipboardApi && window.clipboardApi.writeText(text)) {
          term.clearSelection();
          this.toast(`COPIED ${text.length} CHARS`);
        } else {
          this.toast('NOTHING SELECTED');
        }
        break;
      }
      case 'paste': {
        const raw = window.clipboardApi ? window.clipboardApi.readText() : '';
        const text = TerminalView.preparePaste(raw);
        if (!text) { this.toast('CLIPBOARD EMPTY'); break; }
        if (typeof term.paste === 'function') term.paste(text);
        else if (window.terminalApi) window.terminalApi.sendInput(text);
        break;
      }
      case 'clear':
        term.clear();
        this.toast('SCROLLBACK CLEARED');
        break;
      case 'font-up': this.setFontSize(this.fontSize + 1); break;
      case 'font-down': this.setFontSize(this.fontSize - 1); break;
      case 'font-reset': this.setFontSize(14); break;
      case 'search': this.openSearch(); break;
      case 'save-log': this.saveLog(); break;
      case 'palette': if (typeof this.onPalette === 'function') this.onPalette(); break;
      default: break;
    }
  }

  /** Change and persist the font size, then refit the grid. */
  setFontSize(size) {
    const next = Math.max(TerminalView.FONT_MIN, Math.min(TerminalView.FONT_MAX, Math.round(size)));
    this.fontSize = next;
    try { window.localStorage.setItem('xyron.term.fontSize', String(next)); } catch (_e) {}
    if (this.terminal) {
      this.terminal.options.fontSize = next;
      this.fit();
    }
    this.toast(`FONT ${next}PX`);
  }

  /** Brief status pill over the viewport. */
  toast(message) {
    const el = document.getElementById('term-toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), 1200);
  }

  /** @private */
  _bindSearchBar() {
    const bar = document.getElementById('term-search');
    const input = document.getElementById('term-search-input');
    if (!bar || !input) return;
    input.addEventListener('input', () => this.runSearch(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.stepSearch(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); this.closeSearch(); }
    });
    bar.querySelectorAll('[data-term-search]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const what = btn.getAttribute('data-term-search');
        if (what === 'close') this.closeSearch();
        else this.stepSearch(what === 'prev' ? -1 : 1);
      });
    });
  }

  openSearch() {
    const bar = document.getElementById('term-search');
    const input = document.getElementById('term-search-input');
    if (!bar || !input) return;
    bar.classList.remove('hidden');
    const sel = this.terminal.getSelection();
    if (sel && !sel.includes('\n')) input.value = sel;
    input.focus();
    input.select();
    if (input.value) this.runSearch(input.value);
  }

  closeSearch() {
    const bar = document.getElementById('term-search');
    if (bar) bar.classList.add('hidden');
    if (this.terminal) this.terminal.clearSelection();
    this.search = { term: '', hits: [], index: -1 };
    this.focus();
  }

  /**
   * Find every case-insensitive match in the whole buffer (scrollback included).
   * @param {string} query
   */
  runSearch(query) {
    const term = this.terminal;
    const q = String(query || '').toLowerCase();
    this.search = { term: q, hits: [], index: -1 };
    if (term && q) {
      const buf = term.buffer.active;
      for (let y = 0; y < buf.length && this.search.hits.length < 2000; y++) {
        const line = buf.getLine(y);
        if (!line) continue;
        const text = line.translateToString(true).toLowerCase();
        let from = 0;
        let at = text.indexOf(q, from);
        while (at !== -1) {
          this.search.hits.push({ y, x: at });
          from = at + q.length;
          at = text.indexOf(q, from);
        }
      }
    }
    // Start from the newest match: that is usually the one you want.
    if (this.search.hits.length) this.search.index = this.search.hits.length;
    this.stepSearch(-1);
  }

  /** Move to the previous (-1) / next (+1) match and select it. */
  stepSearch(dir) {
    const count = document.getElementById('term-search-count');
    const { hits, term: q } = this.search;
    if (!hits.length) {
      if (count) count.textContent = q ? '0/0' : '';
      if (this.terminal) this.terminal.clearSelection();
      return;
    }
    this.search.index = (this.search.index + dir + hits.length) % hits.length;
    const hit = hits[this.search.index];
    this.terminal.select(hit.x, hit.y, q.length);
    this.terminal.scrollToLine(Math.max(0, hit.y - Math.floor(this.terminal.rows / 2)));
    if (count) count.textContent = `${this.search.index + 1}/${hits.length}`;
  }

  destroy() {
    if (this.resizeObserver) { this.resizeObserver.disconnect(); this.resizeObserver = null; }
    if (this.resizeDebounceTimer) { clearTimeout(this.resizeDebounceTimer); this.resizeDebounceTimer = null; }
    if (this.toastTimer) { clearTimeout(this.toastTimer); this.toastTimer = null; }
    if (typeof this.unsubscribeOutput === 'function') { this.unsubscribeOutput(); this.unsubscribeOutput = null; }
    if (typeof this.unsubscribeCwd === 'function') { this.unsubscribeCwd(); this.unsubscribeCwd = null; }
    if (this._linkProvider && typeof this._linkProvider.dispose === 'function') {
      try { this._linkProvider.dispose(); } catch (_e) {}
      this._linkProvider = null;
    }
    if (this.terminal) {
      try { this.terminal.dispose(); } catch (_e) {}
      this.terminal = null;
    }
  }
}

TerminalView.FONT_MIN = 10;
TerminalView.FONT_MAX = 28;

if (typeof window !== 'undefined') {
  window.TerminalView = TerminalView;
  window.buildTerminalTheme = buildTerminalTheme;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TerminalView;
  module.exports.buildTerminalTheme = buildTerminalTheme;
  module.exports.luminance = luminance;
}
