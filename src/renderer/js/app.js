/**
 * XYRON CENTER - Front-end coordinator
 * File: src/renderer/js/app.js
 *
 * Startup order matters for speed: the live interface (terminal, telemetry,
 * process list, directory tree) is brought up IMMEDIATELY, underneath the
 * signature intro. When the intro ends the interface is already running, so
 * there is nothing left to wait for.
 *
 * Also owns the live theme: the CMD-style `color` command and `/xyron theme`
 * both end up in applyTheme(), which recolors the entire interface at once.
 */

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('DOMContentLoaded', () => {
    const app = new XyronCenterApp();
    app.start();
    window.__xyronApp = app;
  });
}

class XyronCenterApp {
  constructor() {
    this.telemetryView = null;
    this.terminalView = null;
    this.processView = null;
    this.directoryTree = null;
    this.commandPalette = null;
    this.bootSequence = null;
    this.drivesTimer = null;

    this.isHudActive = false;
    this._lastTheme = null;

    this.dom = {
      hudApp: document.getElementById('hud-app'),
      bootOverlay: document.getElementById('boot-overlay'),
      opBadge: document.getElementById('op-badge'),
      btnWinMin: document.getElementById('btn-win-minimize'),
      btnWinMax: document.getElementById('btn-win-maximize'),
      btnWinClose: document.getElementById('btn-win-close')
    };

    this.unsubscribeTelemetry = null;
    this.unsubscribeElevation = null;
    this.unsubscribeTheme = null;
  }

  /**
   * Application entry point.
   */
  start() {
    this._perf('renderer-start');

    // 1. Views
    this.telemetryView = new window.TelemetryView();
    if (typeof this.telemetryView.startLiveClock === 'function') this.telemetryView.startLiveClock();
    this.processView = new window.ProcessView();
    this.processView.init();

    this.directoryTree = new window.DirectoryTree({
      onInsertPath: (fullPath) => {
        if (this.terminalView) this.terminalView.typeText(window.TerminalView.quotePath(fullPath) + ' ');
      }
    });
    this.directoryTree.init();

    this.terminalView = new window.TerminalView({
      onCwdChange: (newCwd) => {
        if (this.directoryTree) this.directoryTree.loadDirectory(newCwd);
      },
      onPalette: () => this.openPalette()
    });

    if (window.CommandPalette) {
      this.commandPalette = new window.CommandPalette({ terminalView: this.terminalView });
      this.commandPalette.init();
    }
    this._bindGlobalShortcuts();

    // 2. Window controls, privilege badge, live theme
    this._bindWindowControls();
    this._bindElevationStatus();
    this._bindThemeUpdates();
    this._bindConfigReplay();

    // 3. Bring the live interface up NOW (it sits under the intro overlay).
    this._startLiveInterface();

    // 4. Signature intro on top.
    this._initBootSequence();
  }

  /**
   * Startup timing marker (forwarded to the main-process log when XYRON_PERF=1).
   * @param {string} stage
   * @private
   */
  _perf(stage) {
    try {
      console.log(`[perf] ${stage} +${Math.round(performance.now())}ms (since page load)`);
    } catch (_e) {}
  }

  /**
   * Start the terminal and every data stream without waiting for the intro.
   * @private
   */
  _startLiveInterface() {
    if (this.terminalView) this.terminalView.init();

    if (window.telemetryApi && typeof window.telemetryApi.onUpdate === 'function') {
      this.unsubscribeTelemetry = window.telemetryApi.onUpdate((telemetry) => {
        if (this.telemetryView) this.telemetryView.update(telemetry);
        if (this.processView) this.processView.update(telemetry);
      });
    }

    if (window.telemetryApi && typeof window.telemetryApi.getSnapshot === 'function') {
      window.telemetryApi.getSnapshot().then((snapshot) => {
        if (!snapshot) return;
        if (this.telemetryView) this.telemetryView.update(snapshot);
        if (this.processView) this.processView.update(snapshot);
      }).catch(() => {});
    }

    if (window.terminalApi && typeof window.terminalApi.getCwd === 'function') {
      window.terminalApi.getCwd().then((cwd) => {
        if (cwd && this.directoryTree) this.directoryTree.loadDirectory(cwd);
      }).catch(() => {});
    }

    this._startDrivePolling();
  }

