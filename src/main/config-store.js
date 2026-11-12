/**
 * XYRON CENTER - Persistent Configuration Store
 * File: src/main/config-store.js
 *
 * Lightweight JSON-backed settings store for user-customizable subsystems.
 * Primary use: the cinematic boot sequence, which is fully customizable from
 * inside the terminal via `/xyron boot ...` commands.
 *
 * - Persists to <userData>/xyron-config.json under Electron, or <home>/.xyron-center/xyron-config.json
 *   when running headless (tests / pure Node), so the module never hard-depends on Electron.
 * - Zero external dependencies.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Default, shipped configuration. These are the values a fresh install boots with.
 */
const DEFAULT_CONFIG = {
  boot: {
    enabled: true,          // play the signature intro at all
    durationMs: 1500,       // total length of the intro timeline (500..15000)
    logoText: 'Xyron',      // primary signature word
    subText: 'center',      // secondary signature word (beneath)
    accentColor: '#00f3ff', // accent hairline color under the signature
    sound: true,            // procedural Web Audio boot DSP on/off
    crtScanlines: true,     // CRT scanline + vignette overlay during boot
    skipHint: true          // show the ESC / SPACE skip hint
  },
  theme: {
    bgColor: '#000000',     // interface background (pure black by default)
    fgColor: '#ffffff'      // interface text / line color (pure white by default)
  },
  session: {
    lastCwd: ''             // terminal directory restored on the next launch
  }
};

// Named text-color presets for `/xyron theme preset <name>` (background stays black).
const THEME_PRESETS = {
  white:   '#ffffff',
  green:   '#2bff4f',
  amber:   '#ffb703',
  red:     '#ff4b57',
  cyan:    '#5ff3ff',
  magenta: '#ff5fd7',
  blue:    '#5b8cff',
  yellow:  '#fff35c'
};

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

class ConfigStore {
  /**
   * @param {Object} [options]
   * @param {string} [options.filePath] - explicit config file path (overrides auto-resolution)
   * @param {Object} [options.electronApp] - Electron app instance for userData resolution
   */
  constructor(options = {}) {
    this.filePath = options.filePath || this._resolveFilePath(options.electronApp);
    this.data = deepClone(DEFAULT_CONFIG);
    this.load();
  }

  _resolveFilePath(electronApp) {
    // Prefer Electron userData when available
    try {
      let appRef = electronApp;
      if (!appRef) {
        const electron = require('electron');
        appRef = electron && electron.app ? electron.app : null;
      }
      if (appRef && typeof appRef.getPath === 'function') {
        return path.join(appRef.getPath('userData'), 'xyron-config.json');
      }
    } catch (_e) {}

    // Headless fallback
    const dir = path.join(os.homedir() || process.cwd(), '.xyron-center');
    return path.join(dir, 'xyron-config.json');
  }

