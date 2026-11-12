/**
 * XYRON CENTER - Signature Boot Intro
 * File: src/renderer/js/boot-sequence.js
 *
 * Minimal, human-feeling cold-start intro: a pure black screen on which the
 * word "Xyron" is drawn left-to-right like a handwritten signature, then
 * "center" is signed beneath it in the same script. A short hold, then a clean
 * fade into the live HUD. No POST-log spam, no RGB glitch, no radar - just the
 * signature. ESC / SPACE skips instantly.
 *
 * Public API is unchanged (init / start / skip / onComplete / onSkip) so the
 * app coordinator keeps working as-is.
 */

class BootSequence {
  constructor(options = {}) {
    this.containerId = options.containerId || 'boot-overlay';
    this.container = document.getElementById(this.containerId);
    this.onComplete = options.onComplete || (() => {});
    this.onSkip = options.onSkip || (() => {});

    this.audio = options.audio || (window.BootAudio ? new window.BootAudio() : null);
    this.isRunning = false;
    this.isSkipped = false;
    this.isFinished = false;

    // Config (driven by /xyron boot ... terminal commands). Shipped defaults
    // mirror src/main/config-store.js. The signature itself is always white on
    // black per design; accentColor only tints the thin hairline flourish.
    this.cfg = options.config || {
      enabled: true,
      durationMs: 1500,
      logoText: 'Xyron',
      subText: 'center',
      accentColor: '#00f3ff',
      sound: true,
      crtScanlines: true,
      skipHint: true
    };
    this.scale = 1;

    this.timers = [];
    this._boundKeyDown = this._handleKeyDown.bind(this);
  }

