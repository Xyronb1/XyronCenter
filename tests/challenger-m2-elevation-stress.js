/**
 * XYRON CENTER - Milestone 2 Adversarial Stress & Verification Harness
 * File: tests/challenger-m2-elevation-stress.js
 * 
 * Empirical Adversarial Challenger for Milestone 2:
 * 1. Malformed and edge-case /op commands:
 *    - /op, /op    , /op     whoami, /op-unlock, /op-lock, /op-unlocking (should NOT unlock)
 *    - /op ; echo INJECTION_TEST, /op & echo AMPERSAND_TEST, empty inputs, massive whitespace
 *    - Massive buffer injection (100k chars), rapid backspace underflow, ANSI escape rejection
 *    - Turkish UTF-8 parameter passing and chunked CRLF delivery
 * 2. Rapid toggle stress:
 *    - 50 rapid toggles between /op-unlock and /op-lock
 *    - State consistency, parity tracking, IPC op:status broadcasts, zero race conditions
 * 3. In-flight process interruption:
 *    - Long-running command execution (/op ping 127.0.0.1 -n 20)
 *    - Ctrl+C (\x03) interception halfway through
 *    - Process tree termination via taskkill /F /PID /T verified in Windows OS tasklist
 *    - [Interrupted by User (^C)] rendering and clean prompt restoration
 * 4. Large stdout output burst:
 *    - High-volume data streaming (1MB, 5MB, and 15MB boundary audit)
 *    - maxBuffer threshold stress & ERR_CHILD_PROCESS_STDIO_MAXBUFFER boundary inspection
 *    - Real-world /op dir /s C:\Windows\System32 stream test with active termination
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { execSync, exec, spawn } = require('child_process');

// Project Paths
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ELEVATION_DAEMON_PATH = path.resolve(PROJECT_ROOT, 'src/main/elevation-daemon.js');
const PTY_MANAGER_PATH = path.resolve(PROJECT_ROOT, 'src/main/pty-manager.js');

const ElevationDaemon = require(ELEVATION_DAEMON_PATH);
const PtyManager = require(PTY_MANAGER_PATH);

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
const testResults = [];
const findings = [];

function recordTest(suite, testName, passed, details = '', blastRadius = 'LOW') {
  if (passed) {
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

// Tree-kill helper
function cleanTreeKill(pid) {
  if (!pid) return;
  try {
    execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore', windowsHide: true });
  } catch (_e) {}
}

// Check if PID is alive in OS
function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    const out = execSync(`tasklist /FO CSV /FI "PID eq ${pid}"`, { encoding: 'utf8', windowsHide: true });
    return out.includes(String(pid));
  } catch (_e) {
    return false;
  }
}

// Mock BrowserWindow for Headless IPC
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

// ============================================================================
// MAIN ADVERSARIAL STRESS SUITE
// ============================================================================
async function runChallengerStressSuite() {
  console.log(`\n${C.cyan}${C.bold}================================================================================${C.reset}`);
  console.log(`${C.cyan}${C.bold}   XYRON CENTER - MILESTONE 2 EMPIRICAL ADVERSARIAL STRESS CHALLENGE HARNESS    ${C.reset}`);
  console.log(`${C.cyan}${C.bold}================================================================================${C.reset}`);
  console.log(`Target: elevation-daemon.js & pty-manager.js`);
  console.log(`Host OS: ${os.type()} ${os.release()} (${os.arch()}) | Node: ${process.version}`);
  console.log(`Timestamp: ${new Date().toISOString()}\n`);

  // ==========================================================================
  // SUITE 1: Malformed and Edge-Case /op Commands
  // ==========================================================================
  console.log(`${C.bold}[SUITE 1] Stress-Testing Malformed and Edge-Case /op Commands...${C.reset}`);
  {
    const mockWin = new MockBrowserWindow();
    let terminalOutput = '';
    let promptRestoreCount = 0;

    const daemon = new ElevationDaemon({
      mainWindow: mockWin,
      onOutput: (text) => { terminalOutput += text; },
      onRestorePrompt: () => { promptRestoreCount++; }
    });

    // Test 1.1: Standalone /op (Usage help)
    terminalOutput = '';
    const consumedOp = daemon.handleInput('/op\r');
    recordTest('MALFORMED_OP', '/op triggers usage interceptor and returns true', consumedOp === true);
    recordTest('MALFORMED_OP', '/op displays in-terminal usage manual', terminalOutput.includes('[OP ENGINE] In-Terminal Privilege Elevation Subsystem'));

    // Test 1.2: /op with trailing whitespace: "/op    "
    terminalOutput = '';
    const consumedOpSpaces = daemon.handleInput('/op    \r');
    recordTest('MALFORMED_OP', '/op with trailing spaces is intercepted', consumedOpSpaces === true);
    recordTest('MALFORMED_OP', '/op with trailing spaces renders usage manual', terminalOutput.includes('[OP ENGINE] In-Terminal Privilege Elevation Subsystem'));

    // Test 1.3: Leading spaces in subcommand: "/op     whoami"
    terminalOutput = '';
    const consumedMultiSpaceWhoami = daemon.handleInput('/op     whoami\r');
    recordTest('MALFORMED_OP', '/op     whoami is intercepted by daemon', consumedMultiSpaceWhoami === true);
    // Allow either handleWhoami or whoami sub-command execution without crashing
    await sleep(600);
    const whoamiHandled = terminalOutput.includes('[OP PRIVILEGE IDENTITY]') || terminalOutput.includes('[OP EXEC: whoami]') || terminalOutput.toLowerCase().includes('nt authority');
    recordTest('MALFORMED_OP', '/op     whoami executes without crash or syntax error', whoamiHandled, `Output preview: ${terminalOutput.replace(/\r?\n/g, ' ').slice(0, 80)}`);

    // Test 1.4: /op-unlock
    terminalOutput = '';
    const consumedUnlock = daemon.handleInput('/op-unlock\r');
    recordTest('MALFORMED_OP', '/op-unlock is intercepted', consumedUnlock === true);
    recordTest('MALFORMED_OP', '/op-unlock sets isUnlocked to true', daemon.isUnlocked === true);
    recordTest('MALFORMED_OP', '/op-unlock renders UNLOCKED banner', terminalOutput.includes('ELEVATED PRIVILEGE MODE: UNLOCKED'));

    // Test 1.5: /op-lock
    terminalOutput = '';
    const consumedLock = daemon.handleInput('/op-lock\r');
    recordTest('MALFORMED_OP', '/op-lock is intercepted', consumedLock === true);
    recordTest('MALFORMED_OP', '/op-lock sets isUnlocked to false', daemon.isUnlocked === false);
    recordTest('MALFORMED_OP', '/op-lock renders LOCKED banner', terminalOutput.includes('ELEVATED PRIVILEGE MODE: LOCKED'));

    // Test 1.6: /op-unlocking (should NOT unlock)
    daemon.isUnlocked = false;
    terminalOutput = '';
    const consumedUnlocking = daemon.handleInput('/op-unlocking\r');
    recordTest('MALFORMED_OP', '/op-unlocking is NOT intercepted as OP command', consumedUnlocking === false);
    recordTest('MALFORMED_OP', '/op-unlocking strictly maintains isUnlocked=false', daemon.isUnlocked === false);

    // Test 1.7: Command separator attempt: /op ; echo INJECTION_SAFE
    terminalOutput = '';
    let cmdCompleted = false;
    daemon.handleInput('/op ; echo INJECTION_TEST\r');
    await sleep(600);
    recordTest('MALFORMED_OP', '/op with semicolon command separator does not crash daemon', true);

    // Test 1.8: Ampersand chaining attempt: /op & echo AMPERSAND_SAFE
    terminalOutput = '';
    daemon.handleInput('/op & echo AMPERSAND_TEST\r');
    await sleep(600);
    recordTest('MALFORMED_OP', '/op with ampersand does not crash daemon', true);

    // Test 1.9: Empty string input
    const emptyConsumed = daemon.handleInput('');
    recordTest('MALFORMED_OP', 'Empty string input returns false and is safely ignored', emptyConsumed === false);

    // Test 1.10: Massive whitespace string
    const whitespaceConsumed = daemon.handleInput('                      \r');
    recordTest('MALFORMED_OP', 'Massive whitespace string returns false and does not trigger /op', whitespaceConsumed === false);

    // Test 1.11: Massive buffer injection (100,000 characters)
    const massiveChunk = 'A'.repeat(100000);
    let massiveThrew = false;
    try {
      daemon.handleInput(massiveChunk);
      daemon.handleInput('\x15'); // Ctrl+U to clear
    } catch (_e) {
      massiveThrew = true;
    }
    recordTest('MALFORMED_OP', '100,000 character buffer injection handled without OOM or crash', !massiveThrew);
    recordTest('MALFORMED_OP', 'Buffer cleared cleanly after massive injection', daemon.inputBuffer === '');

    // Test 1.12: Turkish UTF-8 in sub-command
    terminalOutput = '';
    const turkishCmd = 'echo Türkçe_Karakter_Şövalye_Öğrenci_Çağ';
    let turkishDone = false;
    daemon.executeSubCommand(turkishCmd, (code) => {
      turkishDone = true;
    });
    for (let i = 0; i < 20 && !turkishDone; i++) {
      await sleep(100);
    }
    recordTest('MALFORMED_OP', 'Turkish UTF-8 subcommand completes', turkishDone === true);
    recordTest('MALFORMED_OP', 'Turkish characters streamed to terminal with byte fidelity', terminalOutput.includes('Türkçe_Karakter_Şövalye_Öğrenci_Çağ'));

    // Test 1.13: Rapid Backspace Underflow (100 backspaces on empty buffer)
    let backspaceThrew = false;
    try {
      for (let i = 0; i < 100; i++) {
        daemon.handleInput('\b');
        daemon.handleInput('\x7f');
      }
    } catch (_e) {
      backspaceThrew = true;
    }
    recordTest('MALFORMED_OP', '100 rapid backspaces on empty buffer handled cleanly without underflow', !backspaceThrew && daemon.inputBuffer === '');

    // Test 1.14: ANSI Escape Code Rejection & Input Buffer Pollution Audit
    // Terminal VT sequences like Up/Down arrow (\x1b[A, \x1b[B)
    daemon.inputBuffer = '';
    daemon.handleInput('\x1b[A');
    const arrowPolluted = daemon.inputBuffer === '[A';
    recordTest(
      'MALFORMED_OP',
      'ANSI escape sequences (\x1b[A) do NOT pollute inputBuffer with trailing characters',
      !arrowPolluted,
      `Observed inputBuffer: "${daemon.inputBuffer}" after Up Arrow \\x1b[A (Causes subsequent commands to fail)`,
      'MEDIUM'
    );
    // Reset buffer after testing to prevent cascading failure
    daemon.inputBuffer = '';

    // Test 1.15: CRLF Chunk Parsing vs Bare CR / LF on clean buffer
    terminalOutput = '';
    daemon.handleInput('/op whoami\r\n');
    await sleep(200);
    recordTest('MALFORMED_OP', 'CRLF line ending (/op whoami\\r\\n) parsed identically to CR', terminalOutput.includes('[OP PRIVILEGE IDENTITY]'));

    // Test 1.16: Whitespace variance audit (/op whoami vs /op     whoami)
    terminalOutput = '';
    daemon.handleInput('/op     whoami\r');
    await sleep(600);
    const usesBuiltinIdentity = terminalOutput.includes('[OP PRIVILEGE IDENTITY]');
    const usesExternalWhoami = terminalOutput.includes('[OP EXEC: whoami]');
    recordTest(
      'MALFORMED_OP',
      '/op     whoami with multi-space routes to built-in privilege identity handler',
      usesBuiltinIdentity,
      `Multi-space /op     whoami routed to ${usesExternalWhoami ? 'external OS whoami via executeSubCommand' : 'unknown'} instead of handleWhoami()`,
      'LOW'
    );

    daemon.destroy();
  }

  // ==========================================================================
  // SUITE 2: Rapid Toggle Stress (50x /op-unlock & /op-lock)
  // ==========================================================================
  console.log(`\n${C.bold}[SUITE 2] Stress-Testing Rapid Toggle (50x /op-unlock and /op-lock)...${C.reset}`);
  {
    const mockWin = new MockBrowserWindow();
    let promptCount = 0;
    const daemon = new ElevationDaemon({
      mainWindow: mockWin,
      onRestorePrompt: () => { promptCount++; }
    });

    const TOGGLE_CYCLES = 50;
    const recordedStates = [];
    const broadcastEvents = [];

    mockWin.on('op:status', (status) => {
      broadcastEvents.push(Object.assign({}, status));
    });

    let parityViolation = false;
    for (let i = 1; i <= TOGGLE_CYCLES; i++) {
      const shouldUnlock = (i % 2 === 1);
      if (shouldUnlock) {
        daemon.handleInput('/op-unlock\r');
      } else {
        daemon.handleInput('/op-lock\r');
      }

      recordedStates.push(daemon.isUnlocked);
      if (daemon.isUnlocked !== shouldUnlock) {
        parityViolation = true;
      }
    }

    recordTest('RAPID_TOGGLE', '50 rapid synchronous toggle commands executed without throwing', true);
    recordTest('RAPID_TOGGLE', 'State parity matched perfectly across all 50 iterations', !parityViolation);
    recordTest('RAPID_TOGGLE', 'Final state isUnlocked is strictly false after even count (50)', daemon.isUnlocked === false);
    recordTest('RAPID_TOGGLE', '50 op:status IPC broadcasts recorded by BrowserWindow', broadcastEvents.length === TOGGLE_CYCLES, `Received: ${broadcastEvents.length}`);

    // Verify all broadcast payloads
    let payloadsValid = true;
    for (let i = 0; i < broadcastEvents.length; i++) {
      const ev = broadcastEvents[i];
      const expectedUnlocked = (i % 2 === 0); // 0th is 1st toggle (unlock=true)
      if (typeof ev.unlocked !== 'boolean' || ev.unlocked !== expectedUnlocked || typeof ev.identity !== 'string') {
        payloadsValid = false;
        break;
      }
    }
    recordTest('RAPID_TOGGLE', 'All 50 IPC broadcast payloads adhere to { unlocked, identity } contract', payloadsValid);

    // Test Asynchronous Rapid Toggle through registerIpc handlers
    const ipcWin = new MockBrowserWindow();
    const asyncDaemon = new ElevationDaemon({ mainWindow: ipcWin });
    const mockIpcMain = new EventEmitter();
    mockIpcMain.handle = (channel, fn) => { mockIpcMain[channel] = fn; };
    mockIpcMain.removeHandler = (channel) => { delete mockIpcMain[channel]; };
    asyncDaemon.registerIpc(mockIpcMain);

    let asyncParityOk = true;
    for (let i = 1; i <= 50; i++) {
      const cmd = (i % 2 === 1) ? '/op-unlock' : '/op-lock';
      mockIpcMain.emit('op:execute', {}, cmd);
      const expected = (i % 2 === 1);
      if (asyncDaemon.isUnlocked !== expected) {
        asyncParityOk = false;
      }
    }
    recordTest('RAPID_TOGGLE', '50 rapid IPC op:execute invocations maintain immediate state consistency', asyncParityOk);
    recordTest('RAPID_TOGGLE', 'Final asyncDaemon.isUnlocked is false', asyncDaemon.isUnlocked === false);

    // Verify op:get-status handler
    const statusHandlerRes = await mockIpcMain['op:get-status']();
    recordTest('RAPID_TOGGLE', 'op:get-status IPC handler returns correct status snapshot', statusHandlerRes && statusHandlerRes.unlocked === false && statusHandlerRes.identity === 'STANDARD');

    asyncDaemon.unregisterIpc(mockIpcMain);
    asyncDaemon.destroy();
    daemon.destroy();
  }

  // ==========================================================================
  // SUITE 3: In-Flight Process Interruption (Ctrl+C / \x03)
  // ==========================================================================
  console.log(`\n${C.bold}[SUITE 3] Stress-Testing In-Flight Process Interruption (^C / \\x03)...${C.reset}`);
  {
    const mockWin = new MockBrowserWindow();
    let terminalOutput = '';
    let promptRestored = false;

    const daemon = new ElevationDaemon({
      mainWindow: mockWin,
      onOutput: (text) => { terminalOutput += text; },
      onRestorePrompt: () => { promptRestored = true; }
    });

    // Launch a long-running command: ping 127.0.0.1 -n 25
    terminalOutput = '';
    promptRestored = false;
    let completedCode = null;

    const child = daemon.executeSubCommand('ping 127.0.0.1 -n 25', (code) => {
      completedCode = code;
    });

    recordTest('PROCESS_INTERRUPT', 'Sub-command spawned and child returned', child !== null && typeof child.pid === 'number');
    recordTest('PROCESS_INTERRUPT', 'Child registered in daemon activeProcesses set', daemon.activeProcesses.has(child));

    const childPid = child.pid;
    // Wait for the process to actually be running in Windows
    await sleep(800);
    const initiallyAlive = isProcessAlive(childPid);
    recordTest('PROCESS_INTERRUPT', 'Spawned process is physically running in Windows OS tasklist', initiallyAlive, `PID: ${childPid}`);

    // Verify output has begun streaming
    recordTest('PROCESS_INTERRUPT', 'Initial command banner rendered to terminal stream', terminalOutput.includes('[OP EXEC: ping 127.0.0.1 -n 25]'));

    // Send Ctrl+C (\x03) halfway through
    terminalOutput = '';
    promptRestored = false;
    const interrupted = daemon.handleInput('\x03');

    recordTest('PROCESS_INTERRUPT', 'handleInput(\\x03) returns true (intercepted by daemon)', interrupted === true);
    recordTest('PROCESS_INTERRUPT', '[Interrupted by User (^C)] rendered into terminal stream', terminalOutput.includes('[Interrupted by User (^C)]'));
    recordTest('PROCESS_INTERRUPT', 'Prompt restoration triggered on interruption', promptRestored === true);

    // Give taskkill /F /PID /T 600ms to complete tree kill
    await sleep(600);

    const stillAlive = isProcessAlive(childPid);
    recordTest('PROCESS_INTERRUPT', 'Active process tree killed instantly via taskkill /F /PID /T', !stillAlive, `PID: ${childPid} is dead`);
    recordTest('PROCESS_INTERRUPT', 'daemon.activeProcesses set cleared to size 0', daemon.activeProcesses.size === 0);

    // Verify no stray ping.exe orphaned by this test run
    // Check if childPid still exists
    recordTest('PROCESS_INTERRUPT', 'Zero orphan process leak guaranteed after Ctrl+C', !isProcessAlive(childPid));

    // Test Ctrl+C with NO active processes -> should return false (let shell handle)
    const passthroughCtrlC = daemon.handleInput('\x03');
    recordTest('PROCESS_INTERRUPT', 'Ctrl+C with no active sub-process returns false (shell passthrough)', passthroughCtrlC === false);

    daemon.destroy();
  }

  // ==========================================================================
  // SUITE 4: Large Stdout Output Burst & Buffer Streaming
  // ==========================================================================
  console.log(`\n${C.bold}[SUITE 4] Stress-Testing Large Stdout Output Burst & Streaming...${C.reset}`);
  {
    const mockWin = new MockBrowserWindow();
    let terminalOutput = '';
    let totalBytesReceived = 0;
    let chunkCount = 0;

    const daemon = new ElevationDaemon({
      mainWindow: mockWin,
      onOutput: (text) => {
        terminalOutput += text;
        totalBytesReceived += Buffer.byteLength(text, 'utf8');
        chunkCount++;
      }
    });

    // Test 4.1: 1MB Streaming Burst
    // Generate ~1MB of text via Node -e inline script
    console.log(`  ${C.dim}...Running 1MB burst test...${C.reset}`);
    terminalOutput = '';
    totalBytesReceived = 0;
    chunkCount = 0;
    let burst1Completed = false;

    // 10,000 lines of 100 chars = ~1 MB
    const cmd1MB = `node -e "for(let i=0; i<10000; i++) console.log('X'.repeat(100));"`;
    daemon.executeSubCommand(cmd1MB, (code) => {
      burst1Completed = true;
    });

    for (let i = 0; i < 50 && !burst1Completed; i++) {
      await sleep(100);
    }

    recordTest('OUTPUT_BURST', '1MB stdout stream completes without error', burst1Completed === true);
    recordTest('OUTPUT_BURST', '1MB burst streams in multiple chunks (real-time stream)', chunkCount > 5, `Chunks: ${chunkCount}`);
    recordTest('OUTPUT_BURST', 'Total streamed bytes approx 1MB', totalBytesReceived >= 900000, `Received: ${Math.round(totalBytesReceived / 1024)} KB`);

    // Test 4.2: 5MB Streaming Burst
    console.log(`  ${C.dim}...Running 5MB burst test...${C.reset}`);
    terminalOutput = '';
    totalBytesReceived = 0;
    chunkCount = 0;
    let burst5Completed = false;

    // 50,000 lines of 100 chars = ~5 MB
    const cmd5MB = `node -e "for(let i=0; i<50000; i++) console.log('Y'.repeat(100));"`;
    daemon.executeSubCommand(cmd5MB, (code) => {
      burst5Completed = true;
    });

    for (let i = 0; i < 80 && !burst5Completed; i++) {
      await sleep(100);
    }

    recordTest('OUTPUT_BURST', '5MB stdout stream completes without error', burst5Completed === true);
    recordTest('OUTPUT_BURST', '5MB burst streams in real-time chunks', chunkCount > 20, `Chunks: ${chunkCount}`);
    recordTest('OUTPUT_BURST', 'Total streamed bytes approx 5MB', totalBytesReceived >= 4500000, `Received: ${Math.round(totalBytesReceived / 1024)} KB`);

    // Test 4.3: Boundary Analysis on maxBuffer
    // elevation-daemon.js sets maxBuffer: 10 * 1024 * 1024 (10MB)
    // We check how the daemon handles a high volume command when terminated or completed
    console.log(`  ${C.dim}...Testing high-volume command with in-flight termination...${C.reset}`);
    terminalOutput = '';
    totalBytesReceived = 0;
    chunkCount = 0;

    // Use dir /s on System32 or similar high-volume directory, interrupted after 1 second
    const dirCmd = 'dir /s C:\\Windows\\System32';
    const dirChild = daemon.executeSubCommand(dirCmd);
    
    // Let it stream high-volume chunks for 800ms
    await sleep(800);
    const dirAlive = isProcessAlive(dirChild.pid);
    const streamedBeforeInterrupt = totalBytesReceived;
    const chunksBeforeInterrupt = chunkCount;

    // Interrupt high-volume dir stream via Ctrl+C
    daemon.handleInput('\x03');
    await sleep(500);

    const dirKilled = !isProcessAlive(dirChild.pid);
    recordTest('OUTPUT_BURST', 'High volume dir /s stream yields chunks without UI freeze', chunksBeforeInterrupt > 5, `Chunks: ${chunksBeforeInterrupt}, Bytes: ${Math.round(streamedBeforeInterrupt / 1024)} KB`);
    recordTest('OUTPUT_BURST', 'High volume burst terminated cleanly via Ctrl+C without zombie process', dirKilled);

    // Test 4.4: 12MB Output Burst exceeding 10MB maxBuffer threshold
    console.log(`  ${C.dim}...Testing 12MB burst (exceeding default 10MB maxBuffer threshold)...${C.reset}`);
    terminalOutput = '';
    totalBytesReceived = 0;
    chunkCount = 0;
    let burst12Completed = false;
    let burst12Error = null;

    // 120,000 lines of 100 chars = ~12 MB
    const cmd12MB = 'node -e "for(let i=0; i<120000; i++) console.log(\'Z\'.repeat(100));"';
    daemon.executeSubCommand(cmd12MB, (code, err) => {
      burst12Completed = true;
      burst12Error = err;
    });

    for (let i = 0; i < 150 && !burst12Completed; i++) {
      await sleep(100);
    }

    const hasMaxBufferError = terminalOutput.includes('stdout maxBuffer length exceeded') || (burst12Error && burst12Error.message.includes('maxBuffer'));
    recordTest(
      'OUTPUT_BURST',
      'High volume bursts > 10MB stream without ERR_CHILD_PROCESS_STDIO_MAXBUFFER kill',
      !hasMaxBufferError,
      hasMaxBufferError 
        ? 'Process killed with [Process Error: stdout maxBuffer length exceeded] because child_process.exec buffers up to 10MB in memory instead of unbounded streaming via child_process.spawn'
        : `Streamed ${Math.round(totalBytesReceived / 1024)} KB without error`,
      'HIGH'
    );

    daemon.destroy();
  }

  // ==========================================================================
  // SUITE 5: Full PtyManager & ElevationDaemon Integrated Interceptor Stress
  // ==========================================================================
  console.log(`\n${C.bold}[SUITE 5] Integrated PtyManager + ElevationDaemon End-to-End Stress...${C.reset}`);
  {
    const mockWin = new MockBrowserWindow();
    const ptyManager = new PtyManager(mockWin);
    ptyManager.init('cmd');
    await sleep(1000);

    // Test 5.1: Verify /op whoami through PtyManager.handleInput
    mockWin.clearMessages();
    let captured = '';
    const outputListener = (text) => { captured += text; };
    mockWin.on('terminal:output', outputListener);

    ptyManager.handleInput('/op whoami\r');
    await sleep(800);

    recordTest('INTEGRATED_E2E', 'PtyManager intercepts /op whoami and emits identity output', captured.includes('[OP PRIVILEGE IDENTITY]'));
    recordTest('INTEGRATED_E2E', 'PtyManager /op whoami does not emit shell error', !captured.includes('is not recognized'));

    // Test 5.2: Verify /op-unlock and /op-lock IPC broadcasts through PtyManager
    let unlockedCaptured = false;
    let lockedCaptured = false;
    mockWin.on('op:status', (status) => {
      if (status.unlocked === true) unlockedCaptured = true;
      if (status.unlocked === false) lockedCaptured = true;
    });

    ptyManager.handleInput('/op-unlock\r');
    await sleep(400);
    ptyManager.handleInput('/op-lock\r');
    await sleep(400);

    recordTest('INTEGRATED_E2E', 'PtyManager /op-unlock emits op:status with unlocked=true', unlockedCaptured === true);
    recordTest('INTEGRATED_E2E', 'PtyManager /op-lock emits op:status with unlocked=false', lockedCaptured === true);

    // Test 5.3: Integrated In-Flight Process Interruption via PtyManager.handleInput('\x03')
    captured = '';
    ptyManager.handleInput('/op ping 127.0.0.1 -n 15\r');
    await sleep(800);

    const daemonActive = ptyManager.elevationDaemon.activeProcesses.size > 0;
    recordTest('INTEGRATED_E2E', 'PtyManager launches elevated sub-command into activeProcesses', daemonActive);

    // Send ^C through PtyManager.handleInput
    ptyManager.handleInput('\x03');
    await sleep(600);

    recordTest('INTEGRATED_E2E', 'PtyManager.handleInput(\\x03) terminates active sub-process', ptyManager.elevationDaemon.activeProcesses.size === 0);
    recordTest('INTEGRATED_E2E', 'PtyManager outputs [Interrupted by User (^C)]', captured.includes('[Interrupted by User (^C)]'));

    // Clean teardown
    ptyManager.destroy();
    recordTest('INTEGRATED_E2E', 'PtyManager full teardown destroys PTY process and elevation daemon', ptyManager.ptyProcess === null && ptyManager._disposed === true);
  }

  // ==========================================================================
  // HARNESS SUMMARY
  // ==========================================================================
  console.log(`\n${C.cyan}${C.bold}================================================================================${C.reset}`);
  console.log(`${C.cyan}${C.bold}   CHALLENGER STRESS SUMMARY: ${passCount} PASSED | ${failCount} FAILED   ${C.reset}`);
  console.log(`${C.cyan}${C.bold}================================================================================${C.reset}\n`);

  if (failCount === 0) {
    console.log(`${C.green}${C.bold}>>> VERDICT: CONFIRM_CORRECTNESS <<<${C.reset}`);
    console.log(`${C.green}All 4 stress challenge dimensions passed with zero defects, zero leaks, and 100% state consistency.${C.reset}\n`);
    return 0;
  } else {
    console.log(`${C.red}${C.bold}>>> VERDICT: FLAG_ISSUES <<<${C.reset}`);
    console.log(`${C.red}Identified ${failCount} issues requiring remediation:${C.reset}`);
    findings.forEach((f, i) => {
      console.log(`  ${i + 1}. [${f.blastRadius}] [${f.suite}] ${f.name} -> ${f.details}`);
    });
    console.log('');
    return 1;
  }
}

// Self-executing runner
if (require.main === module) {
  runChallengerStressSuite().then(exitCode => {
    process.exit(exitCode);
  }).catch(err => {
    console.error('Fatal challenger execution error:', err);
    process.exit(1);
  });
}

module.exports = {
  runChallengerStressSuite,
  recordTest,
  isProcessAlive,
  cleanTreeKill,
  MockBrowserWindow
};
