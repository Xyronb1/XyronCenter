/**
 * XYRON CENTER - Self-elevation bootstrap tests
 * Run: node tests/test-elevation-bootstrap.js
 *
 * Everything is injected/pure: this test NEVER triggers a real UAC prompt.
 */
'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const boot = require(path.join(__dirname, '..', 'src', 'main', 'elevation-bootstrap'));

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; } else { fail++; console.error(`  FAIL: ${name}`); }
}

// --- isElevated: integrity-level SIDs ---
check('High integrity -> elevated',
  boot.isElevated({ exec: () => '"Mandatory Label\\High Mandatory Level","Label","S-1-16-12288","Mandatory group"' }) === true);
check('System integrity -> elevated',
  boot.isElevated({ exec: () => '"x","y","S-1-16-16384","z"' }) === true);
check('Medium integrity -> NOT elevated',
  boot.isElevated({ exec: () => '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192","Mandatory group"' }) === false);
check('whoami failure -> NOT elevated (safe default)',
  boot.isElevated({ exec: () => { throw new Error('boom'); } }) === false);

// --- shouldSelfElevate ---
const base = { platform: 'win32', env: {}, argv: ['app.exe'], elevated: false };
check('not elevated on win32 -> self-elevate', boot.shouldSelfElevate(base) === true);
check('already elevated -> no', boot.shouldSelfElevate({ ...base, elevated: true }) === false);
check('non-windows -> no', boot.shouldSelfElevate({ ...base, platform: 'linux' }) === false);
check('relaunch marker prevents a loop',
  boot.shouldSelfElevate({ ...base, argv: ['app.exe', boot.ELEVATED_MARKER] }) === false);
check('XYRON_NO_ELEVATE opt-out', boot.shouldSelfElevate({ ...base, env: { XYRON_NO_ELEVATE: '1' } }) === false);
check('XYRON_SMOKE test mode -> no', boot.shouldSelfElevate({ ...base, env: { XYRON_SMOKE: '1' } }) === false);
check('XYRON_WINDOWED dev mode -> no', boot.shouldSelfElevate({ ...base, env: { XYRON_WINDOWED: '1' } }) === false);

// --- buildRelaunch: runas verb, marker, quoting ---
const r = boot.buildRelaunch({ exePath: "C:\\Program Files\\Xy'ron\\XyronCenter.exe", args: ['--flag'], cwd: 'C:\\Work' });
check('relaunch uses powershell.exe', r.file === 'powershell.exe');
check('relaunch uses the runas verb', /-Verb RunAs/.test(r.script));
check('relaunch passes the loop marker', r.script.includes(`'${boot.ELEVATED_MARKER}'`));
check('relaunch keeps user args', r.script.includes("'--flag'"));
check("relaunch escapes single quotes in the path", r.script.includes("Xy''ron"));
check('relaunch sets the working directory', r.script.includes("-WorkingDirectory 'C:\\Work'"));
check('relaunch is a hidden, profile-less command',
  r.args.includes('-NoProfile') && r.args.includes('Hidden') && r.args.includes('-EncodedCommand'));
const decoded = Buffer.from(r.args[r.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
check('encoded command round-trips to the script', decoded === r.script);
const dedupe = boot.buildRelaunch({ exePath: 'a.exe', args: [boot.ELEVATED_MARKER] });
check('marker is not duplicated',
  (dedupe.script.match(new RegExp(boot.ELEVATED_MARKER, 'g')) || []).length === 1);

// --- resolveRelaunchExe: portable launcher wins ---
check('portable launcher path preferred',
  boot.resolveRelaunchExe({ PORTABLE_EXECUTABLE_FILE: 'D:\\p\\X.exe' }, 'C:\\tmp\\x.exe') === 'D:\\p\\X.exe');
check('falls back to execPath', boot.resolveRelaunchExe({}, 'C:\\tmp\\x.exe') === 'C:\\tmp\\x.exe');

// --- relaunchElevated: exit code decides (injected spawn, no real process) ---
function fakeSpawn(exitCode, emitError) {
  return () => {
    const ee = new EventEmitter();
    setImmediate(() => (emitError ? ee.emit('error', new Error('nope')) : ee.emit('exit', exitCode)));
    return ee;
  };
}

(async () => {
  check('UAC accepted (exit 0) -> true',
    (await boot.relaunchElevated({ exePath: 'a.exe' }, { spawnFn: fakeSpawn(0) })) === true);
  check('UAC declined (exit 1) -> false (app stays open, limited)',
    (await boot.relaunchElevated({ exePath: 'a.exe' }, { spawnFn: fakeSpawn(1) })) === false);
  check('spawn error -> false',
    (await boot.relaunchElevated({ exePath: 'a.exe' }, { spawnFn: fakeSpawn(0, true) })) === false);
  check('spawn throwing -> false',
    (await boot.relaunchElevated({ exePath: 'a.exe' }, { spawnFn: () => { throw new Error('x'); } })) === false);

  console.log(`\nelevation-bootstrap: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
