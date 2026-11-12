/**
 * Unit tests for the desktop-integration features: terminal links, path
 * quoting, log saving, drive listing, session restore, palette filtering and
 * the "put a line at the prompt" path through the pty manager + daemon.
 * Run: node tests/test-pro-features.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TerminalView = require('../src/renderer/js/terminal-view.js');
const SA = require('../src/main/system-actions.js');
const ConfigStore = require('../src/main/config-store.js');
const { resolveInitialCwd } = require('../src/main/index.js');
const Palette = require('../src/renderer/js/command-palette.js');
const PtyManager = require('../src/main/pty-manager.js');
const ElevationDaemon = require('../src/main/elevation-daemon.js');

const run = async () => {
  // --- findLinks -----------------------------------------------------------
  const texts = (s) => TerminalView.findLinks(s).map((l) => `${l.kind}:${l.text}`);
  assert.deepStrictEqual(texts('PS C:\\Users\\Xyron> '), ['path:C:\\Users\\Xyron']);
  assert.deepStrictEqual(texts('see https://example.com/a?b=1.'), ['url:https://example.com/a?b=1']);
  assert.deepStrictEqual(texts('(http://x.org/p)'), ['url:http://x.org/p']);
  assert.deepStrictEqual(texts('wiki https://en.wikipedia.org/wiki/A_(b)'), ['url:https://en.wikipedia.org/wiki/A_(b)']);
  assert.deepStrictEqual(texts('two: https://a.io and D:\\data\\x.log, end'), ['url:https://a.io', 'path:D:\\data\\x.log']);
  assert.deepStrictEqual(texts('no links here: abc:def http:// nothing'), []);
  assert.deepStrictEqual(texts('at C:/proj/src/a.js:12:5'), ['path:C:/proj/src/a.js:12:5']);
  assert.deepStrictEqual(texts('file:///C:/x'), [], 'file:// URLs are not opened');
  assert.deepStrictEqual(texts(''), []);
  assert.deepStrictEqual(texts(null), []);
  const l = TerminalView.findLinks('xx https://a.io yy')[0];
  assert.strictEqual(l.start, 3);
  assert.strictEqual(l.end, 3 + 'https://a.io'.length);

  // --- quotePath -------------------------------------------------------------
  assert.strictEqual(TerminalView.quotePath('C:\\x\\y.txt'), 'C:\\x\\y.txt');
  assert.strictEqual(TerminalView.quotePath('C:\\Program Files\\a'), "'C:\\Program Files\\a'");
  assert.strictEqual(TerminalView.quotePath("C:\\it's\\$x"), "'C:\\it''s\\$x'");
  assert.strictEqual(TerminalView.quotePath(''), '');

  // --- new shortcuts ---------------------------------------------------------
  const k = (key) => ({ type: 'keydown', key, ctrlKey: true, shiftKey: true, altKey: false, metaKey: false });
  assert.strictEqual(TerminalView.keyAction(k('S'), false), 'save-log');
  assert.strictEqual(TerminalView.keyAction(k('P'), false), 'palette');

  // --- system actions: URL + path validation --------------------------------
  assert.strictEqual(SA.isSafeExternalUrl('https://github.com/x'), true);
  assert.strictEqual(SA.isSafeExternalUrl('http://localhost:3000'), true);
  assert.strictEqual(SA.isSafeExternalUrl('file:///C:/Windows/System32/calc.exe'), false);
  assert.strictEqual(SA.isSafeExternalUrl('javascript:alert(1)'), false);
  assert.strictEqual(SA.isSafeExternalUrl('ms-settings:'), false);
  assert.strictEqual(SA.isSafeExternalUrl(42), false);
  assert.strictEqual(SA.resolveExistingPath('relative\\dir'), null);
  assert.strictEqual(SA.resolveExistingPath('C:\\a\0b'), null);
  assert.strictEqual(SA.resolveExistingPath(null), null);
  assert.strictEqual(SA.normalizeTargetPath('\\\\.\\PhysicalDrive0'), null, 'device paths are refused');
  assert.strictEqual(SA.normalizeTargetPath('\\\\?\\GLOBALROOT\\x'), null);
  assert.strictEqual(SA.normalizeTargetPath('"C:\\a" "C:\\b"'), null, 'embedded quotes are refused');
  assert.strictEqual(SA.normalizeTargetPath('C:/Windows'), 'C:\\Windows');
  assert.strictEqual(SA.resolveExistingPath(os.tmpdir()), path.resolve(os.tmpdir()));
  assert.strictEqual(SA.resolveExistingPath(`"${os.tmpdir()}"`), path.resolve(os.tmpdir()));
  assert.strictEqual(SA.resolveExistingPath(path.join(os.tmpdir(), 'nope-' + Date.now())), null);

  // --- save log ----------------------------------------------------------------
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'xyron-pro-'));
  const when = new Date(2026, 10, 9, 21, 30, 5);
  assert.strictEqual(SA.formatLogFileName(when), 'terminal-20261109-213005.txt');
  const r1 = SA.saveTerminalLog('satır 1\nçıktı ğüşiö', work, when);
  assert.ok(r1.ok, JSON.stringify(r1));
  const raw = fs.readFileSync(r1.path, 'utf8');
  assert.strictEqual(raw, '\ufeffsatır 1\r\nçıktı ğüşiö');
  const r2 = SA.saveTerminalLog('second', work, when);
  assert.ok(r2.ok && r2.path !== r1.path && /-2\.txt$/.test(r2.path), r2.path);
  assert.strictEqual(SA.saveTerminalLog('   ', work).ok, false);
  assert.strictEqual(SA.saveTerminalLog(null, work).ok, false);

  // --- drives (fake statfs: one real, one failing, one hanging) ---------------
  const fake = (p) => {
    if (p === 'C:\\') return Promise.resolve({ bsize: 4096, blocks: 1000, bavail: 250 });
    if (p === 'D:\\') return new Promise(() => {}); // never answers
    return Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' }));
  };
  const t0 = Date.now();
  const drives = await SA.listDrives(fake);
  assert.ok(Date.now() - t0 < 4000, 'hanging drive must time out');
  assert.deepStrictEqual(drives, [{ drive: 'C:', totalBytes: 4096000, freeBytes: 1024000, usedPercent: 75 }]);
  // The stuck D: probe is still holding an OS call: the next poll must not start another.
  assert.strictEqual(SA.pendingProbeCount(fake), 1);
  let dProbes = 0;
  const counting = (p) => { if (p === 'D:\\') dProbes++; return fake(p); };
  await SA.listDrives(counting);
  await SA.listDrives(counting);
  assert.strictEqual(dProbes, 1, 'a hanging drive is probed once, not every poll');
  assert.strictEqual(SA.pendingProbeCount(counting), 1);
  // Async path check (never blocks the main process).
  assert.strictEqual(await SA.resolveExistingPathAsync(os.tmpdir()), path.resolve(os.tmpdir()));
  assert.strictEqual(await SA.resolveExistingPathAsync(path.join(os.tmpdir(), 'nope-' + Date.now())), null);
  assert.strictEqual(await SA.resolveExistingPathAsync('relative'), null);
  const realDrives = await SA.listDrives();
  assert.ok(realDrives.some((d) => d.drive === 'C:'), 'real C: drive should be listed');

  // --- session restore -------------------------------------------------------
  const cfgFile = path.join(work, 'cfg.json');
  const store = new ConfigStore({ filePath: cfgFile });
  assert.strictEqual(store.getLastCwd(), '');
  assert.strictEqual(store.setLastCwd(work), true);
  assert.strictEqual(store.setLastCwd(work), false, 'unchanged value must not rewrite');
  assert.strictEqual(new ConfigStore({ filePath: cfgFile }).getLastCwd(), work);
  assert.strictEqual(resolveInitialCwd(store), work);
  store.setLastCwd(path.join(work, 'gone'));
  assert.strictEqual(resolveInitialCwd(store), process.env.USERPROFILE || process.cwd());
  assert.ok(new ConfigStore({ filePath: cfgFile }).getBoot().durationMs > 0, 'old fields still load');

  // --- palette filtering -------------------------------------------------------
  const items = [
    { id: 'a', title: 'Save terminal log', hint: 'file' },
    { id: 'b', title: 'Listening ports', hint: 'network netstat' },
    { id: 'c', title: 'Theme: green', hint: 'color' }
  ];
  assert.deepStrictEqual(Palette.filterItems(items, '').map((i) => i.id), ['a', 'b', 'c']);
  assert.deepStrictEqual(Palette.filterItems(items, 'port').map((i) => i.id), ['b']);
  assert.deepStrictEqual(Palette.filterItems(items, 'netstat').map((i) => i.id), ['b']);
  assert.deepStrictEqual(Palette.filterItems(items, 'th gr').map((i) => i.id), ['c']);
  assert.deepStrictEqual(Palette.filterItems(items, 'zzz'), []);
  assert.ok(Palette.DEFAULT_ITEMS.length >= 10);
  Palette.DEFAULT_ITEMS.forEach((it) => {
    assert.ok(it.id && it.title, 'item needs id + title');
    assert.ok(it.action || typeof it.command === 'string', `item ${it.id} needs an action or command`);
  });

  // --- submitLine: half-typed text is erased, then the line is sent ----------
  const writes = [];
  const pty = { write: (d) => writes.push(d), resize() {}, kill() {}, onData() {}, onExit() {} };
  const daemon = new ElevationDaemon({ elevated: true, passThrough: true, cwd: work });
  daemon.setPtyProcess(pty);
  const mgr = new PtyManager({ elevationDaemon: daemon, cwd: work, shellType: 'powershell' });
  mgr.ptyProcess = pty;
  mgr.handleInput('a'); mgr.handleInput('b'); mgr.handleInput('c');
  writes.length = 0;
  assert.strictEqual(mgr.submitLine('ipconfig /all', false), true);
  assert.deepStrictEqual(writes, ['\x1b[F' + '\x7f'.repeat(3), 'ipconfig /all']);
  assert.strictEqual(daemon.inputBuffer, 'ipconfig /all');
  writes.length = 0;
  mgr.submitLine('echo hi\r\nsecond', true);
  assert.strictEqual(writes[0], '\x1b[F' + '\x7f'.repeat('ipconfig /all'.length));
  assert.strictEqual(writes[1], 'echo hi second', 'newlines collapse to one line');
  assert.strictEqual(writes[2], '\r');
  assert.strictEqual(mgr.submitLine('   ', true), false);
  assert.strictEqual(mgr.submitLine(null, true), false);

  // --- /op extras: !!, status, timed unlock with auto-lock --------------------
  let out = '';
  const statuses = [];
  const op = new ElevationDaemon({ elevated: true, identity: 'TEST\\user', cwd: work, unlockTtlMs: 80,
    onOutput: (t) => { out += t; }, onStatus: (s) => statuses.push(s) });
  const ran = [];
  op.executeSubCommand = (cmd) => ran.push(cmd);
  op.restorePrompt = () => {};
  assert.ok(op.isOpCommand('/op !!') && op.isOpCommand('/op status') && op.isOpCommand('/op-unlock 30'));
  assert.ok(!op.isOpCommand('/op-unlock abc'));
  op.executeOpCommand('/op !!');
  assert.ok(/Tekrarlanacak onceki komut yok/.test(out), 'nothing to repeat yet');
  op.executeOpCommand('/op ipconfig /all');
  op.executeOpCommand('/op !!');
  assert.deepStrictEqual(ran, ['ipconfig /all', 'ipconfig /all']);
  out = '';
  op.executeOpCommand('/op status');
  assert.ok(/OP STATUS/.test(out) && /Son komut\s*: \/op ipconfig \/all/.test(out), out);
  op.executeOpCommand('/op-unlock');          // default ttl (80 ms here)
  assert.strictEqual(op.isUnlocked, true);
  assert.ok(op.unlockExpiresAt > Date.now());
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(op.isUnlocked, false, 'unlock expires on its own');
  assert.strictEqual(statuses[statuses.length - 1].unlocked, false, 'badge told about auto-lock');
  op.executeOpCommand('/op-unlock 0');        // no expiry
  assert.strictEqual(op.isUnlocked, true);
  assert.strictEqual(op.unlockExpiresAt, null);
  op.executeOpCommand('/op-lock');
  assert.strictEqual(op.isUnlocked, false);
  op.destroy();

  try { fs.rmSync(work, { recursive: true, force: true }); } catch (_e) {}
  console.log('test-pro-features: all assertions passed');
};

run().then(() => process.exit(0)).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