  /**
   * Build DOM and register the global skip (ESC / SPACE) listener.
   */
  init() {
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.id = this.containerId;
      this.container.className = 'boot-overlay';
      document.body.appendChild(this.container);
    }
    this._buildMarkup();
    window.addEventListener('keydown', this._boundKeyDown, { capture: true });
  }

  /**
   * Inject the signature markup into the overlay.
   * @private
   */
  _buildMarkup() {
    this.container.innerHTML = `
      <div class="boot-sign-wrap">
        <div class="boot-sign boot-sign-primary" id="boot-sign-primary">
          <span class="boot-sign-text">Xyron</span>
          <span class="boot-sign-mask"></span>
          <span class="boot-sign-nib"></span>
        </div>
        <div class="boot-sign boot-sign-secondary" id="boot-sign-secondary">
          <span class="boot-sign-text">center</span>
          <span class="boot-sign-mask"></span>
          <span class="boot-sign-nib"></span>
        </div>
        <div class="boot-sign-rule" id="boot-sign-rule"></div>
      </div>
      <div class="boot-skip-hint" id="boot-skip-hint">
        <span class="skip-key">ESC</span> / <span class="skip-key">SPACE</span>
      </div>
    `;

    this.primary = this.container.querySelector('#boot-sign-primary');
    this.secondary = this.container.querySelector('#boot-sign-secondary');
    this.rule = this.container.querySelector('#boot-sign-rule');
  }

  /**
   * Load persisted boot config from the main process (falls back to defaults).
   * @private
   */
  async _loadConfig() {
    try {
      if (window.xyronConfig && typeof window.xyronConfig.getBoot === 'function') {
        const cfg = await window.xyronConfig.getBoot();
        if (cfg && typeof cfg === 'object') {
          this.cfg = Object.assign({}, this.cfg, cfg);
        }
      }
    } catch (_e) { /* keep defaults */ }
  }

  /**
   * Apply config to the signature DOM: custom words, accent hairline, skip hint.
   * @private
   */
  _applyConfig() {
    const cfg = this.cfg || {};
    if (!this.container) return;

    const primaryText = this.container.querySelector('.boot-sign-primary .boot-sign-text');
    const secondaryText = this.container.querySelector('.boot-sign-secondary .boot-sign-text');
    if (primaryText && cfg.logoText) primaryText.textContent = cfg.logoText;
    if (secondaryText && typeof cfg.subText === 'string' && cfg.subText.trim()) {
      secondaryText.textContent = cfg.subText;
    }

    const accent = this._normalizeHex(cfg.accentColor);
    if (accent && this.rule) {
      this.rule.style.background = accent;
      this.rule.style.boxShadow = `0 0 12px ${this._hexToRgba(accent, 0.6)}`;
    }

    if (cfg.skipHint === false) {
      const hint = this.container.querySelector('#boot-skip-hint');
      if (hint) hint.style.display = 'none';
    }
  }

  /**
   * Set a CSS custom property on the overlay (tolerant of minimal DOM shims).
   * @private
   */
  _setVar(name, value) {
    const style = this.container && this.container.style;
    if (!style) return;
    if (typeof style.setProperty === 'function') style.setProperty(name, value);
    else style[name] = value;
  }

  _normalizeHex(v) {
    let s = String(v == null ? '' : v).trim();
    if (!s) return null;
    if (s[0] !== '#') s = '#' + s;
    if (/^#[0-9a-fA-F]{3}$/.test(s)) s = '#' + s.slice(1).split('').map((c) => c + c).join('');
    return /^#[0-9a-fA-F]{6}$/.test(s) ? s : null;
  }

  _hexToRgba(hex, alpha) {
    const h = this._normalizeHex(hex) || '#00f3ff';
    const r = parseInt(h.slice(1, 3), 16);
    const g = parseInt(h.slice(3, 5), 16);
    const b = parseInt(h.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /**
   * Run the signature intro. Total length scales with cfg.durationMs (base 2600ms).
   */
  async start() {
    if (this.isRunning || this.isFinished) return;
    this.isRunning = true;

    await this._loadConfig();

    // The user may have skipped (ESC) while the config was loading: schedule nothing.
    if (this.isSkipped || this.isFinished) return;
    this._applyConfig();

    // Intro disabled -> straight to HUD.
    if (this.cfg && this.cfg.enabled === false) {
      this.isFinished = true;
      if (this.container) this.container.classList.add('boot-hidden');
      this._cleanup();
      this.onComplete();
      return;
    }

    // Base timeline is authored at 1500ms; durationMs scales both the timers
    // and the CSS reveal durations so a longer/shorter intro stays in sync.
    const BASE_MS = 1500;
    const dur = (this.cfg && Number(this.cfg.durationMs)) || BASE_MS;
    this.scale = Math.max(0.25, Math.min(6, dur / BASE_MS));
    this._setVar('--sign-primary-dur', `${Math.round(620 * this.scale)}ms`);
    this._setVar('--sign-secondary-dur', `${Math.round(480 * this.scale)}ms`);
    this._setVar('--sign-rule-dur', `${Math.round(320 * this.scale)}ms`);

    if (this.cfg && this.cfg.sound === false) this.audio = null;
    // Audio resume must never delay the visuals.
    if (this.audio && typeof this.audio.resume === 'function') {
      try { Promise.resolve(this.audio.resume()).catch(() => {}); } catch (_e) {}
    }

    // Phase 1: sign "Xyron" (white, left-to-right).
    this._schedule(() => {
      if (this.primary) this.primary.classList.add('signing');
      if (this.audio && typeof this.audio.playRelayClick === 'function') {
        try { this.audio.playRelayClick(0); } catch (_e) {}
      }
    }, 80);

    // Phase 2: sign "center" beneath it.
    this._schedule(() => {
      if (this.secondary) this.secondary.classList.add('signing');
      if (this.audio && typeof this.audio.playRelayClick === 'function') {
        try { this.audio.playRelayClick(0); } catch (_e) {}
      }
    }, 620);

    // Phase 3: draw the hairline rule and settle.
    this._schedule(() => {
      if (this.rule) this.rule.classList.add('drawn');
      if (this.audio && typeof this.audio.playPostBeep === 'function') {
        try { this.audio.playPostBeep(0); } catch (_e) {}
      }
    }, 1060);

    // Completion -> fade to HUD.
    this._schedule(() => this._finish(), BASE_MS);
  }

  _handleKeyDown(e) {
    if (this.isFinished) return;
    if (e.key === 'Escape' || e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      e.stopPropagation();
      this.skip();
    }
  }

  /**
   * Instantly end the intro and reveal the HUD.
   */
  skip() {
    if (this.isSkipped || this.isFinished) return;
    this.isSkipped = true;
    if (this.audio && typeof this.audio.skip === 'function') {
      try { this.audio.skip(); } catch (_e) {}
    }
    this._clearAllTimers();
    if (this.container) this.container.classList.add('boot-hidden');
    this._cleanup();
    this.onSkip();
    this.onComplete();
  }

  /**
   * Natural completion with a short fade.
   * @private
   */
  _finish() {
    if (this.isFinished || this.isSkipped) return;
    this.isFinished = true;
    if (this.container) {
      this.container.classList.add('boot-fade-out');
      setTimeout(() => {
        if (this.container) this.container.classList.add('boot-hidden');
        this._cleanup();
        this.onComplete();
      }, 220);
    } else {
      this._cleanup();
      this.onComplete();
    }
  }

  _cleanup() {
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('keydown', this._boundKeyDown, { capture: true });
    }
    this._clearAllTimers();
    if (window.terminalView && typeof window.terminalView.focus === 'function') {
      window.terminalView.focus();
    } else if (window.terminalApi && typeof window.terminalApi.focus === 'function') {
      window.terminalApi.focus();
    }
  }

  _schedule(fn, delayMs) {
    const handle = setTimeout(fn, delayMs * (this.scale || 1));
    this.timers.push(handle);
    return handle;
  }

  _clearAllTimers() {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
  }
}

if (typeof window !== 'undefined') {
  window.BootSequence = BootSequence;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BootSequence;
}
