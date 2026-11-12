/**
 * XYRON CENTER - End-to-end: informational commands print THROUGH the shell
 * Run: node tests/test-e2e-shell-messages.js
 *
 * Regression for: type "/op" + Enter, keep typing -> text drew on top of the
 * usage text. Cause: the usage was injected into the view behind ConPTY's back.
 * Now it must arrive via ConPTY (xmsg helper), with nothing injected, and the
 * next command must run normally afterwards. Also covers a multi-line paste
 * that contains an /op line (other lines used to be dropped).
 */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const PtyManager = require(path.join(__dirname, '..', 'src', 'main', 'pty-manager'));
const ElevationDaemon = require(path.join(__dirname, '..', 'src', 'main', 'elevation-daemon'));
const ConfigStore = require(path.join(__dirname, '..', 'src', 'main', 'config-store'));
const { buildMessageRecords } = require(path.join(__dirname, '..', 'src', 'main', 'shell-helpers'));

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) pass++; else { fail++; console.error(`  FAIL: ${name}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => s
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
  .replace(/\x1b./g, '');
async function waitFor(pred, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(40); }
  console.error(`  (timeout waiting for: ${label})`);
  return false;
}

async function main() {
  // Pure unit: record building.
  const rec = buildMessageRecords('/op', '\r\n\x1b[1;36m[OP]\x1b[0m Usage:\r\n  /op x\r\n');
  check('records: typed line first', rec[0] === 'T|/op');
  check('records: leading newline dropped', rec[1] === 'C|Cyan|[OP]');
  check('records: reset color', rec[2] === 'C|| Usage:' && rec[3] === 'N');
  check('records: trailing newline kept', rec[rec.length - 1] === 'N');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'xyron-msg-'));
  const store = new ConfigStore({ filePath: path.join(work, 'cfg.json') });
  const daemon = new ElevationDaemon({ configStore: store, elevated: true, passThrough: true, cwd: work });
  const mgr = new PtyManager({ elevationDaemon: daemon, cwd: work, shellType: 'powershell', helperDir: work, cols: 120, rows: 40 });

  let ptyOut = '';
  let injected = '';
  const realInject = mgr.writeToTerminal.bind(mgr);
  mgr.writeToTerminal = (t) => { injected += t; realInject(t); };

  mgr.init();
  mgr.ptyProcess.onData((d) => { ptyOut += d; });
  daemon.attachPtyManager && daemon.attachPtyManager(mgr);

  const plain = () => stripAnsi(ptyOut);
  check('prompt appears', await waitFor(() => /XYRON .*> $/m.test(plain()), 20000, 'first prompt'));

  // Type "/op" key by key, then Enter (exactly like the keyboard).
  for (const ch of '/op') mgr.handleInput(ch);
  mgr.handleInput('\r');
  check('usage arrives through ConPTY', await waitFor(() => plain().includes('In-Terminal Privilege Elevation Subsystem'), 15000, 'usage via shell'));
  check('nothing injected out-of-band', injected === '');
  check('typed /op shown after prompt', /XYRON [^\r\n]*> \/op/.test(plain()));
  check('message file cleaned up', fs.readdirSync(work).every((f) => !f.startsWith('xyron-msg-')));

  // Keep typing: the next command must run normally.
  const mark = plain().length;
  for (const ch of 'echo AFTER_OP_OK') mgr.handleInput(ch);
  mgr.handleInput('\r');
  check('next command runs after /op', await waitFor(() => /\r?\nAFTER_OP_OK/.test(plain().slice(mark)), 15000, 'echo after /op'));

  // /op whoami and color usage go the same way.
  for (const ch of '/op whoami') mgr.handleInput(ch);
  mgr.handleInput('\r');
  check('whoami via shell', await waitFor(() => plain().includes('[OP PRIVILEGE IDENTITY]'), 15000, 'whoami'));
  check('still nothing injected', injected === '');

  // Multi-line paste with an /op line in the middle: both other lines must run.
  const mark2 = plain().length;
  mgr.handleInput('echo PASTE_ONE\r/op\recho PASTE_TWO\r');
  check('paste line before /op runs', await waitFor(() => /\r?\nPASTE_ONE/.test(plain().slice(mark2)), 15000, 'PASTE_ONE'));
  check('paste line after /op runs', await waitFor(() => /\r?\nPASTE_TWO/.test(plain().slice(mark2)), 15000, 'PASTE_TWO'));

  try { mgr.destroy ? mgr.destroy() : mgr.dispose(); } catch (_e) {}
  try { fs.rmSync(work, { recursive: true, force: true }); } catch (_e) {}

  console.log(`test-e2e-shell-messages: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
