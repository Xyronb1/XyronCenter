/**
 * XYRON CENTER - /op-system + /sudo tests
 * Run: node tests/test-op-system.js
 *
 * Verifies the /sudo alias and that /op-system degrades gracefully to the
 * administrator executor when a SYSTEM task cannot be created (e.g. when this
 * test process is not elevated).
 */
'use strict';

const assert = require('assert');
const path = require('path');
const ElevationDaemon = require(path.join(__dirname, '..', 'src', 'main', 'elevation-daemon'));

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; } else { fail++; console.error(`  FAIL: ${name}`); }
}

// --- /sudo alias recognition ---
const d = new ElevationDaemon({});
check('/sudo whoami is an op command', d.isOpCommand('/sudo whoami') === true);
check('/sudo bare is an op command', d.isOpCommand('/sudo') === true);
check('/op-system <cmd> is an op command', d.isOpCommand('/op-system whoami') === true);
check('plain text is not an op command', d.isOpCommand('echo hi') === false);

// --- /sudo <cmd> routes to the elevated executor ---
let subCalled = null;
const d2 = new ElevationDaemon({});
d2.writeToTerminal = () => {};
d2.restorePrompt = () => {};
d2.executeSubCommand = (cmd) => { subCalled = cmd; };
d2.executeOpCommand('/sudo echo merhaba');
check('/sudo echo routes to executeSubCommand', subCalled === 'echo merhaba');

// --- /op-system falls back to executeSubCommand when SYSTEM task fails ---
// (This test process is typically not elevated, so schtasks /ru SYSTEM fails
//  and the command must still run via the administrator executor.)
const d3 = new ElevationDaemon({});
d3.writeToTerminal = () => {};
d3.restorePrompt = () => {};
let fellBack = false;
d3.executeSubCommand = (cmd, cb) => {
  fellBack = (cmd === 'whoami');
  if (typeof cb === 'function') cb(0, null);
};
d3.executeAsSystem('whoami');

setTimeout(() => {
  check('/op-system degrades to executeSubCommand when not elevated', fellBack === true);
  console.log(`\nop-system: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}, 6000);
