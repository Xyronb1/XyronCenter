/**
 * XYRON CENTER - CMD-style `color` command parser
 * File: src/main/color-command.js
 *
 * Mirrors the Windows `color` built-in so muscle memory works inside the HUD:
 *
 *   color            -> restore the default theme (black background, white text)
 *   color a          -> one hex digit = text color, background black
 *   color 0a         -> two hex digits = background first, then text
 *   color f0         -> white background, black text
 *   color #ff8800    -> arbitrary text color (hex), background black
 *   color ?          -> list the 16 color codes
 *
 * Pure and dependency-free (no Electron, no child_process) so it is trivially
 * unit-testable. The result is a plain object the daemon turns into a theme.
 */

'use strict';

/** The 16 console color slots. Values are tuned to read well on pure black. */
const PALETTE = {
  '0': { name: 'Siyah',        hex: '#000000' },
  '1': { name: 'Mavi',         hex: '#3b6cff' },
  '2': { name: 'Yesil',        hex: '#13c13b' },
  '3': { name: 'Su yesili',    hex: '#27b3d6' },
  '4': { name: 'Kirmizi',      hex: '#e0242e' },
  '5': { name: 'Mor',          hex: '#a238c8' },
  '6': { name: 'Sari',         hex: '#d9b400' },
  '7': { name: 'Acik gri',     hex: '#cfcfcf' },
  '8': { name: 'Gri',          hex: '#7a7a7a' },
  '9': { name: 'Acik mavi',    hex: '#5b8cff' },
  'a': { name: 'Acik yesil',   hex: '#2bff4f' },
  'b': { name: 'Acik su yesili', hex: '#5ff3ff' },
  'c': { name: 'Acik kirmizi', hex: '#ff4b57' },
  'd': { name: 'Acik mor',     hex: '#ff5fd7' },
  'e': { name: 'Acik sari',    hex: '#fff35c' },
  'f': { name: 'Beyaz',        hex: '#ffffff' }
};

const DEFAULT_THEME = { bg: '#000000', fg: '#ffffff' };

/**
 * @param {string} line - raw terminal line
 * @returns {boolean} true when the line is a `color` command
 */
function isColorCommand(line) {
  if (!line || typeof line !== 'string') return false;
  return /^color(\s|$)/i.test(line.trim());
}

/**
 * Parse a `color ...` line.
 *
 * @param {string} line
 * @returns {null
 *   | { ok: true, action: 'reset' }
 *   | { ok: true, action: 'help' }
 *   | { ok: true, action: 'set', bg: string, fg: string }
 *   | { ok: false, message: string }}
 *   null when the line is not a color command at all.
 */
function parseColorCommand(line) {
  if (!isColorCommand(line)) return null;

  const arg = line.trim().replace(/^color/i, '').trim();

  if (arg === '') return { ok: true, action: 'reset' };
  if (arg === '?' || arg === '/?' || /^(help|liste|list)$/i.test(arg)) {
    return { ok: true, action: 'help' };
  }

  // color #rrggbb  /  color #rgb  -> custom text color on black.
  const hexMatch = arg.match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (arg[0] === '#' && hexMatch) {
    let h = hexMatch[1].toLowerCase();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return { ok: true, action: 'set', bg: DEFAULT_THEME.bg, fg: '#' + h };
  }

  // color X / color XY  (hex digits only)
  if (!/^[0-9a-f]{1,2}$/i.test(arg)) {
    return {
      ok: false,
      message: `Gecersiz renk: "${arg}". Ornek: color a, color f0, color #ff8800 (liste: color ?)`
    };
  }

  const digits = arg.toLowerCase();
  const bgKey = digits.length === 2 ? digits[0] : '0';
  const fgKey = digits.length === 2 ? digits[1] : digits[0];

  if (bgKey === fgKey) {
    return { ok: false, message: 'Zemin ve yazi ayni renk olamaz (okunmaz).' };
  }

  return { ok: true, action: 'set', bg: PALETTE[bgKey].hex, fg: PALETTE[fgKey].hex };
}

/**
 * Human-readable color table for `color ?`.
 * @returns {string[]} lines (no ANSI codes)
 */
function describePalette() {
  return Object.keys(PALETTE).map((k) => `  ${k.toUpperCase()}  ${PALETTE[k].name}`);
}

module.exports = {
  PALETTE,
  DEFAULT_THEME,
  isColorCommand,
  parseColorCommand,
  describePalette
};
