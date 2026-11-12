/**
 * XYRON CENTER - `color` command parser tests
 * Run: node tests/test-color-command.js
 */
'use strict';

const path = require('path');
const { parseColorCommand, isColorCommand, PALETTE, DEFAULT_THEME } =
  require(path.join(__dirname, '..', 'src', 'main', 'color-command'));

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; } else { fail++; console.error(`  FAIL: ${name}`); }
}

// --- recognition ---
check('"color" is a color command', isColorCommand('color') === true);
check('"COLOR a" (case-insensitive)', isColorCommand('  COLOR a ') === true);
check('"colorful" is NOT a color command', isColorCommand('colorful') === false);
check('"echo color a" is NOT a color command', isColorCommand('echo color a') === false);
check('empty is not a color command', isColorCommand('') === false);
check('non-color returns null', parseColorCommand('dir') === null);

// --- reset ---
const reset = parseColorCommand('color');
check('bare color resets', reset && reset.ok && reset.action === 'reset');

// --- single digit: text color, black background ---
const a = parseColorCommand('color a');
check('color a ok', a && a.ok && a.action === 'set');
check('color a bg is black', a.bg === '#000000');
check('color a fg is light green', a.fg === PALETTE.a.hex);

const c = parseColorCommand('color C'); // uppercase hex digit
check('color C (uppercase) fg is light red', c.fg === PALETTE.c.hex && c.bg === '#000000');

// --- two digits: background then text ---
const f0 = parseColorCommand('color f0');
check('color f0 white background', f0.bg === '#ffffff');
check('color f0 black text', f0.fg === '#000000');
const bf = parseColorCommand('color 1f');
check('color 1f blue background, white text', bf.bg === PALETTE['1'].hex && bf.fg === '#ffffff');

// --- same color is rejected (like cmd.exe) ---
const same = parseColorCommand('color aa');
check('color aa rejected', same && same.ok === false);
const sameZero = parseColorCommand('color 00');
check('color 00 rejected', sameZero && sameZero.ok === false);

// --- hex form ---
const hex = parseColorCommand('color #ff8800');
check('color #ff8800 sets fg', hex.ok && hex.fg === '#ff8800' && hex.bg === '#000000');
const hex3 = parseColorCommand('color #f80');
check('color #f80 expands to #ff8800', hex3.fg === '#ff8800');

// --- help ---
check('color ? is help', parseColorCommand('color ?').action === 'help');
check('color /? is help', parseColorCommand('color /?').action === 'help');

// --- invalid input ---
check('color zz rejected', parseColorCommand('color zz').ok === false);
check('color 123 rejected', parseColorCommand('color 123').ok === false);
check('color #12 rejected', parseColorCommand('color #12').ok === false);

// --- default theme is pure black / pure white ---
check('default bg pure black', DEFAULT_THEME.bg === '#000000');
check('default fg pure white', DEFAULT_THEME.fg === '#ffffff');

console.log(`\ncolor-command: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
