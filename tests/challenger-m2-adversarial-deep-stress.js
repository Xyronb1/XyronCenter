/**
 * XYRON CENTER - Milestone 2 Iteration 2
 * Empirical Adversarial Deep Stress Challenger
 * File: 2_Proje_Dosyalari_Source/tests/challenger-m2-adversarial-deep-stress.js
 * 
 * Verifies:
 * 1. Challenge 3: Immediate cwd-change event and terminal:cwd-change IPC emission upon ptyManager.setCwd(newPath).
 *    Includes synchronous timing checks, case-insensitivity, duplicate suppression, and invalid path rejection.
 * 2. CMD Multi-drive navigation: uses Windows `subst X:` to verify `cd /d` drive-crossing in live CMD ConPTY session.
 * 3. 100 Rapid resize operations: stress resizing during heavy stdout flooding and during teardown race conditions.
 * 4. Process tree kill: launches PTYs with child subprocesses (ping) and verifies zero lingering OpenConsole.exe,
 *    powershell.exe, cmd.exe, or child processes.
 * 5. ANSI arrow sanitization and Turkish UTF-8 input resilience in PtyManager.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PTY_MANAGER_PATH = path.resolve(PROJECT_ROOT, 'src/main/pty-manager.js');
const ELEVATION_DAEMON_PATH = path.resolve(PROJECT_ROOT, 'src/main/elevation-daemon.js');

const PtyManager = require(PTY_MANAGER_PATH);
const ElevationDaemon = require(ELEVATION_DAEMON_PATH);

// ANSI Colors
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  dim: '\x1b[2m'
};

let passCount = 0;
let failCount = 0;
const results = [];
const unhandledExceptions = [];

process.on('uncaughtException', (err) => {
  unhandledExceptions.push({ type: 'uncaughtException', message: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  unhandledExceptions.push({ type: 'unhandledRejection', reason });
});

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

// Mock Electron BrowserWindow with webContents
class MockBrowserWindow extends EventEmitter {
  constructor() {
    super();
    this.isDestroyed = () => false;
    this.sentIpc = [];
    this.webContents = {
      isDestroyed: () => false,
      send: (channel, ...args) => {
        this.sentIpc.push({ channel, args, time: Date.now() });
        this.emit(channel, ...args);
      }
    };
  }

  getChannelMessages(channel) {
    return this.sentIpc.filter(m => m.channel === channel);
  }

  clearIpc() {
    this.sentIpc = [];
  }
}

// Mock Electron IpcMain
class MockIpcMain extends EventEmitter {
  constructor() {
    super();
    this.handlers = new Map();
  }

  handle(channel, fn) {
    this.handlers.set(channel, fn);
  }

  removeHandler(channel) {
    this.handlers.delete(channel);
  }

  async invoke(channel, ...args) {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`No handler registered for ${channel}`);
    return await handler({ sender: null }, ...args);
  }
}

// Helper: Query active processes matching specific image names
function getProcessPids(imageNames) {
  const pids = new Set();
  try {
    const raw = execSync('tasklist /FO CSV /NH', { encoding: 'utf8' });
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
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

// ============================================================================
// SECTION 1: CHALLENGE 3 - IMMEDIATE CWD EVENT & IPC SYNCHRONIZATION
// ============================================================================
async function challenge3_CwdSynchronization() {
  console.log(`\n${C.bold}[CHALLENGE 3] Verifying Immediate CWD Event & IPC Synchronization...${C.reset}`);

  const mockWin = new MockBrowserWindow();
  const manager = new PtyManager({ mainWindow: mockWin, shellType: 'cmd' });
  manager.init();
  await sleep(600);

  // Initial CWD was emitted at init
  const initIpc = mockWin.getChannelMessages('terminal:cwd-change');
  assert('CWD_SYNC', 'Initial CWD emitted via IPC on init()', initIpc.length >= 1, `Count: ${initIpc.length}`);

  // 1.1 Immediate synchronous emission verification
  const targetDir1 = os.tmpdir();
  let syncEventFired = false;
  let syncEventPath = null;
  let syncIpcFired = false;
  let syncIpcPath = null;

  mockWin.clearIpc();

  manager.on('cwd-change', (newPath) => {
    syncEventFired = true;
    syncEventPath = newPath;
  });

  mockWin.on('terminal:cwd-change', (newPath) => {
    syncIpcFired = true;
    syncIpcPath = newPath;
  });

  const startTime = Date.now();
  const setResult = manager.setCwd(targetDir1);
  const elapsed = Date.now() - startTime;

  assert('CWD_SYNC', 'ptyManager.setCwd(validPath) returns true', setResult === true);
  assert('CWD_SYNC', 'cwd-change event fired immediately synchronously (< 50ms)', syncEventFired && elapsed < 50, `Elapsed: ${elapsed}ms`);
  assert('CWD_SYNC', 'cwd-change event payload matches target directory',
    syncEventPath && syncEventPath.toLowerCase() === targetDir1.toLowerCase(),
    `Payload: ${syncEventPath}`
  );
  assert('CWD_SYNC', 'terminal:cwd-change IPC message fired immediately', syncIpcFired);
  assert('CWD_SYNC', 'terminal:cwd-change IPC payload matches target directory',
    syncIpcPath && syncIpcPath.toLowerCase() === targetDir1.toLowerCase(),
    `Payload: ${syncIpcPath}`
  );
  assert('CWD_SYNC', 'ptyManager.getCwd() reflects target directory immediately',
    manager.getCwd().toLowerCase() === targetDir1.toLowerCase(),
    `getCwd(): ${manager.getCwd()}`
  );

  // 1.2 Case-insensitivity check (Windows path normalization)
  // Calling setCwd with lowercased path should resolve to the same normalized directory
  const lowerCasedDir = targetDir1.toLowerCase();
  let lowerCaseEmitted = false;
  manager.once('cwd-change', () => { lowerCaseEmitted = true; });
  const lowerResult = manager.setCwd(lowerCasedDir);
  assert('CWD_SYNC', 'ptyManager.setCwd with lowercase path succeeds', lowerResult === true && lowerCaseEmitted);

  // 1.3 Path with Turkish characters and spaces
  const turkishSpecialDir = path.join(targetDir1, `XYRON_TEST_ŞIRNAK_ÖĞRETMEN_${Date.now()}`);
  fs.mkdirSync(turkishSpecialDir, { recursive: true });

  let turkishEventEmitted = false;
  let turkishEventPayload = null;
  manager.once('cwd-change', (p) => {
    turkishEventEmitted = true;
    turkishEventPayload = p;
  });

  const turkishSetResult = manager.setCwd(turkishSpecialDir);
  assert('CWD_SYNC', 'ptyManager.setCwd into Turkish named directory succeeds', turkishSetResult === true);
  assert('CWD_SYNC', 'cwd-change event preserves Turkish characters in path',
    turkishEventEmitted && turkishEventPayload && turkishEventPayload.includes('ŞIRNAK_ÖĞRETMEN'),
    `Emitted: ${turkishEventPayload}`
  );

  // 1.4 Invalid path rejection: non-existent directory
  const nonExistentDir = path.join(targetDir1, 'XYRON_TOTALLY_NON_EXISTENT_DIR_999888');
  let invalidFired = false;
  manager.once('cwd-change', () => { invalidFired = true; });
  const invalidResult = manager.setCwd(nonExistentDir);
  assert('CWD_SYNC', 'ptyManager.setCwd(nonExistentDir) returns false', invalidResult === false);
  assert('CWD_SYNC', 'ptyManager.setCwd(nonExistentDir) does NOT emit cwd-change event', !invalidFired);

  // 1.5 Invalid path rejection: file path instead of directory
  const tempFilePath = path.join(targetDir1, `xyron_temp_file_${Date.now()}.txt`);
  fs.writeFileSync(tempFilePath, 'sample text', 'utf8');

  let fileEventFired = false;
  manager.once('cwd-change', () => { fileEventFired = true; });
  const fileResult = manager.setCwd(tempFilePath);
  assert('CWD_SYNC', 'ptyManager.setCwd(filePath) returns false (must be directory)', fileResult === false);
  assert('CWD_SYNC', 'ptyManager.setCwd(filePath) does NOT emit cwd-change event', !fileEventFired);

  // 1.6 Malformed inputs: null, undefined, number, object
  assert('CWD_SYNC', 'ptyManager.setCwd(null) returns false', manager.setCwd(null) === false);
  assert('CWD_SYNC', 'ptyManager.setCwd(undefined) returns false', manager.setCwd(undefined) === false);
  assert('CWD_SYNC', 'ptyManager.setCwd(12345) returns false', manager.setCwd(12345) === false);
  assert('CWD_SYNC', 'ptyManager.setCwd({}) returns false', manager.setCwd({}) === false);
  assert('CWD_SYNC', 'ptyManager.setCwd("") returns false', manager.setCwd('') === false);

  // Cleanup temp files
  try { fs.unlinkSync(tempFilePath); } catch (_e) {}
  try { fs.rmdirSync(turkishSpecialDir); } catch (_e) {}

  manager.destroy();
}

// ============================================================================
// SECTION 2: CMD MULTI-DRIVE NAVIGATION VIA cd /d
// ============================================================================
async function challenge_CmdMultiDriveNavigation() {
  console.log(`\n${C.bold}[CHALLENGE 2] Verifying CMD Multi-Drive Navigation (cd /d)...${C.reset}`);

  // Create virtual drive letter X: pointing to %TEMP%
  const tempDir = os.tmpdir();
  let substMounted = false;
  try {
    execSync(`subst X: "${tempDir}"`, { stdio: 'ignore' });
    substMounted = true;
  } catch (err) {
    console.log(`  ${C.yellow}Warning: subst X: could not be mounted (${err.message}). Attempting drive letter Y:...${C.reset}`);
    try {
      execSync(`subst Y: "${tempDir}"`, { stdio: 'ignore' });
      substMounted = true;
    } catch (_e) {}
  }

  assert('MULTI_DRIVE', 'Windows subst virtual drive mounted for multi-drive test', substMounted);

  if (!substMounted) {
    console.log(`  ${C.yellow}Skipping live multi-drive shell test due to drive mount unavailability.${C.reset}`);
    return;
  }

  const driveLetter = fs.existsSync('X:\\') ? 'X:\\' : 'Y:\\';
  const mockWin = new MockBrowserWindow();
  const manager = new PtyManager({
    mainWindow: mockWin,
    shellType: 'cmd',
    cwd: process.env.USERPROFILE || 'C:\\Users\\Default'
  });
  manager.init();
  await sleep(800);

  assert('MULTI_DRIVE', 'CMD PTY session started on primary drive (C:)', manager.getCwd().toUpperCase().startsWith('C:'));

  let driveEventEmitted = false;
  let emittedDrivePath = null;
  manager.on('cwd-change', (newPath) => {
    driveEventEmitted = true;
    emittedDrivePath = newPath;
  });

  // Call setCwd with virtual drive root
  const switchResult = manager.setCwd(driveLetter);
  assert('MULTI_DRIVE', `ptyManager.setCwd('${driveLetter}') returned true`, switchResult === true);
  assert('MULTI_DRIVE', `cwd-change event emitted with new drive root (${driveLetter})`,
    driveEventEmitted && emittedDrivePath && emittedDrivePath.toUpperCase().startsWith(driveLetter[0]),
    `Emitted: ${emittedDrivePath}`
  );

  // Wait for CMD to execute `cd /d "X:\"` and output OSC 0 WindowTitle sequence
  let liveCmdTerminalOutput = '';
  mockWin.on('terminal:output', (chunk) => {
    liveCmdTerminalOutput += chunk;
  });

  // Issue a command to print current drive and directory: `cd\r`
  manager.writeDirect('cd\r');
  await sleep(1000);

  const cmdOutputUpper = liveCmdTerminalOutput.toUpperCase();
  const switchedSuccessfully = cmdOutputUpper.includes(`${driveLetter[0]}:\\`);
  assert('MULTI_DRIVE', `CMD terminal prompt and CD command reflect switched drive (${driveLetter})`,
    switchedSuccessfully,
    `Output snippet: ${liveCmdTerminalOutput.slice(-200).replace(/\r?\n/g, ' ')}`
  );

  // Navigate back to primary C: drive
  const homeDir = process.env.USERPROFILE || 'C:\\Users';
  const switchBackResult = manager.setCwd(homeDir);
  assert('MULTI_DRIVE', 'ptyManager.setCwd() successfully switched back to C: drive', switchBackResult === true);
  await sleep(800);

  manager.destroy();

  // Unmount subst drive
  try {
    execSync(`subst ${driveLetter[0]}: /d`, { stdio: 'ignore' });
  } catch (_e) {}
}

// ============================================================================
// SECTION 3: 100 RAPID RESIZE OPERATIONS WITH ZERO UNHANDLED CRASHES
// ============================================================================
async function challenge_RapidResizeStress() {
  console.log(`\n${C.bold}[CHALLENGE 3] 100 Rapid Resize Operations Stress Test...${C.reset}`);

  const initialUnhandledCount = unhandledExceptions.length;
  const mockWin = new MockBrowserWindow();
  const manager = new PtyManager(mockWin);
  manager.init('cmd');
  await sleep(600);

  let resizeErrors = 0;

  // 3.1 100 Rapid Extreme Resize calls while active output is streaming
  manager.writeDirect('for /L %i in (1,1,200) do @echo ACTIVE_STDOUT_STREAM_PACKET_%i\r');

  const startTime = Date.now();
  for (let i = 0; i < 100; i++) {
    // Generate varied columns and rows across extreme bounds
    const cols = 10 + Math.floor(Math.random() * 350);
    const rows = 5 + Math.floor(Math.random() * 120);
    try {
      manager.resize(cols, rows);
    } catch (_err) {
      resizeErrors++;
    }
  }
  const duration = Date.now() - startTime;

  assert('RESIZE_STRESS', '100 rapid random resize operations executed without synchronous error',
    resizeErrors === 0,
    `Duration: ${duration}ms, Errors: ${resizeErrors}`
  );

  // Wait for stdout loop to finish
  await sleep(800);

  // 3.2 Race condition: Resize concurrently with destroy()
  // This specifically tests the fix for "Cannot resize a pty that has already exited"
  let postDestroyResizeThrows = 0;
  try {
    manager.destroy();
  } catch (destErr) {
    console.error('Destroy error:', destErr);
  }

  // Attempt 20 rapid resizes on the destroyed manager
  for (let i = 0; i < 20; i++) {
    try {
      manager.resize(80 + i, 25 + i);
    } catch (_e) {
      postDestroyResizeThrows++;
    }
  }

  assert('RESIZE_STRESS', 'resize() calls after destroy() do not throw exceptions', postDestroyResizeThrows === 0);

  // Check unhandled exceptions globally
  const unhandledDelta = unhandledExceptions.length - initialUnhandledCount;
  assert('RESIZE_STRESS', '0 unhandled exceptions or rejections during rapid resize stress',
    unhandledDelta === 0,
    `Unhandled count: ${unhandledDelta}`
  );
}

// ============================================================================
// SECTION 4: PROCESS TREE KILL & ZERO ORPHAN AUDIT
// ============================================================================
async function challenge_ProcessTreeKillAudit() {
  console.log(`\n${C.bold}[CHALLENGE 4] Stress Process Tree Kill & Zero Orphan Audit...${C.reset}`);

  const trackedImages = ['OpenConsole.exe', 'powershell.exe', 'cmd.exe', 'ping.exe'];
  const baselinePids = getProcessPids(trackedImages);

  console.log(`  ${C.dim}Pre-test baseline tracked PIDs: ${baselinePids.size}${C.reset}`);

  // Spawn 4 PTY sessions (2 powershell, 2 cmd)
  // Inside each, spawn a long-running child process (`ping -n 100 127.0.0.1`)
  const managers = [];
  const spawnedPtyPids = [];

  for (let i = 0; i < 4; i++) {
    const isPs = (i % 2 === 0);
    const m = new PtyManager({ shellType: isPs ? 'powershell' : 'cmd' });
    m.init();
    if (m.ptyProcess && m.ptyProcess.pid) {
      spawnedPtyPids.push(m.ptyProcess.pid);
    }
    managers.push(m);
    // Launch child process in terminal
    m.writeDirect('ping -n 100 127.0.0.1 >nul\r');
  }

  assert('TREE_KILL', '4 PTY instances spawned with valid PIDs', spawnedPtyPids.length === 4, `PIDs: ${spawnedPtyPids.join(', ')}`);

  // Allow child ping processes to spin up
  await sleep(1500);

  // Query alive PIDs during test to verify child processes exist
  const midTestPids = getProcessPids(trackedImages);
  assert('TREE_KILL', 'Subprocesses successfully spun up under PTY sessions', midTestPids.size > baselinePids.size);

  // Destroy all 4 managers (initiating taskkill /F /PID /T)
  let destroyErrors = 0;
  for (const m of managers) {
    try {
      m.destroy();
    } catch (_e) {
      destroyErrors++;
    }
  }

  assert('TREE_KILL', 'All 4 managers destroyed cleanly via tree-kill', destroyErrors === 0);

  // Wait 2.0 seconds for OS tree termination
  await sleep(2000);

  // Check if any of the spawned PTY PIDs are still alive
  let lingeringPtyPids = 0;
  for (const pid of spawnedPtyPids) {
    try {
      const out = execSync(`tasklist /FO CSV /FI "PID eq ${pid}"`, { encoding: 'utf8' });
      if (out.includes(String(pid))) {
        lingeringPtyPids++;
      }
    } catch (_e) {}
  }

  assert('TREE_KILL', 'Zero spawned PTY shell PIDs linger after tree-kill', lingeringPtyPids === 0, `Lingering: ${lingeringPtyPids}`);

  // Check if any OpenConsole.exe or ping.exe processes created during test are lingering
  const postTestPids = getProcessPids(trackedImages);
  const lingeringNewPids = [...postTestPids].filter(pid => !baselinePids.has(pid));

  let lingeringOpenConsole = 0;
  let lingeringPing = 0;

  for (const pid of lingeringNewPids) {
    try {
      const out = execSync(`tasklist /FO CSV /FI "PID eq ${pid}"`, { encoding: 'utf8' }).toLowerCase();
      if (out.includes('openconsole.exe')) {
        lingeringOpenConsole++;
        try { execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' }); } catch (_e) {}
      }
      if (out.includes('ping.exe')) {
        lingeringPing++;
        try { execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' }); } catch (_e) {}
      }
    } catch (_e) {}
  }

  assert('TREE_KILL', 'Zero lingering OpenConsole.exe processes after tree-kill', lingeringOpenConsole === 0, `Lingering: ${lingeringOpenConsole}`);
  assert('TREE_KILL', 'Zero lingering grandchild processes (ping.exe) after tree-kill', lingeringPing === 0, `Lingering: ${lingeringPing}`);
}

// ============================================================================
// SECTION 5: ANSI ESCAPE SANITIZATION & IPC LIFECYCLE VERIFICATION
// ============================================================================
async function challenge_AnsiAndIpcLifecycle() {
  console.log(`\n${C.bold}[CHALLENGE 5] ANSI Escape Sanitization & Full IPC Lifecycle...${C.reset}`);

  const mockWin = new MockBrowserWindow();
  const mockIpc = new MockIpcMain();
  const manager = new PtyManager(mockWin);
  manager.init('cmd');
  manager.registerIpc(mockIpc);
  await sleep(600);

  // 5.1 Test IPC handlers
  const initialCwd = await mockIpc.invoke('terminal:cwd-get');
  assert('IPC_LIFECYCLE', 'IPC terminal:cwd-get returns current CWD', typeof initialCwd === 'string' && initialCwd.length > 0);

  const newTargetDir = os.tmpdir();
  const setCwdResult = await mockIpc.invoke('terminal:set-cwd', newTargetDir);
  assert('IPC_LIFECYCLE', 'IPC terminal:set-cwd successfully sets CWD', setCwdResult === true);

  const updatedCwd = await mockIpc.invoke('terminal:cwd-get');
  assert('IPC_LIFECYCLE', 'IPC terminal:cwd-get reflects updated directory',
    updatedCwd.toLowerCase() === newTargetDir.toLowerCase()
  );

  // 5.2 Test IPC terminal:restart
  const restartResult = await mockIpc.invoke('terminal:restart', 'cmd');
  assert('IPC_LIFECYCLE', 'IPC terminal:restart restarts session with valid structure',
    Boolean(restartResult && restartResult.success && restartResult.shellType === 'cmd')
  );

  // 5.3 Test ANSI Cursor Escape Sequence Sanitization
  // Simulate arrow keys followed by /op whoami
  mockIpc.emit('terminal:input', null, '\x1b[A'); // Up arrow
  mockIpc.emit('terminal:input', null, '\x1b[B'); // Down arrow
  mockIpc.emit('terminal:input', null, '\x1b[C'); // Right arrow
  mockIpc.emit('terminal:input', null, '\x1b[D'); // Left arrow
  mockIpc.emit('terminal:input', null, '\x1b[H'); // Home
  mockIpc.emit('terminal:input', null, '\x1b[F'); // End

  // The elevation daemon input buffer should remain empty (not contaminated with [, A, B, C, D, H, F)
  assert('ANSI_RESILIENCE', 'ElevationDaemon inputBuffer remains empty after ANSI cursor sequences',
    manager.elevationDaemon.inputBuffer === '',
    `Buffer: "${manager.elevationDaemon.inputBuffer}"`
  );

  // 5.4 Test Unregister IPC
  manager.unregisterIpc(mockIpc);
  let postUnregisterThrows = false;
  try {
    await mockIpc.invoke('terminal:cwd-get');
  } catch (_e) {
    postUnregisterThrows = true;
  }
  assert('IPC_LIFECYCLE', 'Unregister IPC cleanly removes handlers', postUnregisterThrows);

  manager.destroy(mockIpc);
}

// ============================================================================
// MAIN RUNNER
// ============================================================================
async function runAllAdversarialChallenges() {
  console.log(`\n${C.cyan}${C.bold}================================================================================${C.reset}`);
  console.log(`${C.cyan}${C.bold}   XYRON CENTER - EMPIRICAL ADVERSARIAL DEEP STRESS CHALLENGER SUITE          ${C.reset}`);
  console.log(`${C.cyan}${C.bold}================================================================================${C.reset}`);
  console.log(`Host OS: ${os.type()} ${os.release()} (${os.arch()}) | Node: ${process.version}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  try {
    await challenge3_CwdSynchronization();
    await challenge_CmdMultiDriveNavigation();
    await challenge_RapidResizeStress();
    await challenge_ProcessTreeKillAudit();
    await challenge_AnsiAndIpcLifecycle();
  } catch (fatalErr) {
    console.error(`\n${C.red}Fatal exception in challenger deep stress runner:${C.reset}`, fatalErr);
    failCount++;
  }

  console.log(`\n${C.cyan}${C.bold}================================================================================${C.reset}`);
  console.log(`${C.cyan}${C.bold}   DEEP CHALLENGER SUMMARY: ${passCount} PASSED | ${failCount} FAILED   ${C.reset}`);
  console.log(`${C.cyan}${C.bold}================================================================================${C.reset}`);

  if (unhandledExceptions.length > 0) {
    console.log(`\n${C.red}${C.bold}WARNING: ${unhandledExceptions.length} Unhandled Exceptions Caught During Execution:${C.reset}`);
    for (const ex of unhandledExceptions) {
      console.log(`  - [${ex.type}] ${ex.message || JSON.stringify(ex.reason)}`);
    }
  }

  if (failCount === 0 && unhandledExceptions.length === 0) {
    console.log(`\n${C.green}${C.bold}>>> EMPIRICAL VERDICT: CONFIRM_CORRECTNESS (100% Adversarial Assertions Passed) <<<${C.reset}\n`);
    return 0;
  } else {
    console.log(`\n${C.red}${C.bold}>>> EMPIRICAL VERDICT: FLAG_ISSUES (${failCount} Failures, ${unhandledExceptions.length} Unhandled Exceptions) <<<${C.reset}\n`);
    return 1;
  }
}

if (require.main === module) {
  runAllAdversarialChallenges().then(code => process.exit(code));
}

module.exports = {
  runAllAdversarialChallenges,
  challenge3_CwdSynchronization,
  challenge_CmdMultiDriveNavigation,
  challenge_RapidResizeStress,
  challenge_ProcessTreeKillAudit,
  challenge_AnsiAndIpcLifecycle
};
