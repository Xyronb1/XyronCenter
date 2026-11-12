/**
 * XYRON CENTER - Milestone 2 Empirical Adversarial Stress & Edge-Case Harness
 * File: 2_Proje_Dosyalari_Source/tests/challenger-m2-pty-stress.js
 * 
 * Conducts exhaustive empirical stress testing on:
 * 1. High-frequency ConPTY resizing (rapid thrashing between 10x5 and 300x100, invalid inputs, boundary clamping).
 * 2. Massive Turkish UTF-8 & Unicode burst input (128KB chunks, split multi-byte boundaries, emojis, ANSI escapes).
 * 3. Rapid CWD navigation (rapid directory jumps, Turkish directory names with spaces, adversarial OSC 0 sequences).
 * 4. Stress tree-kill & process leak audit (rapid multi-PTY spawn/kill, OpenConsole.exe & powershell.exe orphan audit).
 * 5. Elevation daemon line buffer stress & Ctrl+C process tree termination.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PTY_MANAGER_PATH = path.resolve(PROJECT_ROOT, 'src/main/pty-manager.js');
const ELEVATION_DAEMON_PATH = path.resolve(PROJECT_ROOT, 'src/main/elevation-daemon.js');
const NODE_MODULES_PTY = path.resolve(PROJECT_ROOT, 'node_modules/node-pty');

const PtyManager = require(PTY_MANAGER_PATH);
const ElevationDaemon = require(ELEVATION_DAEMON_PATH);
const pty = require(NODE_MODULES_PTY);

// ANSI Colors
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
  magenta: '\x1b[35m'
};

let passCount = 0;
let failCount = 0;
const results = [];

function assert(category, testName, condition, details = '') {
  if (condition) {
    passCount++;
    console.log(`  ${C.green}✓ [PASS]${C.reset} [${category}] ${testName}${details ? C.dim + ' (' + details + ')' + C.reset : ''}`);
    results.push({ category, name: testName, passed: true, details });
  } else {
    failCount++;
    console.log(`  ${C.red}✗ [FAIL]${C.reset} [${category}] ${testName}${details ? C.yellow + ' -> ' + details + C.reset : ''}`);
    results.push({ category, name: testName, passed: false, details });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Mock Electron BrowserWindow
class MockBrowserWindow extends EventEmitter {
  constructor() {
    super();
    this.isDestroyed = () => false;
    this.sentMessages = [];
    this.webContents = {
      isDestroyed: () => false,
      send: (channel, ...args) => {
        this.sentMessages.push({ channel, args, timestamp: Date.now() });
        this.emit(channel, ...args);
      }
    };
  }

  clearHistory() {
    this.sentMessages = [];
  }

  findMessages(channel) {
    return this.sentMessages.filter(m => m.channel === channel);
  }
}

// Process helper: count instances of specific process names currently alive
function getProcessPids(imageNames) {
  const pids = new Set();
  try {
    const raw = execSync('tasklist /FO CSV /NH', { encoding: 'utf8' });
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      // CSV format: "Image Name","PID","Session Name","Session#","Mem Usage"
      const match = line.match(/^"([^"]+)","(\d+)"/);
      if (match) {
        const name = match[1].toLowerCase();
        const pid = parseInt(match[2], 10);
        if (imageNames.some(target => target.toLowerCase() === name)) {
          pids.add(pid);
        }
      }
    }
  } catch (_e) {}
  return pids;
}

// ---------------------------------------------------------------------------
// TEST SUITE 1: HIGH-FREQUENCY CONPTY RESIZING STRESS
// ---------------------------------------------------------------------------
async function testResizeStress() {
  console.log(`\n${C.bold}[CHALLENGE 1] High-Frequency ConPTY Resizing & Boundary Clamping Stress...${C.reset}`);
  
  const mockWin = new MockBrowserWindow();
  const manager = new PtyManager(mockWin);
  manager.init('cmd');
  await sleep(600);

  let resizeErrors = 0;
  let ptyDied = false;
  manager.ptyProcess.onExit(() => { ptyDied = true; });

  // 1.1 Rapid thrashing: 100 alternating resize calls
  const startTime = Date.now();
  for (let i = 0; i < 100; i++) {
    const cols = (i % 2 === 0) ? 10 : 300;
    const rows = (i % 2 === 0) ? 5 : 100;
    try {
      manager.resize(cols, rows);
    } catch (_err) {
      resizeErrors++;
    }
  }
  const duration = Date.now() - startTime;
  assert('RESIZE_STRESS', '100 rapid alternating resize calls (10x5 <-> 300x100) executed', resizeErrors === 0, `${duration}ms, errors: ${resizeErrors}`);
  assert('RESIZE_STRESS', 'ConPTY session survived 100 rapid resize operations without dying', !ptyDied);

  // 1.2 Boundary & Invalid input fuzzing
  const invalidInputs = [
    { cols: -50, rows: -20, desc: 'Negative values' },
    { cols: 0, rows: 0, desc: 'Zero dimensions' },
    { cols: 99999, rows: 99999, desc: 'Huge dimensions > 500x200' },
    { cols: NaN, rows: NaN, desc: 'NaN inputs' },
    { cols: 'invalid', rows: 'bad', desc: 'Non-numeric string inputs' },
    { cols: null, rows: undefined, desc: 'Null and undefined inputs' },
    { cols: 150.75, rows: 45.99, desc: 'Floating point inputs' }
  ];

  let boundaryErrors = 0;
  for (const tc of invalidInputs) {
    try {
      manager.resize(tc.cols, tc.rows);
    } catch (_e) {
      boundaryErrors++;
    }
  }
  assert('RESIZE_STRESS', 'PtyManager.resize gracefully clamps boundary & invalid inputs without throwing', boundaryErrors === 0);

  // 1.3 Concurrent resize while streaming data
  let concurrentErrors = 0;
  let receivedDataChunks = 0;
  mockWin.on('terminal:output', () => { receivedDataChunks++; });

  for (let i = 0; i < 20; i++) {
    manager.handleInput(`echo RESIZE_STREAM_BURST_${i}\r`);
    manager.resize(80 + (i * 2), 24 + (i % 10));
    await sleep(25);
  }
  await sleep(600);

  assert('RESIZE_STRESS', 'PTY continues streaming output during interleaved resize events', receivedDataChunks > 0 && !ptyDied);

  manager.destroy();
}

// ---------------------------------------------------------------------------
// TEST SUITE 2: MASSIVE TURKISH UTF-8 & UNICODE BURST STREAMING
// ---------------------------------------------------------------------------
async function testTurkishAndUnicodeBurst() {
  console.log(`\n${C.bold}[CHALLENGE 2] Massive Turkish & Unicode Burst Input Stress...${C.reset}`);

  const mockWin = new MockBrowserWindow();
  const manager = new PtyManager(mockWin);
  manager.init('powershell');
  await sleep(1000);

  const TURKISH_CHARS = 'çğıöşüÇĞİÖŞÜ';
  const EMOJIS = '🚀🔥⚡💻🛡️🇹🇷';
  const ANSI_COLOR = '\x1b[32m';
  const ANSI_RESET = '\x1b[0m';
  const PANGRAM = 'Pijamalı hasta yağız şoföre çabucak güvendi. İŞÇİ ÖĞRETMEN ÇAĞDAŞ ŞIRNAK';

  // 2.1 Large burst payload generator (64KB payload)
  let burstChunk = '';
  for (let i = 0; i < 400; i++) {
    burstChunk += `[${i}] ${ANSI_COLOR}${PANGRAM}${ANSI_RESET} | ${TURKISH_CHARS} | ${EMOJIS}\r\n`;
  }
  const burstByteSize = Buffer.byteLength(burstChunk, 'utf8');

  let outputBuffer = '';
  mockWin.on('terminal:output', (data) => {
    outputBuffer += data;
  });

  // Write large burst directly to terminal viewport and through PTY direct
  let streamSuccess = true;
  try {
    manager.writeToTerminal(burstChunk);
  } catch (err) {
    streamSuccess = false;
  }
  assert('UNICODE_BURST', `Stream 64KB+ Turkish/Emoji/ANSI burst through terminal view (${burstByteSize} bytes)`, streamSuccess);
  assert('UNICODE_BURST', 'Output buffer contains zero Unicode replacement characters (\\uFFFD)', !outputBuffer.includes('\uFFFD'));
  assert('UNICODE_BURST', 'Output buffer preserves Turkish Dotted Capital I (İ)', outputBuffer.includes('İ'));
  assert('UNICODE_BURST', 'Output buffer preserves Turkish Capital G With Breve (Ğ)', outputBuffer.includes('Ğ'));
  assert('UNICODE_BURST', 'Output buffer preserves complex Emojis', outputBuffer.includes('🚀') && outputBuffer.includes('🇹🇷'));

  // 2.2 Split-byte UTF-8 Chunk Simulation
  // In UTF-8, 'Ç' is 0xC3 0x87. Simulate two separate chunks splitting this character.
  let splitHandledOk = true;
  try {
    const rawC3 = Buffer.from([0xC3]).toString('binary');
    const raw87 = Buffer.from([0x87]).toString('binary');
    manager.handleInput(rawC3);
    manager.handleInput(raw87);
  } catch (_e) {
    splitHandledOk = false;
  }
  assert('UNICODE_BURST', 'Split UTF-8 multi-byte chunks do not cause unhandled exceptions', splitHandledOk);

  // 2.3 Input buffer leak / memory stress in ElevationDaemon
  // Feed 10,000 Turkish characters without Enter, verify no crash or unhandled throw
  let feedNoEnterOk = true;
  try {
    const longInput = 'ş'.repeat(10000);
    manager.handleInput(longInput);
    // Now press Ctrl+U or Ctrl+C to clear line
    manager.handleInput('\x15');
  } catch (_e) {
    feedNoEnterOk = false;
  }
  assert('UNICODE_BURST', '10,000 character continuous Turkish input stream handled cleanly without newline', feedNoEnterOk);

  manager.destroy();
}

// ---------------------------------------------------------------------------
// TEST SUITE 3: RAPID CWD NAVIGATION & ADVERSARIAL OSC 0 SEQUENCES
// ---------------------------------------------------------------------------
async function testCwdNavigationStress() {
  console.log(`\n${C.bold}[CHALLENGE 3] Rapid CWD Navigation & Adversarial OSC 0 Parsing...${C.reset}`);

  const mockWin = new MockBrowserWindow();
  const manager = new PtyManager(mockWin);
  manager.init('cmd');
  await sleep(600);

  // 3.1 Create test directory with spaces and Turkish characters
  const tmpBase = os.tmpdir();
  const turkishDirName = `xyron_türkçe_dizin_şığöçü_${Date.now()}`;
  const turkishDirPath = path.join(tmpBase, turkishDirName);
  fs.mkdirSync(turkishDirPath, { recursive: true });

  // 3.1 Direct Shell cd navigation with Turkish directory names
  let shellCwdCaptured = false;
  const shellCwdListener = (newPath) => {
    if (newPath.toLowerCase() === turkishDirPath.toLowerCase()) {
      shellCwdCaptured = true;
    }
  };
  manager.on('cwd-change', shellCwdListener);
  // Write cd command directly to shell
  manager.writeDirect(`cd /d "${turkishDirPath}"\r`);
  await sleep(800);

  assert('CWD_STRESS', 'Direct shell cd navigation into directory with Turkish characters triggers OSC 0 CWD emission', shellCwdCaptured, turkishDirPath);
  manager.off('cwd-change', shellCwdListener);

  // 3.2 Programmatic setCwd event emission & synchronization audit
  let programmaticCwdEmitted = false;
  const progCwdListener = (newPath) => {
    if (newPath.toLowerCase() === tmpBase.toLowerCase()) {
      programmaticCwdEmitted = true;
    }
  };
  manager.on('cwd-change', progCwdListener);
  // Programmatic setCwd call
  manager.setCwd(tmpBase);
  await sleep(800);

  assert('CWD_STRESS', 'PtyManager.setCwd() emits cwd-change event to listeners (BUG CHECK: setCwd drops event)', programmaticCwdEmitted, `Current CWD: ${manager.getCwd()}`);
  manager.off('cwd-change', progCwdListener);

  // 3.2 Adversarial OSC 0 WindowTitle sequence fuzzing directly against _processOscBuffer
  const adversarialOscPayloads = [
    { title: 'C:\\Windows\\System32', raw: '\x1b]0;C:\\Windows\\System32\x07', expectValid: true },
    { title: 'C:\\Windows', raw: '\x1b]0;C:\\Windows\x1b\\', expectValid: true },
    { title: 'Title With Null Byte', raw: '\x1b]0;C:\\Windows\x00\\bad\x07', expectValid: false },
    { title: 'Non-existent directory', raw: '\x1b]0;C:\\NonExistent_Fake_Dir_9999\x07', expectValid: false },
    { title: 'Command prompt title', raw: '\x1b]0;Administrator: Command Prompt - npm run build\x07', expectValid: false },
    { title: 'Binary name ending in exe', raw: '\x1b]0;C:\\Windows\\notepad.exe\x07', expectValid: false },
    { title: 'Linux slash path', raw: '\x1b]0;C:/Windows/System32\x07', expectValid: true },
    { title: 'Relative non-drive path', raw: '\x1b]0;some/relative/path\x07', expectValid: false }
  ];

  let fuzzingPassed = true;
  for (const testCase of adversarialOscPayloads) {
    try {
      manager._processOscBuffer(testCase.raw);
    } catch (_err) {
      fuzzingPassed = false;
    }
  }
  assert('CWD_STRESS', 'Adversarial OSC 0 sequences (null bytes, invalid drives, exe titles) handled without throw', fuzzingPassed);

  // 3.3 Large OSC buffer truncation stress (prevent memory leak)
  // Stream 100,000 characters of noise without OSC escapes
  const noise = 'A'.repeat(100000);
  manager._processOscBuffer(noise);
  assert('CWD_STRESS', 'oscBuffer truncates properly to prevent unbounded memory growth (<= 2048)', manager.oscBuffer.length <= 2048, `Current length: ${manager.oscBuffer.length}`);

  // Cleanup test folder
  try {
    fs.rmdirSync(turkishDirPath);
  } catch (_e) {}

  manager.destroy();
}

// ---------------------------------------------------------------------------
// TEST SUITE 4: STRESS TREE KILL & ORPHANED PROCESS AUDIT
// ---------------------------------------------------------------------------
async function testStressTreeKill() {
  console.log(`\n${C.bold}[CHALLENGE 4] Stress Tree-Kill & Process Orphan Audit...${C.reset}`);

  const trackedImages = ['OpenConsole.exe', 'powershell.exe', 'cmd.exe'];
  const baselinePids = getProcessPids(trackedImages);

  console.log(`  ${C.dim}Baseline active tracked PIDs count: ${baselinePids.size}${C.reset}`);

  // Spawn 10 PTY sessions in rapid succession and immediately kill them
  const spawnedPids = [];
  const managers = [];

  for (let i = 0; i < 10; i++) {
    const isPs = (i % 2 === 0);
    const m = new PtyManager({ shellType: isPs ? 'powershell' : 'cmd' });
    m.init();
    if (m.ptyProcess && m.ptyProcess.pid) {
      spawnedPids.push(m.ptyProcess.pid);
    }
    managers.push(m);
    // Write something to engage ConPTY
    m.writeDirect('echo PTY_BURST_TEST\r');
  }

  assert('TREE_KILL_STRESS', '10 rapid ConPTY sessions spawned with valid PIDs', spawnedPids.length === 10, `PIDs: ${spawnedPids.slice(0, 4).join(', ')}...`);

  // Allow ConPTY worker processes to spin up
  await sleep(1000);

  // Rapidly destroy all managers
  let destroyErrors = 0;
  for (const m of managers) {
    try {
      m.destroy();
      // Double destroy call to test idempotency
      m.destroy();
    } catch (_err) {
      destroyErrors++;
    }
  }

  assert('TREE_KILL_STRESS', 'All 10 managers destroyed with double-destroy idempotency and 0 errors', destroyErrors === 0);

  // Wait 1.5 seconds for OS process cleanup
  await sleep(1500);

  // Check if any of the spawned PIDs are still alive
  let leakedSpawned = 0;
  for (const pid of spawnedPids) {
    try {
      const out = execSync(`tasklist /FO CSV /FI "PID eq ${pid}"`, { encoding: 'utf8' });
      if (out.includes(String(pid))) {
        leakedSpawned++;
      }
    } catch (_e) {}
  }
  assert('TREE_KILL_STRESS', 'Zero spawned shell PIDs linger after tree-kill', leakedSpawned === 0, `Leaked: ${leakedSpawned}`);

  // Inspect OpenConsole.exe count
  const postTestPids = getProcessPids(trackedImages);
  // Any newly created PIDs that are still alive?
  const newlyCreatedAlive = [...postTestPids].filter(pid => !baselinePids.has(pid));

  // If there are newly created alive PIDs, check if they are orphaned OpenConsole.exe
  let orphanedOpenConsole = 0;
  for (const pid of newlyCreatedAlive) {
    try {
      const out = execSync(`tasklist /FO CSV /FI "PID eq ${pid}"`, { encoding: 'utf8' });
      if (out.toLowerCase().includes('openconsole.exe')) {
        orphanedOpenConsole++;
        // Force cleanup
        try { execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' }); } catch (_e) {}
      }
    } catch (_e) {}
  }

  assert('TREE_KILL_STRESS', 'Zero orphaned OpenConsole.exe processes lingering after stress kill', orphanedOpenConsole === 0, `Orphans found: ${orphanedOpenConsole}`);
}

// ---------------------------------------------------------------------------
// TEST SUITE 5: ELEVATION DAEMON IN-TERMINAL STRESS & CTRL+C
// ---------------------------------------------------------------------------
async function testElevationDaemonStress() {
  console.log(`\n${C.bold}[CHALLENGE 5] Elevation Daemon In-Terminal Stress & Process Cancellation...${C.reset}`);

  const mockWin = new MockBrowserWindow();
  const daemon = new ElevationDaemon({ mainWindow: mockWin });

  // 5.1 Rapid command parsing fuzz
  const commands = [
    '/op whoami',
    '/op-unlock',
    '/op-lock',
    '/op echo TEST_OP',
    '/op',
    '   /op whoami   ',
    '/op-unlock\r\n',
    'normal command',
    'dir /w',
    '/op      multiple spaces'
  ];

  let parseErrors = 0;
  for (const cmd of commands) {
    try {
      daemon.isOpCommand(cmd);
    } catch (_e) {
      parseErrors++;
    }
  }
  assert('ELEVATION_STRESS', 'isOpCommand fuzzer executed without unhandled errors', parseErrors === 0);

  // 5.2 Sub-command execution and cancellation via Ctrl+C
  const longCmd = daemon.executeSubCommand('ping -n 30 127.0.0.1');
  assert('ELEVATION_STRESS', 'Long-running OP subcommand spawned with child process handle', Boolean(longCmd && longCmd.pid));

  await sleep(500);
  assert('ELEVATION_STRESS', 'Daemon tracks active sub-command in activeProcesses set', daemon.activeProcesses.size === 1);

  // Send Ctrl+C
  const interceptedCtrlC = daemon.handleInput('\x03');
  assert('ELEVATION_STRESS', 'Ctrl+C (\\x03) intercepts and terminates running OP sub-command', interceptedCtrlC === true);
  await sleep(500);

  assert('ELEVATION_STRESS', 'Active process set cleared after Ctrl+C', daemon.activeProcesses.size === 0);

  daemon.destroy();
}

// ---------------------------------------------------------------------------
// MAIN RUNNER
// ---------------------------------------------------------------------------
async function runAllChallenges() {
  console.log(`\n${C.cyan}${C.bold}================================================================================${C.reset}`);
  console.log(`${C.cyan}${C.bold}   XYRON CENTER - EMPIRICAL CHALLENGER: M2 PTY & TERMINAL STRESS HARNESS    ${C.reset}`);
  console.log(`${C.cyan}${C.bold}================================================================================${C.reset}`);
  console.log(`Host OS: ${os.type()} ${os.release()} (${os.arch()}) | Node: ${process.version}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  try {
    await testResizeStress();
    await testTurkishAndUnicodeBurst();
    await testCwdNavigationStress();
    await testStressTreeKill();
    await testElevationDaemonStress();
  } catch (fatalErr) {
    console.error(`\n${C.red}Fatal stress test exception:${C.reset}`, fatalErr);
    failCount++;
  }

  console.log(`\n${C.cyan}${C.bold}================================================================================${C.reset}`);
  console.log(`${C.cyan}${C.bold}   CHALLENGE SUMMARY: ${passCount} PASSED | ${failCount} FAILED   ${C.reset}`);
  console.log(`${C.cyan}${C.bold}================================================================================${C.reset}`);

  if (failCount === 0) {
    console.log(`\n${C.green}${C.bold}>>> EMPIRICAL VERDICT: CONFIRM_CORRECTNESS (All Stress Challenges Passed) <<<${C.reset}\n`);
    return 0;
  } else {
    console.log(`\n${C.red}${C.bold}>>> EMPIRICAL VERDICT: FLAG_ISSUES (${failCount} Failures Detected) <<<${C.reset}\n`);
    return 1;
  }
}

if (require.main === module) {
  runAllChallenges().then(exitCode => {
    process.exit(exitCode);
  }).catch(err => {
    console.error('Unhandled fatal error in stress suite:', err);
    process.exit(1);
  });
}

module.exports = {
  runAllChallenges,
  testResizeStress,
  testTurkishAndUnicodeBurst,
  testCwdNavigationStress,
  testStressTreeKill,
  testElevationDaemonStress
};
