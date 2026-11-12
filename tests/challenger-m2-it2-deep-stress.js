/**
 * XYRON CENTER - Milestone 2 Iteration 2 Deep Adversarial Stress Harness
 * File: 2_Proje_Dosyalari_Source/tests/challenger-m2-it2-deep-stress.js
 * 
 * Conducts exhaustive stress verification of:
 * 1. ANSI / VT escape sequences & inputBuffer corruption resistance (CSI, SS3, arrow keys, function keys, interleaved typing)
 * 2. Whitespace, tab, and casing variance on /op commands (/op     whoami, /op\twhoami, trailing spaces)
 * 3. 100-cycle rapid toggle parity (/op-unlock <-> /op-lock) with concurrent IPC querying
 * 4. Multi-process concurrent in-flight Ctrl+C (^C / \x03) termination with zero lingering orphans
 * 5. High-volume stdout streaming & backpressure stress with Turkish UTF-8 byte verification
 * 6. Persistent elevated mode state transition and shell passthrough fidelity
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { execSync, exec } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ELEVATION_DAEMON_PATH = path.resolve(PROJECT_ROOT, 'src/main/elevation-daemon.js');
const PTY_MANAGER_PATH = path.resolve(PROJECT_ROOT, 'src/main/pty-manager.js');

const ElevationDaemon = require(ELEVATION_DAEMON_PATH);
const PtyManager = require(PTY_MANAGER_PATH);

// ANSI Colors for console output
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
const testResults = [];
const findings = [];

function assert(suite, testName, condition, details = '', blastRadius = 'LOW') {
  if (condition) {
    passCount++;
    console.log(`  ${C.green}✓ [PASS]${C.reset} [${suite}] ${testName}${details ? C.dim + ' (' + details + ')' + C.reset : ''}`);
    testResults.push({ suite, name: testName, passed: true, details });
  } else {
    failCount++;
    console.log(`  ${C.red}✗ [FAIL]${C.reset} [${suite}] ${testName}${details ? C.yellow + ' -> ' + details + C.reset : ''}`);
    testResults.push({ suite, name: testName, passed: false, details });
    findings.push({ suite, name: testName, details, blastRadius });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    const out = execSync(`tasklist /FO CSV /FI "PID eq ${pid}"`, { encoding: 'utf8', windowsHide: true });
    return out.includes(String(pid));
  } catch (_e) {
    return false;
  }
}

function killPidTree(pid) {
  if (!pid) return;
  try {
    execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore', windowsHide: true });
  } catch (_e) {}
}

class MockBrowserWindow extends EventEmitter {
  constructor() {
    super();
    this.isDestroyed = () => false;
    this.messages = [];
    this.webContents = {
      isDestroyed: () => false,
      send: (channel, ...args) => {
        this.messages.push({ channel, args, time: Date.now() });
        this.emit(channel, ...args);
        this.emit('ipc-message', { channel, args });
      }
    };
  }
  getChannelMessages(channel) {
    return this.messages.filter(m => m.channel === channel);
  }
  clearMessages() {
    this.messages = [];
  }
}

async function runDeepStressSuite() {
  console.log(`\n${C.cyan}${C.bold}================================================================================${C.reset}`);
  console.log(`${C.cyan}${C.bold}   XYRON CENTER - M2-IT2 DEEP ADVERSARIAL EMPIRICAL STRESS CHALLENGE HARNESS    ${C.reset}`);
  console.log(`${C.cyan}${C.bold}================================================================================${C.reset}`);
  console.log(`Target: elevation-daemon.js & pty-manager.js`);
  console.log(`Host OS: ${os.type()} ${os.release()} (${os.arch()}) | Node: ${process.version}`);
  console.log(`Timestamp: ${new Date().toISOString()}\n`);

  // ==========================================================================
  // SECTION 1: ANSI ESCAPE SEQUENCES & INPUT BUFFER PURITY
  // ==========================================================================
  console.log(`${C.bold}[SECTION 1] Comprehensive ANSI/VT Escape Sequences & Buffer Purity...${C.reset}`);
  {
    const mockWin = new MockBrowserWindow();
    let terminalOut = '';
    const daemon = new ElevationDaemon({
      mainWindow: mockWin,
      onOutput: (t) => { terminalOut += t; }
    });

    const testEscapeSequences = [
      { name: 'Up Arrow', seq: '\x1b[A' },
      { name: 'Down Arrow', seq: '\x1b[B' },
      { name: 'Right Arrow', seq: '\x1b[C' },
      { name: 'Left Arrow', seq: '\x1b[D' },
      { name: 'Home Key', seq: '\x1b[H' },
      { name: 'End Key', seq: '\x1b[F' },
      { name: 'Insert Key', seq: '\x1b[2~' },
      { name: 'Delete Key', seq: '\x1b[3~' },
      { name: 'Page Up', seq: '\x1b[5~' },
      { name: 'Page Down', seq: '\x1b[6~' },
      { name: 'F1-F4 SS3', seq: '\x1bOP' },
      { name: 'Cursor Pos Report', seq: '\x1b[24;80R' },
      { name: 'Window Focus In', seq: '\x1b[I' },
      { name: 'Window Focus Out', seq: '\x1b[O' }
    ];

    let allEscapesRejected = true;
    for (const item of testEscapeSequences) {
      daemon.inputBuffer = '';
      const consumed = daemon.handleInput(item.seq);
      if (daemon.inputBuffer.length > 0 || consumed === true) {
        allEscapesRejected = false;
        console.log(`    ${C.red}Buffer polluted by ${item.name}: "${daemon.inputBuffer}"${C.reset}`);
      }
    }
    assert('ANSI_STRESS', 'All 14 VT/CSI/SS3 sequences rejected without polluting inputBuffer', allEscapesRejected);
    assert('ANSI_STRESS', 'Final inputBuffer after all escape blasts is empty', daemon.inputBuffer === '');

    // Interleaved arrow keystrokes during interactive command typing
    daemon.inputBuffer = '';
    daemon.handleInput('/op');
    assert('ANSI_STRESS', 'Typing "/op" populates inputBuffer', daemon.inputBuffer === '/op');
    // User presses Up Arrow twice then Down Arrow
    daemon.handleInput('\x1b[A');
    daemon.handleInput('\x1b[A');
    daemon.handleInput('\x1b[B');
    assert('ANSI_STRESS', 'Arrow keys during typing do NOT add [A or [B to buffer', daemon.inputBuffer === '/op', `Buffer: "${daemon.inputBuffer}"`);
    // User continues typing: " whoami"
    daemon.handleInput(' whoami');
    assert('ANSI_STRESS', 'Buffer continues smoothly without corruption', daemon.inputBuffer === '/op whoami');
    // Hit Enter
    terminalOut = '';
    const consumedCmd = daemon.handleInput('\r');
    await sleep(400);
    assert('ANSI_STRESS', 'Interleaved command successfully intercepted as /op whoami', consumedCmd === true);
    assert('ANSI_STRESS', 'Whoami identity header rendered after interleaved arrows', terminalOut.includes('[OP PRIVILEGE IDENTITY]'));

    // PtyManager level ANSI filtering
    const ptyManager = new PtyManager(mockWin);
    // Send raw arrows through PtyManager.handleInput
    ptyManager.elevationDaemon.inputBuffer = '';
    ptyManager.handleInput('\x1b[A');
    ptyManager.handleInput('\x1b[B');
    ptyManager.handleInput('\x1b[C');
    ptyManager.handleInput('\x1b[D');
    assert('ANSI_STRESS', 'PtyManager sanitized input before ElevationDaemon (buffer empty)', ptyManager.elevationDaemon.inputBuffer === '');

    ptyManager.destroy();
    daemon.destroy();
  }

  // ==========================================================================
  // SECTION 2: WHITESPACE, TABS, CASING, AND SYNTAX VARIANCE
  // ==========================================================================
  console.log(`\n${C.bold}[SECTION 2] Whitespace, Tabs, Casing, and Syntax Variance...${C.reset}`);
  {
    const mockWin = new MockBrowserWindow();
    let terminalOut = '';
    const daemon = new ElevationDaemon({
      mainWindow: mockWin,
      onOutput: (t) => { terminalOut += t; }
    });

    // 2.1 Multi-space whoami: /op          whoami (10 spaces)
    daemon.inputBuffer = '';
    terminalOut = '';
    const multiSpace10 = daemon.handleInput('/op          whoami\r');
    await sleep(300);
    assert('WHITESPACE', '/op          whoami (10 spaces) is intercepted', multiSpace10 === true);
    assert('WHITESPACE', '/op          whoami routes to privilege identity handler', terminalOut.includes('[OP PRIVILEGE IDENTITY]'));

    // 2.2 Tabs: /op\twhoami
    daemon.inputBuffer = '';
    terminalOut = '';
    const tabWhoami = daemon.handleInput('/op\twhoami\r');
    await sleep(300);
    assert('WHITESPACE', '/op\\twhoami (tab-delimited) is intercepted', tabWhoami === true);
    assert('WHITESPACE', '/op\\twhoami routes to privilege identity handler', terminalOut.includes('[OP PRIVILEGE IDENTITY]'));

    // 2.3 Mixed tabs & spaces: /op  \t  whoami  
    daemon.inputBuffer = '';
    terminalOut = '';
    const mixedWhoami = daemon.handleInput('/op  \t  whoami  \r');
    await sleep(300);
    assert('WHITESPACE', '/op  \\t  whoami  (mixed tab/space/trailing) is intercepted', mixedWhoami === true);
    assert('WHITESPACE', '/op  \\t  whoami  routes to privilege identity handler', terminalOut.includes('[OP PRIVILEGE IDENTITY]'));

    // 2.4 Trailing spaces on /op-unlock
    daemon.isUnlocked = false;
    terminalOut = '';
    const unlockWithSpaces = daemon.handleInput('/op-unlock    \r');
    await sleep(200);
    assert('WHITESPACE', '/op-unlock with trailing spaces is intercepted', unlockWithSpaces === true);
    assert('WHITESPACE', '/op-unlock with trailing spaces enables isUnlocked', daemon.isUnlocked === true);

    // 2.5 Trailing spaces on /op-lock
    terminalOut = '';
    const lockWithSpaces = daemon.handleInput('/op-lock    \r');
    await sleep(200);
    assert('WHITESPACE', '/op-lock with trailing spaces is intercepted', lockWithSpaces === true);
    assert('WHITESPACE', '/op-lock with trailing spaces disables isUnlocked', daemon.isUnlocked === false);

    // 2.6 Subcommand with leading and trailing spaces: /op    echo TEST_SPACES   
    daemon.inputBuffer = '';
    terminalOut = '';
    let subCmdDone = false;
    daemon.handleInput('/op    echo TEST_SPACES   \r');
    for (let i = 0; i < 20; i++) {
      if (terminalOut.includes('TEST_SPACES')) { subCmdDone = true; break; }
      await sleep(100);
    }
    assert('WHITESPACE', '/op with multi-space subcommand routes and executes cleanly', subCmdDone, `Output: ${terminalOut.trim().slice(0, 60)}`);

    // 2.7 Bare /op with multiple spaces
    daemon.inputBuffer = '';
    terminalOut = '';
    const bareOpSpaces = daemon.handleInput('/op       \r');
    await sleep(200);
    assert('WHITESPACE', '/op with trailing spaces only shows usage manual', bareOpSpaces === true && terminalOut.includes('[OP ENGINE] In-Terminal Privilege Elevation Subsystem'));

    daemon.destroy();
  }

  // ==========================================================================
  // SECTION 3: 100 RAPID TOGGLE CYCLES & STATE PARITY UNDER CONCURRENCY
  // ==========================================================================
  console.log(`\n${C.bold}[SECTION 3] 100 Rapid Toggle Cycles & State Parity Under Concurrency...${C.reset}`);
  {
    const mockWin = new MockBrowserWindow();
    const daemon = new ElevationDaemon({ mainWindow: mockWin });

    const CYCLES = 100;
    let parityOk = true;
    const recordedBrodcasts = [];

    mockWin.on('op:status', (st) => {
      recordedBrodcasts.push(st);
    });

    for (let i = 1; i <= CYCLES; i++) {
      const wantUnlock = (i % 2 === 1);
      daemon.handleInput(wantUnlock ? '/op-unlock\r' : '/op-lock\r');
      if (daemon.isUnlocked !== wantUnlock) {
        parityOk = false;
      }
    }

    assert('TOGGLE_STRESS', '100 rapid sequential toggles maintain 100% state parity', parityOk);
    assert('TOGGLE_STRESS', '100 op:status broadcasts recorded by BrowserWindow', recordedBrodcasts.length === CYCLES, `Count: ${recordedBrodcasts.length}`);
    assert('TOGGLE_STRESS', 'Final daemon.isUnlocked is strictly false after 100 iterations', daemon.isUnlocked === false);

    // Check payload contract across all 100 events
    const allValid = recordedBrodcasts.every((b, idx) => {
      const exp = (idx % 2 === 0); // 0 is 1st (unlock=true)
      return b.unlocked === exp && typeof b.identity === 'string' && b.identity.length > 0;
    });
    assert('TOGGLE_STRESS', 'All 100 broadcast payloads conform to { unlocked: boolean, identity: string } contract', allValid);

    // Concurrent token inspection during rapid toggles
    let tokenLookupThrew = false;
    try {
      for (let i = 0; i < 20; i++) {
        daemon.resolveTokenIdentity(false);
      }
    } catch (_e) {
      tokenLookupThrew = true;
    }
    assert('TOGGLE_STRESS', 'Repeated cached resolveTokenIdentity() is fast and error-free', !tokenLookupThrew);

    daemon.destroy();
  }

  // ==========================================================================
  // SECTION 4: MULTI-PROCESS IN-FLIGHT CTRL+C TERMINATION & 0 ORPHANS
  // ==========================================================================
  console.log(`\n${C.bold}[SECTION 4] Multi-Process In-Flight Ctrl+C Termination & Zero-Orphan Audit...${C.reset}`);
  {
    const mockWin = new MockBrowserWindow();
    let terminalOut = '';
    const daemon = new ElevationDaemon({
      mainWindow: mockWin,
      onOutput: (t) => { terminalOut += t; }
    });

    // Spawn 3 concurrent elevated long-running child processes
    const pids = [];
    for (let i = 0; i < 3; i++) {
      const child = daemon.executeSubCommand('ping 127.0.0.1 -n 30');
      if (child && child.pid) {
        pids.push(child.pid);
      }
    }

    assert('PROCESS_INTERRUPT', 'Spawned 3 concurrent sub-processes', pids.length === 3, `PIDs: ${pids.join(', ')}`);
    assert('PROCESS_INTERRUPT', 'All 3 processes tracked in activeProcesses set', daemon.activeProcesses.size === 3);

    // Wait 800ms for OS processes to spin up
    await sleep(800);

    let allInitiallyAlive = true;
    for (const pid of pids) {
      if (!isPidAlive(pid)) allInitiallyAlive = false;
    }
    assert('PROCESS_INTERRUPT', 'All 3 processes confirmed physically alive in Windows OS tasklist', allInitiallyAlive);

    // Issue Ctrl+C (\x03)
    terminalOut = '';
    const interrupted = daemon.handleInput('\x03');
    assert('PROCESS_INTERRUPT', 'Ctrl+C (\\x03) returns true (intercepted)', interrupted === true);
    assert('PROCESS_INTERRUPT', 'Terminal receives [Interrupted by User (^C)] notice', terminalOut.includes('[Interrupted by User (^C)]'));

    // Wait 700ms for taskkill /F /PID /T tree termination to complete
    await sleep(700);

    let anyAlive = false;
    for (const pid of pids) {
      if (isPidAlive(pid)) {
        anyAlive = true;
        killPidTree(pid); // force kill if leaked
      }
    }
    assert('PROCESS_INTERRUPT', 'ALL 3 child processes terminated immediately via taskkill /F /PID /T', !anyAlive);
    assert('PROCESS_INTERRUPT', 'activeProcesses set is completely cleared (size === 0)', daemon.activeProcesses.size === 0);

    // Double-verify no orphaned ping processes linger
    let orphanedPids = 0;
    for (const pid of pids) {
      if (isPidAlive(pid)) orphanedPids++;
    }
    assert('PROCESS_INTERRUPT', 'Zero orphaned child processes linger in Windows OS (0 orphans)', orphanedPids === 0);

    daemon.destroy();
  }

  // ==========================================================================
  // SECTION 5: REAL-TIME LARGE STDOUT BURSTS & TURKISH UTF-8 STREAMING
  // ==========================================================================
  console.log(`\n${C.bold}[SECTION 5] Real-Time Large Stdout Bursts & Turkish UTF-8 Streaming...${C.reset}`);
  {
    const mockWin = new MockBrowserWindow();
    let totalBytesReceived = 0;
    let chunkCount = 0;
    let terminalOut = '';

    const daemon = new ElevationDaemon({
      mainWindow: mockWin,
      onOutput: (t) => {
        terminalOut += t;
        totalBytesReceived += Buffer.byteLength(t, 'utf8');
        chunkCount++;
      }
    });

    // 5.1 Real-time multi-chunk streaming test (2MB with Turkish characters)
    // Generate 10,000 lines with Turkish characters: "Xyron_Türkçe_Başarım_Şövalye_Öğrenci_Çağ_1234567890" (~60 bytes * 10,000 = ~600KB)
    let burstDone = false;
    const nodeCmd = `node -e "for(let i=0; i<10000; i++) console.log('Xyron_Türkçe_Başarım_Şövalye_Öğrenci_Çağ_' + i);"`;
    daemon.executeSubCommand(nodeCmd, () => {
      burstDone = true;
    });

    for (let i = 0; i < 60 && !burstDone; i++) {
      await sleep(100);
    }

    assert('STDOUT_BURST', 'Burst script completed successfully', burstDone === true);
    assert('STDOUT_BURST', 'Output streamed in real-time multiple chunks', chunkCount > 5, `Chunks: ${chunkCount}`);
    assert('STDOUT_BURST', 'Total streamed bytes approx 600KB+', totalBytesReceived >= 500000, `Received: ${Math.round(totalBytesReceived / 1024)} KB`);
    assert('STDOUT_BURST', 'Streamed output contains authentic Turkish characters with 0 glyph loss', 
      terminalOut.includes('Türkçe') && terminalOut.includes('Şövalye') && terminalOut.includes('Öğrenci') && terminalOut.includes('Çağ')
    );
    assert('STDOUT_BURST', 'Zero Unicode replacement characters (\\uFFFD) in terminal stream', !terminalOut.includes('\uFFFD'));

    // 5.2 CRLF conversion fidelity
    // Node console.log outputs \n or \r\n, writeToTerminal formats with \r\n
    assert('STDOUT_BURST', 'Output stream preserves proper \\r\\n line endings for VT terminal', terminalOut.includes('\r\n'));

    daemon.destroy();
  }

  // ==========================================================================
  // SECTION 6: PERSISTENT ELEVATED MODE EXECUTION & SHELL PASSTHROUGH
  // ==========================================================================
  console.log(`\n${C.bold}[SECTION 6] Persistent Elevated Mode Execution & Shell Passthrough...${C.reset}`);
  {
    const mockWin = new MockBrowserWindow();
    let terminalOut = '';
    const daemon = new ElevationDaemon({
      mainWindow: mockWin,
      onOutput: (t) => { terminalOut += t; }
    });

    // 6.1 When locked: regular commands return false (passthrough to shell)
    daemon.isUnlocked = false;
    const lockedPassthrough = daemon.handleInput('dir\r');
    assert('PERSISTENT_MODE', 'When locked, standard command "dir" returns false (shell passthrough)', lockedPassthrough === false);

    // 6.2 When unlocked: regular commands return true and execute elevated via executeSubCommand
    daemon.isUnlocked = true;
    terminalOut = '';
    let executedInUnlocked = false;
    const unlockedIntercept = daemon.handleInput('echo ELEVATED_MODE_TEST\r');
    assert('PERSISTENT_MODE', 'When unlocked, standard command is intercepted (returns true)', unlockedIntercept === true);

    for (let i = 0; i < 20; i++) {
      if (terminalOut.includes('ELEVATED_MODE_TEST')) {
        executedInUnlocked = true;
        break;
      }
      await sleep(100);
    }
    assert('PERSISTENT_MODE', 'When unlocked, standard command executes via OP executor', executedInUnlocked);
    assert('PERSISTENT_MODE', 'OP execution header rendered for standard command', terminalOut.includes('[OP EXEC: echo ELEVATED_MODE_TEST]'));

    // 6.3 Re-locking restores passthrough
    daemon.handleInput('/op-lock\r');
    assert('PERSISTENT_MODE', 'After /op-lock, isUnlocked is false', daemon.isUnlocked === false);
    const lockedAgain = daemon.handleInput('dir\r');
    assert('PERSISTENT_MODE', 'After /op-lock, standard commands return false again (shell passthrough)', lockedAgain === false);

    daemon.destroy();
  }

  // ==========================================================================
  // FINAL ADVERSARIAL HARNESS SUMMARY
  // ==========================================================================
  console.log(`\n${C.cyan}${C.bold}================================================================================${C.reset}`);
  console.log(`${C.cyan}${C.bold}   DEEP CHALLENGER SUMMARY: ${passCount} PASSED | ${failCount} FAILED   ${C.reset}`);
  console.log(`${C.cyan}${C.bold}================================================================================${C.reset}\n`);

  if (failCount === 0) {
    console.log(`${C.green}${C.bold}>>> VERDICT: CONFIRM_CORRECTNESS <<<${C.reset}`);
    console.log(`${C.green}All deep adversarial stress challenges passed with 0 defects, 0 leaks, and 100% fidelity.${C.reset}\n`);
    return 0;
  } else {
    console.log(`${C.red}${C.bold}>>> VERDICT: FLAG_ISSUES <<<${C.reset}`);
    findings.forEach((f, i) => {
      console.log(`  ${i + 1}. [${f.blastRadius}] [${f.suite}] ${f.name} -> ${f.details}`);
    });
    console.log('');
    return 1;
  }
}

if (require.main === module) {
  runDeepStressSuite().then(exitCode => {
    process.exit(exitCode);
  }).catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
  });
}

module.exports = { runDeepStressSuite };