  /**
   * Drive capacity changes slowly: refresh every 20 s (and right away).
   * @private
   */
  _startDrivePolling() {
    if (!window.systemApi || typeof window.systemApi.getDrives !== 'function' || this.drivesTimer) return;
    let busy = false;
    const refresh = () => {
      if (busy) return;
      busy = true;
      window.systemApi.getDrives()
        .then((drives) => { if (this.telemetryView) this.telemetryView.updateDrives(drives); })
        .catch(() => {})
        .finally(() => { busy = false; });
    };
    refresh();
    this.drivesTimer = setInterval(refresh, 20000);
  }

  /** Open (or close) the command palette. */
  openPalette() {
    if (this.commandPalette) this.commandPalette.open();
  }

  /**
   * Ctrl+Shift+P also works while focus is outside the terminal (process
   * filter, directory panel ...). Inside the terminal xterm handles it.
   * @private
   */
  _bindGlobalShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || String(e.key).toLowerCase() !== 'p') return;
      const inTerminal = e.target && typeof e.target.closest === 'function' && e.target.closest('#terminal-host');
      if (inTerminal) return;
      e.preventDefault();
      this.openPalette();
    });
  }

  /**
   * Start the signature intro, or reveal the interface right away.
   * @private
   */
  _initBootSequence() {
    const BootSequenceClass = (typeof window !== 'undefined' && window.BootSequence) ? window.BootSequence : null;

    if (BootSequenceClass && this.dom.bootOverlay) {
      this.bootSequence = new BootSequenceClass({
        containerId: 'boot-overlay',
        onComplete: () => this.activateHud(),
        onSkip: () => this.activateHud()
      });

      this.bootSequence.init();
      this.bootSequence.start().catch((err) => {
        console.warn('[App] Boot sequence startup error:', err);
        this.activateHud();
      });
    } else {
      this.activateHud();
    }
  }

  /**
   * Intro finished: hide the overlay and hand the keyboard to the terminal.
   * The interface itself is already live.
   */
  activateHud() {
    if (this.isHudActive) return;
    this.isHudActive = true;
    this._perf('hud-active');

    if (this.dom.bootOverlay && this.dom.bootOverlay.classList) {
      this.dom.bootOverlay.classList.add('boot-hidden');
    }

    if (this.terminalView) {
      // The layout may have settled after the terminal was created.
      this.terminalView.fit();
      this.terminalView.focus();
    }
  }

  /**
   * Replay the intro on demand (`/xyron boot preview`).
   */
  replayBoot() {
    const BootSequenceClass = (typeof window !== 'undefined' && window.BootSequence) ? window.BootSequence : null;
    if (!BootSequenceClass || !this.dom.bootOverlay) return;

    this.dom.bootOverlay.classList.remove('boot-hidden', 'boot-fade-out');
    const replay = new BootSequenceClass({
      containerId: 'boot-overlay',
      onComplete: () => this.dom.bootOverlay.classList.add('boot-hidden'),
      onSkip: () => this.dom.bootOverlay.classList.add('boot-hidden')
    });
    replay.init();
    replay.start().catch(() => this.dom.bootOverlay.classList.add('boot-hidden'));
  }

  /** @private */
  _bindConfigReplay() {
    if (!window.xyronConfig || typeof window.xyronConfig.onBootUpdate !== 'function') return;
    window.xyronConfig.onBootUpdate((payload) => {
      if (payload && payload.replay) this.replayBoot();
    });
  }

  // -------------------------------------------------------------------------
  // Live theme
  // -------------------------------------------------------------------------

  /**
   * @param {string} hex
   * @returns {string|null} normalized #rrggbb, or null when invalid
   * @private
   */
  _normalizeHex(hex) {
    let s = String(hex == null ? '' : hex).trim();
    if (!s) return null;
    if (s[0] !== '#') s = '#' + s;
    if (/^#[0-9a-fA-F]{3}$/.test(s)) s = '#' + s.slice(1).split('').map((c) => c + c).join('');
    return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null;
  }

  /** @private */
  _rgbTriplet(hex) {
    const n = parseInt(hex.slice(1), 16);
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  }

  /**
   * Recolor the ENTIRE interface from one background + one text color. Every
   * surface, line, label and bar in the stylesheet is derived from these two
   * values, so a single call restyles everything (and the terminal with it).
   *
   * @param {{ bgColor: string, fgColor: string }} theme
   */
  applyTheme(theme) {
    if (!theme || typeof theme !== 'object') return;
    const bg = this._normalizeHex(theme.bgColor);
    const fg = this._normalizeHex(theme.fgColor);
    if (!bg || !fg) return;
    this._lastTheme = { bgColor: bg, fgColor: fg };

    const root = (typeof document !== 'undefined') ? document.documentElement : null;
    if (root && root.style && typeof root.style.setProperty === 'function') {
      root.style.setProperty('--bg', bg);
      root.style.setProperty('--fg', fg);
      root.style.setProperty('--bg-rgb', this._rgbTriplet(bg));
      root.style.setProperty('--fg-rgb', this._rgbTriplet(fg));
    }

    if (this.terminalView && typeof this.terminalView.setColors === 'function') {
      this.terminalView.setColors({ bg, fg });
    }

    // The sparkline is a canvas: repaint it so it picks up the new colors.
    if (this.telemetryView && typeof this.telemetryView._drawSparkline === 'function') {
      try { this.telemetryView._drawSparkline(); } catch (_e) {}
    }
  }

  /**
   * Load the saved theme and follow live updates from `color` / `/xyron theme`.
   * @private
   */
  _bindThemeUpdates() {
    if (!window.xyronConfig) return;

    if (typeof window.xyronConfig.getTheme === 'function') {
      window.xyronConfig.getTheme().then((theme) => {
        if (theme) this.applyTheme(theme);
      }).catch(() => {});
    }

    if (typeof window.xyronConfig.onThemeUpdate === 'function') {
      this.unsubscribeTheme = window.xyronConfig.onThemeUpdate((payload) => {
        if (payload && payload.theme) this.applyTheme(payload.theme);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Window controls & privilege badge
  // -------------------------------------------------------------------------

  /** @private */
  _bindWindowControls() {
    if (!window.windowApi) return;

    if (this.dom.btnWinMin) {
      this.dom.btnWinMin.addEventListener('click', () => window.windowApi.minimize());
    }
    if (this.dom.btnWinMax) {
      this.dom.btnWinMax.addEventListener('click', () => window.windowApi.maximize());
    }
    if (this.dom.btnWinClose) {
      this.dom.btnWinClose.addEventListener('click', () => window.windowApi.close());
    }
  }

  /**
   * Privilege badge: ADMIN when the app runs elevated, USER otherwise; a trailing
   * "OP" marks persistent elevated mode (/op-unlock).
   * @private
   */
  _bindElevationStatus() {
    const updateOpBadge = (status) => {
      if (!this.dom.opBadge || !status) return;

      const unlocked = status.unlocked === true;
      const elevated = status.elevated === true;
      const label = elevated ? 'ADMIN' : (status.elevated === false ? 'USER' : 'STANDARD');

      this.dom.opBadge.className =
        'op-badge ' + (elevated ? 'op-admin' : 'op-user') + (unlocked ? ' op-unlocked' : '');
      this.dom.opBadge.textContent = unlocked ? `${label} · OP` : label;
      this.dom.opBadge.title = elevated
        ? 'Yonetici yetkisiyle calisiyor' + (unlocked ? ' (OP kilidi acik)' : '')
        : 'Standart kullanici modu. /op <komut> ile yonetici yetkisi istenir.';
    };

    if (window.elevationApi && typeof window.elevationApi.onStatus === 'function') {
      this.unsubscribeElevation = window.elevationApi.onStatus(updateOpBadge);
    }
    if (window.elevationApi && typeof window.elevationApi.getStatus === 'function') {
      window.elevationApi.getStatus().then(updateOpBadge).catch(() => {});
    }
  }

  /**
   * Teardown listeners and views.
   */
  destroy() {
    if (this.drivesTimer) { clearInterval(this.drivesTimer); this.drivesTimer = null; }
    ['unsubscribeTelemetry', 'unsubscribeElevation', 'unsubscribeTheme'].forEach((k) => {
      if (typeof this[k] === 'function') { this[k](); this[k] = null; }
    });
    if (this.telemetryView) this.telemetryView.destroy();
    if (this.terminalView) this.terminalView.destroy();
    if (this.directoryTree) this.directoryTree.destroy();
  }
}

if (typeof window !== 'undefined') {
  window.XyronCenterApp = XyronCenterApp;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = XyronCenterApp;
}
