/**
 * XYRON CENTER - End-to-end test: real ConPTY + real PowerShell
 * Run: node tests/test-e2e-passthrough.js
 *
 * Drives PtyManager + ElevationDaemon exactly like the app does (keystrokes in,
 * output out) and verifies that /op, /sudo and /cmd are typed into the REAL shell
 * (output arrives through ConPTY, nothing injected out-of-band), that CMD syntax
 * works, and that `color a` is silent.
 *
 * The daemon is told `elevated: true` so the elevated code path is exercised
 * without ever raising a UAC prompt.
 */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const PtyManager = require(path.join(__dirname, '..', 'src', 'main', 'pty-manager'));
const ElevationDaemon = require(path.join(__dirname, '..', 'src', 'main', 'elevation-daemon'));
const ConfigStore = require(path.join(__dirname, '..', 'src', 'main', 'config-store'));
const TerminalView = require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'terminal-view'));
const TelemetryView = require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'telemetry-view'));

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; } else { fail++; console.error(`  FAIL: ${name}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => s
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC
  .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')          // CSI
  .replace(/\x1b./g, '');

async function waitFor(pred, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(40);
  }
  console.error(`  (timeout waiting for: ${label})`);
  return false;
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'xyron-e2e-'));
  const store = new ConfigStore({ filePath: path.join(work, 'cfg.json') });

  const daemon = new ElevationDaemon({
    configStore: store,
    elevated: true,        // exercise the elevated path with no UAC prompt
    passThrough: true,
    cwd: work
  });
  const mgr = new PtyManager({
    elevationDaemon: daemon,
    cwd: work,
    shellType: 'powershell',
    helperDir: work,
    cols: 140,
    rows: 40
  });

  let raw = '';
  mgr.on('data', (d) => { raw += d; });

  // Collect theme broadcasts the daemon emits for `color`.
  const themes = [];
  daemon.on('theme', (p) => themes.push(p.theme));

  // Pure units: ESC mapping, (op) tagging, live clock format.
  check('ESC maps to DEL on the normal screen', TerminalView.mapInput('\x1b') === '\x7f');
  check('ESC stays ESC in full-screen apps', TerminalView.mapInput('\x1b', true) === '\x1b');
  check('arrow keys / Alt combos untouched', TerminalView.mapInput('\x1b[A') === '\x1b[A' && TerminalView.mapInput('\x1bx') === '\x1bx');
  check('tag appended as a comment', daemon._tagShellLine('whoami', 'op') === 'whoami  # (op)');
  check('no tag -> line unchanged', daemon._tagShellLine('whoami') === 'whoami');
  check('backtick continuation not tagged', daemon._tagShellLine('Get-Item `', 'op') === 'Get-Item `');
  check('clock format HH:MM:SS.mmm', TelemetryView.formatClock(new Date(2026, 0, 2, 3, 4, 5, 7)) === '03:04:05.007');

  mgr.init();
  check('helper script was written', !!mgr.helperPath && fs.existsSync(mgr.helperPath));

  const prompted = await waitFor(() => raw.includes('XYRON '), 25000, 'first XYRON prompt');
  check('shell started and printed the XYRON prompt', prompted);
  if (!prompted) { mgr.destroy(); return finish(); }
  await sleep(600);

  async function type(line) {
    for (const ch of line) { mgr.handleInput(ch); await sleep(6); }
    mgr.handleInput('\r');
  }
  const mark = () => raw.length;
  const since = (m) => stripAnsi(raw.slice(m));
  const lines = (s) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  check('daemon sees helpers loaded', daemon._helpersAvailable === true);
  check('pass-through is active', daemon._shellPassThroughActive() === true);

  // 1) /op with PowerShell syntax -> runs natively in the shell.
  let m = mark();
  await type('/op Write-Output pass-through-ok');
  await waitFor(() => lines(since(m)).includes('pass-through-ok'), 15000, '/op ps output');
  let out = since(m);
  check('/op <powershell> output arrives through the shell', lines(out).includes('pass-through-ok'));
  check('/op injects no "[OP EXEC" banner (nothing out-of-band)', !/\[OP EXEC/.test(out));
  check('/op line is echoed with the "(op)" tag', /Write-Output pass-through-ok\s+# \(op\)/.test(out));

  // 1b) ESC deletes ONE character (mapped to DEL like Backspace), even inside /op.
  m = mark();
  for (const ch of '/op Write-Output escXX') { mgr.handleInput(ch); await sleep(6); }
  mgr.handleInput(TerminalView.mapInput('\x1b'));
  await sleep(30);
  mgr.handleInput(TerminalView.mapInput('\x1b'));
  await sleep(30);
  for (const ch of 'ok') { mgr.handleInput(ch); await sleep(6); }
  mgr.handleInput('\r');
  await waitFor(() => lines(since(m)).includes('escok'), 15000, 'ESC-as-backspace output');
  out = since(m);
  check('two ESC presses removed exactly two letters (escXX -> escok)', lines(out).includes('escok'));
  check('ESC did not wipe the /op line (still ran via /op)', /# \(op\)/.test(out));

  // 1c) A normal command: ESC removes one letter, no (op) tag.
  m = mark();
  for (const ch of 'Write-Output plainQ') { mgr.handleInput(ch); await sleep(6); }
  mgr.handleInput(TerminalView.mapInput('\x1b'));
  await sleep(30);
  mgr.handleInput('1');
  mgr.handleInput('\r');
  await waitFor(() => lines(since(m)).includes('plain1'), 15000, 'plain ESC output');
  out = since(m);
  check('ESC on a normal command deletes one letter', lines(out).includes('plain1'));
  check('normal commands carry no (op) tag', !/\(op\)/.test(out));

  // 2) /sudo alias.
  m = mark();
  await type('/sudo Write-Output sudo-alias-ok');
  await waitFor(() => lines(since(m)).includes('sudo-alias-ok'), 15000, '/sudo output');
  check('/sudo alias works', lines(since(m)).includes('sudo-alias-ok'));

  // 3) CMD syntax auto-routed to cmd.exe: &&, %VAR%.
  m = mark();
  await type('/op echo first && echo user=%USERNAME%');
  const expectUser = `user=${process.env.USERNAME}`;
  await waitFor(() => lines(since(m)).includes(expectUser), 15000, 'cmd-routed output');
  out = since(m);
  check('CMD && chaining ran in cmd.exe', lines(out).includes('first'));
  check('CMD %VAR% expanded by cmd.exe', lines(out).includes(expectUser));

  // 4) Explicit /cmd and /ps prefixes.
  m = mark();
  await type('/cmd for /l %i in (1,1,3) do @echo n%i');
  await waitFor(() => lines(since(m)).includes('n3'), 15000, '/cmd for loop');
  out = since(m);
  check('/cmd runs a for /l loop', ['n1', 'n2', 'n3'].every((x) => lines(out).includes(x)));

  m = mark();
  await type('/ps Write-Output ps-prefix-ok');
  await waitFor(() => lines(since(m)).includes('ps-prefix-ok'), 15000, '/ps output');
  check('/ps prefix works', lines(since(m)).includes('ps-prefix-ok'));

  // 5) Turkish characters survive the whole round trip.
  m = mark();
  await type('/op Write-Output "günaydın çğşıöü"');
  await waitFor(() => lines(since(m)).some((l) => l === 'günaydın çğşıöü'), 15000, 'turkish output');
  check('Turkish characters round-trip intact', lines(since(m)).includes('günaydın çğşıöü'));

  // 6) Output stays in order and does not overwrite itself: run several in a row.
  m = mark();
  for (const n of [1, 2, 3, 4, 5]) { await type(`/op Write-Output seq-${n}`); await sleep(250); }
  await waitFor(() => lines(since(m)).includes('seq-5'), 20000, 'sequence');
  const seq = lines(since(m)).filter((l) => /^seq-\d$/.test(l));
  check('five consecutive commands all printed, in order', seq.join(',') === 'seq-1,seq-2,seq-3,seq-4,seq-5');

  // 7) `color a`: intercepted, silent, theme broadcast.
  m = mark();
  const themeCount = themes.length;
  await type('color a');
  await sleep(700);
  check('color a changed the theme', themes.length === themeCount + 1 && themes[themes.length - 1].fgColor === '#2bff4f');
  check('color a left the shell prompt usable (no error text)', !/not recognized|CommandNotFound|color :/i.test(since(m)));

  // 8) A normal command is untouched.
  m = mark();
  await type('Write-Output normal-ok');
  await waitFor(() => lines(since(m)).includes('normal-ok'), 15000, 'normal command');
  check('ordinary commands still run normally', lines(since(m)).includes('normal-ok'));

  mgr.destroy();
  try { fs.rmSync(work, { recursive: true, force: true }); } catch (_e) {}
  finish();
}

function finish() {
  console.log(`\ne2e-passthrough: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('E2E crashed:', e); process.exit(1); });