  /**
   * Load config from disk, merging over defaults so new keys always exist.
   */
  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.data = {
          boot: Object.assign(deepClone(DEFAULT_CONFIG.boot), parsed.boot || {}),
          theme: Object.assign(deepClone(DEFAULT_CONFIG.theme), parsed.theme || {}),
          session: Object.assign(deepClone(DEFAULT_CONFIG.session), parsed.session || {})
        };
      }
    } catch (_e) {
      // Corrupt file -> fall back to defaults silently
      this.data = deepClone(DEFAULT_CONFIG);
    }
    return this.data;
  }

  /**
   * Persist current config to disk (best-effort, never throws).
   */
  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
      return true;
    } catch (_e) {
      return false;
    }
  }

  /**
   * @returns {Object} a clone of the full config
   */
  getAll() {
    return deepClone(this.data);
  }

  /**
   * @returns {Object} a clone of the boot config
   */
  getBoot() {
    return deepClone(this.data.boot);
  }

  /**
   * Apply a single boot setting with validation. Returns { ok, key, value, message }.
   * @param {string} key
   * @param {*} rawValue
   */
  setBoot(key, rawValue) {
    const boot = this.data.boot;
    switch (key) {
      case 'enabled':
      case 'sound':
      case 'crtScanlines':
      case 'skipHint': {
        const v = this._coerceBool(rawValue);
        if (v === null) return { ok: false, key, message: 'expected on/off' };
        boot[key] = v;
        break;
      }
      case 'durationMs': {
        boot.durationMs = clampNumber(rawValue, 500, 15000, boot.durationMs);
        break;
      }
      case 'logoText': {
        const s = String(rawValue == null ? '' : rawValue).slice(0, 48).trim();
        if (!s) return { ok: false, key, message: 'logo text cannot be empty' };
        boot.logoText = s;
        break;
      }
      case 'subText': {
        boot.subText = String(rawValue == null ? '' : rawValue).slice(0, 96);
        break;
      }
      case 'accentColor': {
        const c = this._coerceColor(rawValue);
        if (!c) return { ok: false, key, message: 'expected a #RRGGBB hex color' };
        boot.accentColor = c;
        break;
      }
      default:
        return { ok: false, key, message: 'unknown setting' };
    }
    this.save();
    return { ok: true, key, value: boot[key] };
  }

  /**
   * Reset boot config to shipped defaults.
   */
  resetBoot() {
    this.data.boot = deepClone(DEFAULT_CONFIG.boot);
    this.save();
    return this.getBoot();
  }

  /**
   * @returns {Object} a clone of the live-theme config
   */
  getTheme() {
    return deepClone(this.data.theme);
  }

  /**
   * Apply a single live-theme setting with validation.
   * @param {string} key
   * @param {*} rawValue
   * @returns {{ ok: boolean, key: string, value?: *, message?: string }}
   */
  setTheme(key, rawValue) {
    const theme = this.data.theme;
    // Back-compat: "accentColor" / "color" meant the text color.
    const k = (key === 'accentColor' || key === 'color') ? 'fgColor' : key;
    switch (k) {
      case 'fgColor':
      case 'bgColor': {
        const c = this._coerceColor(rawValue);
        if (!c) return { ok: false, key: k, message: 'expected a #RRGGBB hex color' };
        const other = k === 'fgColor' ? theme.bgColor : theme.fgColor;
        if (c === other) {
          return { ok: false, key: k, message: 'background and text cannot be the same color' };
        }
        theme[k] = c;
        break;
      }
      default:
        return { ok: false, key, message: 'unknown setting' };
    }
    this.save();
    return { ok: true, key: k, value: theme[k] };
  }

  /**
   * Set background and text colors together (used by the `color` command).
   * @param {string} bg - #RRGGBB
   * @param {string} fg - #RRGGBB
   * @returns {{ ok: boolean, message?: string, theme?: Object }}
   */
  setThemeColors(bg, fg) {
    const b = this._coerceColor(bg);
    const f = this._coerceColor(fg);
    if (!b || !f) return { ok: false, message: 'expected #RRGGBB hex colors' };
    if (b === f) return { ok: false, message: 'background and text cannot be the same color' };
    this.data.theme.bgColor = b;
    this.data.theme.fgColor = f;
    this.save();
    return { ok: true, theme: this.getTheme() };
  }

  /**
   * Apply a named theme preset (cyan, amber, green, red, magenta, blue, white).
   * @param {string} name
   * @returns {{ ok: boolean, key: string, value?: string, message?: string }}
   */
  setThemePreset(name) {
    const key = String(name == null ? '' : name).trim().toLowerCase();
    const hex = THEME_PRESETS[key];
    if (!hex) {
      return { ok: false, key: 'preset', message: `unknown preset (try: ${Object.keys(THEME_PRESETS).join(', ')})` };
    }
    this.data.theme.fgColor = hex;
    this.data.theme.bgColor = '#000000';
    this.save();
    return { ok: true, key: 'preset', value: `${key} (${hex})` };
  }

  /**
   * Reset live theme to shipped defaults.
   */
  resetTheme() {
    this.data.theme = deepClone(DEFAULT_CONFIG.theme);
    this.save();
    return this.getTheme();
  }

  /**
   * @returns {string} the terminal directory saved at the last cd ('' if none)
   */
  getLastCwd() {
    const v = this.data.session && this.data.session.lastCwd;
    return typeof v === 'string' ? v : '';
  }

  /**
   * Remember the terminal directory for the next launch. Writes only on change.
   * @param {string} dir
   * @returns {boolean} true when the value changed and was saved
   */
  setLastCwd(dir) {
    if (typeof dir !== 'string' || !dir || dir.length > 32767) return false;
    if (!this.data.session) this.data.session = deepClone(DEFAULT_CONFIG.session);
    if (this.data.session.lastCwd === dir) return false;
    this.data.session.lastCwd = dir;
    return this.save();
  }

  _coerceBool(v) {
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toLowerCase();
    if (['on', 'true', '1', 'yes', 'ac', 'aç', 'acik', 'açık'].includes(s)) return true;
    if (['off', 'false', '0', 'no', 'kapat', 'kapali', 'kapalı'].includes(s)) return false;
    return null;
  }

  _coerceColor(v) {
    let s = String(v == null ? '' : v).trim();
    if (!s) return null;
    if (s[0] !== '#') s = '#' + s;
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(s)) {
      // expand shorthand
      return ('#' + s.slice(1).split('').map(ch => ch + ch).join('')).toLowerCase();
    }
    return null;
  }
}

module.exports = ConfigStore;
module.exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
module.exports.THEME_PRESETS = THEME_PRESETS;
