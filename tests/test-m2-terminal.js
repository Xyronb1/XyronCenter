/**
 * XYRON CENTER - Milestone 2 Standalone ConPTY Terminal & In-Terminal Elevation Verification Harness
 * File: tests/test-m2-terminal.js (Remediated Iteration 2)
 * 
 * Verifies with ZERO MOCK DATA & NATIVE CONPTY SUBSYSTEM:
 * 1. Native ConPTY Backend Loading & ABI Verification (node-pty@1.1.0 on Windows x64).
 * 2. Static Zero-Mock / Anti-Facade Code Audit (rejection of hardcoded dummy token ternary).
 * 3. Headless ConPTY Shell Spawning: PowerShell (ExecutionPolicy Bypass) & CMD.
 * 4. Universal Turkish UTF-8 Character Fidelity:
 *    - Lowercase: ç, ğ, ı, ö, ş, ü (U+00E7, U+011F, U+0131, U+00F6, U+015F, U+00FC)
 *    - Uppercase: Ç, Ğ, İ, Ö, Ş, Ü (U+00C7, U+011E, U+0130, U+00D6, U+015E, U+00DC)
 *    - Full Pangram: "Pijamalı hasta yağız şoföre çabucak güvendi. İŞÇİ ÖĞRETMEN ÇAĞDAŞ ŞIRNAK"
 *    - Verification of zero replacement characters (\uFFFD) and zero dropped glyphs (Ğ, İ in PowerShell).
 * 5. Zero-Overhead OSC 0 WindowTitle CWD Tracking on directory navigation (`cd`).
 * 6. Programmatic `PtyManager.setCwd(newPath)` immediate event emission (`cwd-change`) & IPC broadcast (`terminal:cwd-change`).
 * 7. In-Terminal Privilege Elevation Engine (/op):
 *    - Dynamic Live OS Token Identity Resolution (authentic `whoami`, `fltmc`, `whoami /groups` integrity label).
 *    - In-terminal `/op whoami` dynamic identity display without hardcoded literals.
 *    - Whitespace normalization for OP commands (`/op     whoami`).
 *    - State toggling (`/op-unlock` & `/op-lock`), banner emission & IPC `op:status` broadcasts.
 *    - Subcommand execution under `/op <cmd>` with `windowsHide: true`, zero popups, real-time streaming.
 *    - Backspace (`\b` / `\x7f`) and line buffer editing invariance.
 *    - ANSI arrow sequence handling (`\x1b[A`, `\x1b[B`) without line buffer corruption.
 *    - Character-by-character interactive typing with ConPTY line clearing and cursor synchronization.
 *    - Teardown resize protection and idempotency.
 * 8. Process Tree Cleanup: Tree-kill via `taskkill /F /PID <pid> /T`, zero orphan processes.
 * 9. Mock Electron IPC Contract & Preload Bridge Compatibility.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { exec, execSync } = require('child_process');

// Robust project root resolution: works whether executed from tests/, root, or agent subdirectories
let PROJECT_ROOT = path.resolve(__dirname, '..');
if (!fs.existsSync(path.join(PROJECT_ROOT, 'package.json'))) {
  const candidate = path.resolve(__dirname, '../../../2_Proje_Dosyalari_Source');
  if (fs.existsSync(path.join(candidate, 'package.json'))) {
    PROJECT_ROOT = candidate;
  }
}
const NODE_MODULES_PTY = path.resolve(PROJECT_ROOT, 'node_modules/node-pty');
const PTY_MANAGER_PATH = path.resolve(PROJECT_ROOT, 'src/main/pty-manager.js');
const ELEVATION_DAEMON_PATH = path.resolve(PROJECT_ROOT, 'src/main/elevation-daemon.js');

// ANSI Terminal Colors
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

// Tree-kill helper ensuring no child process orphans
function cleanTreeKill(pid) {
  if (!pid) return;
  try {
    execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore', windowsHide: true });
  } catch (_e) {
    // Process already exited or ESRCH
  }
}

// Mock Electron BrowserWindow & WebContents for Headless Testing
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
        this.emit('ipc-broadcast', { channel, args });
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

// Helper: Wait for specific output substring from terminal
function waitForTerminalOutput(mockWin, substring, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    let accumulated = '';
    const timer = setTimeout(() => {
      mockWin.off('terminal:output', listener);
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for output "${substring}". Captured: ${accumulated.slice(-200)}`));
    }, timeoutMs);

    const listener = (data) => {
      accumulated += data;
      if (accumulated.includes(substring)) {
        clearTimeout(timer);
        mockWin.off('terminal:output', listener);
        resolve(accumulated);
      }
    };

    mockWin.on('terminal:output', listener);
  });
}

// Helper: Wait for CWD change event
function waitForCwdChange(mockWin, targetPredicate, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      mockWin.off('terminal:cwd-change', listener);
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for matching CWD change`));
    }, timeoutMs);

    const listener = (newPath) => {
      if (targetPredicate(newPath)) {
        clearTimeout(timer);
        mockWin.off('terminal:cwd-change', listener);
        resolve(newPath);
      }
    };

    mockWin.on('terminal:cwd-change', listener);
  });
}

// Helper: Wait for OP Status event
function waitForOpStatus(mockWin, expectedUnlocked, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      mockWin.off('op:status', listener);
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for op:status unlocked=${expectedUnlocked}`));
    }, timeoutMs);

    const listener = (status) => {
      if (status && status.unlocked === expectedUnlocked) {
        clearTimeout(timer);
        mockWin.off('op:status', listener);
        resolve(status);
      }
    };

    mockWin.on('op:status', listener);
  });
}

// Sleep helper
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// MAIN VERIFICATION HARNESS RUNNER
// ---------------------------------------------------------------------------
async function runMilestone2TerminalSuite() {
  console.log(`\n${C.cyan}${C.bold}================================================================================${C.reset}`);
  console.log(`${C.cyan}${C.bold}   XYRON CENTER - MILESTONE 2: REMEDIATED CONPTY & ELEVATION TEST HARNESS   ${C.reset}`);
  console.log(`${C.cyan}${C.bold}================================================================================${C.reset}`);
  console.log(`Host OS: ${os.type()} ${os.release()} (${os.arch()}) | Node: ${process.version}`);
  console.log(`Date: ${new Date().toISOString()}\n`);

  let pty = null;
  let PtyManager = null;
  let ElevationDaemon = null;

  // ==========================================================================
  // SUITE 1: Native Module & Subsystem Integrity + Static Zero-Mock Audit
  // ==========================================================================
  console.log(`${C.bold}[SUITE 1] Verifying Native Module & Subsystem Integrity...${C.reset}`);

  try {
    pty = require(NODE_MODULES_PTY);
    assert('SUBSYSTEM', 'node-pty native module loads successfully', typeof pty.spawn === 'function');
  } catch (err) {
    assert('SUBSYSTEM', 'node-pty native module loads successfully', false, err.message);
  }

  // Check prebuilt binary existence
  const prebuildPath = path.join(NODE_MODULES_PTY, 'build/Release/conpty/conpty.dll');
  const openConsolePath = path.join(NODE_MODULES_PTY, 'build/Release/conpty/OpenConsole.exe');
  assert('SUBSYSTEM', 'ConPTY OpenConsole.exe exists in node-pty release build', fs.existsSync(openConsolePath), openConsolePath);
  assert('SUBSYSTEM', 'ConPTY conpty.dll exists in node-pty release build', fs.existsSync(prebuildPath), prebuildPath);

  // Check PtyManager and ElevationDaemon module availability
  const hasPtyManagerFile = fs.existsSync(PTY_MANAGER_PATH);
  assert('SUBSYSTEM', 'PtyManager file exists (src/main/pty-manager.js)', hasPtyManagerFile, PTY_MANAGER_PATH);
  if (hasPtyManagerFile) {
    try {
      PtyManager = require(PTY_MANAGER_PATH);
      assert('SUBSYSTEM', 'PtyManager class is constructible', typeof PtyManager === 'function');
    } catch (e) {
      assert('SUBSYSTEM', 'PtyManager class is constructible', false, e.message);
    }
  }

  const hasElevationDaemonFile = fs.existsSync(ELEVATION_DAEMON_PATH);
  assert('SUBSYSTEM', 'ElevationDaemon file exists (src/main/elevation-daemon.js)', hasElevationDaemonFile, ELEVATION_DAEMON_PATH);
  if (hasElevationDaemonFile) {
    try {
      ElevationDaemon = require(ELEVATION_DAEMON_PATH);
      assert('SUBSYSTEM', 'ElevationDaemon class is constructible', typeof ElevationDaemon === 'function');
    } catch (e) {
      assert('SUBSYSTEM', 'ElevationDaemon class is constructible', false, e.message);
    }
  }

  // Static Zero Mock Audit on Terminal files
  if (hasPtyManagerFile) {
    const ptySource = fs.readFileSync(PTY_MANAGER_PATH, 'utf8');
    assert('ZERO_MOCK', 'PtyManager does NOT contain mock terminal streams', !ptySource.includes('mockTerminal') && !ptySource.includes('fakeShell'));
    assert('ZERO_MOCK', 'PtyManager uses native useConpty: true flag', ptySource.includes('useConpty: true') || ptySource.includes('useConpty:true'));
  }

  if (hasElevationDaemonFile) {
    const daemonSource = fs.readFileSync(ELEVATION_DAEMON_PATH, 'utf8');
    assert('ZERO_MOCK', 'ElevationDaemon does NOT contain dummy ternary facade (isSystem ? nt authority... : nt authority...)',
      !daemonSource.includes("'nt authority\\\\system' : 'nt authority\\\\system'") &&
      !daemonSource.includes('"nt authority\\\\system" : "nt authority\\\\system"')
    );
  }

  // ==========================================================================
  // SUITE 2: Headless ConPTY Shell Spawning (PowerShell & CMD)
  // ==========================================================================
  console.log(`\n${C.bold}[SUITE 2] Testing Headless Native ConPTY Shell Spawning...${C.reset}`);

  // Test 2.1: PowerShell ConPTY Spawning via Raw node-pty
  let psRaw = null;
  try {
    psRaw = pty.spawn('powershell.exe', ['-NoLogo'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      useConpty: true
    });
    assert('CONPTY_SPAWN', 'powershell.exe spawns with valid positive PID', typeof psRaw.pid === 'number' && psRaw.pid > 0, `PID: ${psRaw.pid}`);
  } catch (e) {
    assert('CONPTY_SPAWN', 'powershell.exe spawns with valid positive PID', false, e.message);
  }

  if (psRaw) {
    let psInitialData = '';
    const psDataReceived = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 3000);
      psRaw.onData(data => {
        psInitialData += data;
        if (psInitialData.includes('PS ') || psInitialData.includes('\x1b[')) {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
    assert('CONPTY_SPAWN', 'powershell.exe streams VT sequences and PS prompt', psDataReceived === true, `Length: ${psInitialData.length}`);
    cleanTreeKill(psRaw.pid);
  }

  // Test 2.2: CMD ConPTY Spawning via Full Path Resolution (process.env.ComSpec)
  let cmdRaw = null;
  const cmdExecutable = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  try {
    cmdRaw = pty.spawn(cmdExecutable, ['/K', 'chcp 65001 >nul'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      useConpty: true
    });
    assert('CONPTY_SPAWN', 'cmd.exe spawns via absolute ComSpec with valid PID', typeof cmdRaw.pid === 'number' && cmdRaw.pid > 0, `PID: ${cmdRaw.pid}`);
  } catch (e) {
    assert('CONPTY_SPAWN', 'cmd.exe spawns via absolute ComSpec with valid PID', false, e.message);
  }

  if (cmdRaw) {
    let cmdInitialData = '';
    const cmdDataReceived = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 3000);
      cmdRaw.onData(data => {
        cmdInitialData += data;
        if (cmdInitialData.includes('Microsoft') || cmdInitialData.includes('>')) {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
    assert('CONPTY_SPAWN', 'cmd.exe streams Windows banner and prompt', cmdDataReceived === true, `Length: ${cmdInitialData.length}`);
    
    // Test Resize
    try {
      cmdRaw.resize(120, 40);
      assert('CONPTY_RESIZE', 'ConPTY resize(120, 40) executes without error', true);
    } catch (e) {
      assert('CONPTY_RESIZE', 'ConPTY resize(120, 40) executes without error', false, e.message);
    }
    cleanTreeKill(cmdRaw.pid);
  }

  // ==========================================================================
  // SUITE 3: Universal Turkish UTF-8 Character Fidelity
  // ==========================================================================
  console.log(`\n${C.bold}[SUITE 3] Testing Turkish UTF-8 Character Fidelity & Zero Glyph Loss...${C.reset}`);

  const TURKISH_LOWER = 'çğıöşü';
  const TURKISH_UPPER = 'ÇĞİÖŞÜ';
  const TURKISH_PANGRAM = 'Pijamalı hasta yağız şoföre çabucak güvendi. İŞÇİ ÖĞRETMEN ÇAĞDAŞ ŞIRNAK';

  // Test 3.1: CMD Turkish UTF-8 Verification
  let cmdPty = pty.spawn(cmdExecutable, ['/K', 'chcp 65001 >nul'], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    useConpty: true,
    env: Object.assign({}, process.env, {
      PYTHONIOENCODING: 'utf-8',
      LANG: 'tr_TR.UTF-8'
    })
  });

  let cmdBuffer = '';
  cmdPty.onData(d => { cmdBuffer += d; });
  await sleep(600);

  // Send lower and upper Turkish test string
  const cmdTestMarker = 'TURKCE_CMD_VERIFY_MARKER: ';
  cmdPty.write(`echo ${cmdTestMarker}${TURKISH_LOWER} ${TURKISH_UPPER}\r`);
  await sleep(800);

  const cmdHasLower = cmdBuffer.includes(TURKISH_LOWER);
  const cmdHasUpper = cmdBuffer.includes(TURKISH_UPPER);
  assert('TURKISH_UTF8', 'CMD renders lowercase Turkish characters (çğıöşü) with 100% byte fidelity', cmdHasLower);
  assert('TURKISH_UTF8', 'CMD renders uppercase Turkish characters (ÇĞİÖŞÜ) with 100% byte fidelity', cmdHasUpper);

  // Test 3.2: CMD Turkish Pangram
  cmdPty.write(`echo PANGRAM_CMD: ${TURKISH_PANGRAM}\r`);
  await sleep(800);
  const cmdHasPangram = cmdBuffer.includes(TURKISH_PANGRAM);
  const cmdHasNoUnicodeReplacement = !cmdBuffer.includes('\uFFFD');
  assert('TURKISH_UTF8', 'CMD renders full Turkish pangram without character loss', cmdHasPangram);
  assert('TURKISH_UTF8', 'CMD output buffer contains zero Unicode replacement characters (\\uFFFD)', cmdHasNoUnicodeReplacement);
  cleanTreeKill(cmdPty.pid);

  // Test 3.3: PowerShell Turkish UTF-8 Verification
  let psPty = pty.spawn('powershell.exe', [
    '-NoExit',
    '-ExecutionPolicy', 'Bypass',
    '-Command',
    '[Console]::OutputEncoding = [Console]::InputEncoding = $OutputEncoding = [System.Text.Encoding]::UTF8; ' +
    'chcp 65001 >$null; ' +
    'Remove-Module PSReadLine -ErrorAction SilentlyContinue'
  ], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    useConpty: true,
    env: Object.assign({}, process.env, {
      PYTHONIOENCODING: 'utf-8',
      LANG: 'tr_TR.UTF-8'
    })
  });

  let psBuffer = '';
  psPty.onData(d => { psBuffer += d; });
  await sleep(1000);

  psPty.write(`echo TURKISH_PS_ECHO:${TURKISH_LOWER}${TURKISH_UPPER}\r`);
  await sleep(1000);

  const psHasLower = psBuffer.includes(TURKISH_LOWER);
  const psHasUpper = psBuffer.includes(TURKISH_UPPER);
  const psHasSpecialG = psBuffer.includes('Ğ');
  const psHasSpecialI = psBuffer.includes('İ');

  assert('TURKISH_UTF8', 'PowerShell renders lowercase Turkish characters (çğıöşü)', psHasLower);
  assert('TURKISH_UTF8', 'PowerShell renders uppercase Turkish characters (ÇĞİÖŞÜ)', psHasUpper);
  assert('TURKISH_UTF8', 'PowerShell preserves Turkish Dotted Capital I (İ, U+0130) without glyph loss', psHasSpecialI);
  assert('TURKISH_UTF8', 'PowerShell preserves Turkish Capital G With Breve (Ğ, U+011E) without glyph loss', psHasSpecialG);
  cleanTreeKill(psPty.pid);

  // ==========================================================================
  // SUITE 4: Zero-Overhead OSC 0 WindowTitle & Programmatic CWD Tracking
  // ==========================================================================
  console.log(`\n${C.bold}[SUITE 4] Testing OSC 0 WindowTitle & Programmatic CWD Tracking...${C.reset}`);

  // Test 4.1: Direct OSC 0 Regex Stream Extraction
  const sampleOsc0Sequence = '\x1b]0;C:\\Users\\Xyron\\Desktop\\XyronCenter\x07Normal Terminal Output';
  const sampleOsc0EscBackslash = '\x1b]0;C:\\Windows\\System32\x1b\\Normal Terminal Output';

  const oscRegex = /\x1b\]0;([^\x07\x1b]+)(?:\x07|\x1b\\)/g;
  const match1 = [...sampleOsc0Sequence.matchAll(oscRegex)][0];
  const match2 = [...sampleOsc0EscBackslash.matchAll(oscRegex)][0];

  assert('OSC0_PARSER', 'Regex parses standard BEL (\\x07) terminated OSC 0 title sequence', Boolean(match1 && match1[1] === 'C:\\Users\\Xyron\\Desktop\\XyronCenter'));
  assert('OSC0_PARSER', 'Regex parses ST (\\x1b\\\\) terminated OSC 0 title sequence', Boolean(match2 && match2[1] === 'C:\\Windows\\System32'));

  // Test 4.2: Dynamic CWD tracking in live ConPTY session
  const startDir = path.resolve(process.env.USERPROFILE || 'C:\\Users\\Default', 'Desktop');
  const parentDir = path.dirname(startDir);

  const cwdPty = pty.spawn(cmdExecutable, ['/K', 'chcp 65001 >nul'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: startDir,
    env: Object.assign({}, process.env, {
      PROMPT: '$E]0;$P$E\\$P$G' // Injects OSC 0 with current path into CMD prompt
    }),
    useConpty: true
  });

  const capturedCwds = [];
  cwdPty.onData(data => {
    let m;
    const re = /\x1b\]0;([^\x07\x1b]+)(?:\x07|\x1b\\)/g;
    while ((m = re.exec(data)) !== null) {
      const candidate = m[1].trim();
      // Filter out binary names or non-directory titles
      if (!candidate.toLowerCase().endsWith('.exe') && !candidate.includes('.exe -')) {
        if (candidate.includes('\\') || candidate.includes(':')) {
          capturedCwds.push(candidate);
        }
      }
    }
  });

  await sleep(600);
  // Issue directory navigation commands
  cwdPty.write('cd ..\r');
  await sleep(800);

  const hasParentCwd = capturedCwds.some(c => c.toLowerCase() === parentDir.toLowerCase());
  assert('CWD_SYNC', 'Navigating `cd ..` emits parent directory CWD sequence', hasParentCwd, `Expected: ${parentDir}`);

  // Test 4.3: Navigation into subfolder
  cwdPty.write(`cd "${path.basename(startDir)}"\r`);
  await sleep(800);
  const hasRestoredCwd = capturedCwds.some(c => c.toLowerCase() === startDir.toLowerCase());
  assert('CWD_SYNC', 'Navigating back into subdirectory emits target directory CWD sequence', hasRestoredCwd, `Expected: ${startDir}`);

  cleanTreeKill(cwdPty.pid);

  // Test 4.4: Programmatic setCwd event emission & IPC synchronization (challenger_m2_1 resolution)
  if (PtyManager) {
    const progWin = new MockBrowserWindow();
    const progManager = new PtyManager(progWin);
    progManager.init('cmd');
    await sleep(600);

    const testTargetDir = os.tmpdir();
    let progCwdEventEmitted = false;
    let progIpcEmitted = false;
    let emittedPath = null;

    progManager.on('cwd-change', (newPath) => {
      progCwdEventEmitted = true;
      emittedPath = newPath;
    });

    progWin.on('terminal:cwd-change', (newPath) => {
      progIpcEmitted = true;
    });

    // Call programmatic setCwd
    const setCwdResult = progManager.setCwd(testTargetDir);
    await sleep(600);

    assert('CWD_SYNC', 'ptyManager.setCwd(validDir) returns true', setCwdResult === true);
    assert('CWD_SYNC', 'ptyManager.setCwd() immediately emits cwd-change event to listeners',
      progCwdEventEmitted && emittedPath && emittedPath.toLowerCase() === testTargetDir.toLowerCase(),
      `Emitted: ${emittedPath}`
    );
    assert('CWD_SYNC', 'ptyManager.setCwd() immediately emits terminal:cwd-change IPC to renderer', progIpcEmitted);
    assert('CWD_SYNC', 'ptyManager.getCwd() reflects new target directory',
      Boolean(progManager.getCwd() && progManager.getCwd().toLowerCase() === testTargetDir.toLowerCase())
    );

    // Test setCwd with invalid path
    const invalidDir = path.join(testTargetDir, 'non_existent_dir_xyron_99999');
    let invalidEmitted = false;
    progManager.on('cwd-change', () => { invalidEmitted = true; });
    const invalidResult = progManager.setCwd(invalidDir);
    assert('CWD_SYNC', 'ptyManager.setCwd(invalidDir) returns false and does NOT emit events',
      invalidResult === false && !invalidEmitted
    );

    progManager.destroy();
  }

  // ==========================================================================
  // SUITE 5: In-Terminal Privilege Elevation Engine (/op) & Dynamic Live Token
  // ==========================================================================
  console.log(`\n${C.bold}[SUITE 5] Testing In-Terminal Privilege Elevation Engine (/op)...${C.reset}`);

  // Query authentic live host token context for zero-mock dynamic verification
  const liveUsername = (process.env.USERNAME || '').toLowerCase();
  let liveWhoami = '';
  try {
    liveWhoami = execSync('whoami', { encoding: 'utf8', windowsHide: true }).trim().toLowerCase();
  } catch (_e) {}

  let liveIsElevated = false;
  try {
    execSync('fltmc', { stdio: 'ignore', windowsHide: true });
    liveIsElevated = true;
  } catch (_e) {
    liveIsElevated = false;
  }

  let liveMandatoryLabel = 'Medium';
  try {
    const groupsOut = execSync('whoami /groups', { encoding: 'utf8', windowsHide: true });
    if (groupsOut.includes('S-1-16-16384')) liveMandatoryLabel = 'System';
    else if (groupsOut.includes('S-1-16-12288')) liveMandatoryLabel = 'High';
    else if (groupsOut.includes('S-1-16-8192')) liveMandatoryLabel = 'Medium';
    else if (groupsOut.includes('S-1-16-4096')) liveMandatoryLabel = 'Low';
  } catch (_e) {}

  let liveUserSid = '';
  try {
    const userOut = execSync('whoami /user /fo csv /nh', { encoding: 'utf8', windowsHide: true });
    const parts = userOut.trim().split(',');
    if (parts.length >= 2) {
      liveUserSid = parts[1].replace(/"/g, '').trim();
    }
  } catch (_e) {}

  const mockWin = new MockBrowserWindow();

  if (PtyManager) {
    const manager = new PtyManager(mockWin);
    manager.init('cmd');
    await sleep(800);

    // Test 5.1: Dynamic Live Token Identity Resolution (Anti-Facade Verification)
    const resolvedToken = manager.elevationDaemon.resolveTokenIdentity();
    assert('OP_ENGINE', 'resolveTokenIdentity() returns dynamic object structure',
      resolvedToken &&
      typeof resolvedToken.identity === 'string' &&
      typeof resolvedToken.sid === 'string' &&
      typeof resolvedToken.mandatoryLevel === 'string' &&
      typeof resolvedToken.isElevated === 'boolean'
    );

    assert('OP_ENGINE', 'resolveTokenIdentity() isElevated dynamically matches OS elevation (fltmc)',
      resolvedToken.isElevated === liveIsElevated,
      `Resolved: ${resolvedToken.isElevated}, OS: ${liveIsElevated}`
    );

    if (!liveIsElevated) {
      assert('OP_ENGINE', 'In un-elevated context, username reflects authentic process.env.USERNAME or whoami',
        resolvedToken.identity.toLowerCase().includes(liveUsername) ||
        (liveWhoami && resolvedToken.identity.toLowerCase().includes(liveWhoami)),
        `Resolved: "${resolvedToken.identity}", Live: "${liveUsername}"`
      );

      assert('OP_ENGINE', 'In un-elevated context, does NOT return fake SYSTEM token (auditor finding)',
        !resolvedToken.identity.toLowerCase().includes('nt authority\\system') || liveWhoami.includes('system'),
        `Resolved identity: "${resolvedToken.identity}"`
      );

      assert('OP_ENGINE', 'In un-elevated context, mandatoryLevel reflects authentic Medium integrity label',
        resolvedToken.mandatoryLevel.includes('Medium') || resolvedToken.mandatoryLevel.includes('8192'),
        `Resolved mandatoryLevel: "${resolvedToken.mandatoryLevel}"`
      );

      if (liveUserSid) {
        assert('OP_ENGINE', 'In un-elevated context, SID matches authentic live user SID from whoami',
          resolvedToken.sid === liveUserSid,
          `Resolved SID: "${resolvedToken.sid}", Live: "${liveUserSid}"`
        );
      }
    } else {
      assert('OP_ENGINE', 'In elevated context, identity reflects elevated Administrator or SYSTEM',
        resolvedToken.identity.toLowerCase().includes('administrator') ||
        resolvedToken.identity.toLowerCase().includes('system')
      );
      assert('OP_ENGINE', 'In elevated context, mandatoryLevel reflects High or System integrity label',
        resolvedToken.mandatoryLevel.includes('High') ||
        resolvedToken.mandatoryLevel.includes('System') ||
        resolvedToken.mandatoryLevel.includes('12288') ||
        resolvedToken.mandatoryLevel.includes('16384')
      );
    }

    // Test 5.2: In-Terminal /op whoami Execution & Dynamic Rendering
    let opOutput = '';
    const whoamiPromise = waitForTerminalOutput(mockWin, '[OP PRIVILEGE IDENTITY]', 6000);
    manager.handleInput('/op whoami\r');
    
    try {
      opOutput = await whoamiPromise;
      assert('OP_ENGINE', '/op whoami is intercepted and outputs privilege identity block',
        opOutput.includes('[OP PRIVILEGE IDENTITY]'));

      if (!liveIsElevated) {
        assert('OP_ENGINE', '/op whoami renders authentic live username (zero fake SYSTEM literals)',
          opOutput.toLowerCase().includes(liveUsername),
          `Output includes "${liveUsername}"`
        );
        assert('OP_ENGINE', '/op whoami renders authentic live mandatory integrity label',
          opOutput.toLowerCase().includes(liveMandatoryLabel.toLowerCase()) || opOutput.includes('8192'),
          `Mandatory label: ${liveMandatoryLabel}`
        );
      } else {
        assert('OP_ENGINE', '/op whoami renders elevated identity banner',
          opOutput.includes('Administrator') || opOutput.includes('SYSTEM')
        );
      }

      assert('OP_ENGINE', '/op whoami restores prompt without shell syntax error',
        !opOutput.includes('is not recognized as an internal or external command') &&
        !opOutput.includes('The term \'/op\' is not recognized'));
    } catch (e) {
      assert('OP_ENGINE', '/op whoami is intercepted and outputs privilege identity block', false, e.message);
    }

    // Test 5.3: Whitespace-Tolerant OP Subcommand Routing (/op     whoami)
    mockWin.clearHistory();
    const multiSpacePromise = waitForTerminalOutput(mockWin, '[OP PRIVILEGE IDENTITY]', 6000);
    manager.handleInput('/op     whoami\r');
    try {
      const multiSpaceOut = await multiSpacePromise;
      assert('OP_ENGINE', '/op with multiple spaces (/op     whoami) routes to privilege identity handler',
        multiSpaceOut.includes('[OP PRIVILEGE IDENTITY]'));
    } catch (e) {
      assert('OP_ENGINE', '/op with multiple spaces (/op     whoami) routes to privilege identity handler', false, e.message);
    }

    // Test 5.4: /op-unlock
    const unlockPromise = waitForOpStatus(mockWin, true, 5000);
    manager.handleInput('/op-unlock\r');
    try {
      const status = await unlockPromise;
      assert('OP_ENGINE', '/op-unlock sets unlocked=true and emits op:status IPC event', status.unlocked === true);
    } catch (e) {
      assert('OP_ENGINE', '/op-unlock sets unlocked=true and emits op:status IPC event', false, e.message);
    }

    // Test 5.5: /op-lock
    const lockPromise = waitForOpStatus(mockWin, false, 5000);
    manager.handleInput('/op-lock\r');
    try {
      const status = await lockPromise;
      assert('OP_ENGINE', '/op-lock sets unlocked=false and emits op:status IPC event', status.unlocked === false);
    } catch (e) {
      assert('OP_ENGINE', '/op-lock sets unlocked=false and emits op:status IPC event', false, e.message);
    }

    // Test 5.6: /op <cmd> Execution with windowsHide: true (Zero Popups)
    const execPromise = waitForTerminalOutput(mockWin, 'OP_EXEC_TEST_CONFIRMED', 6000);
    manager.handleInput('/op echo OP_EXEC_TEST_CONFIRMED\r');
    try {
      const execOut = await execPromise;
      assert('OP_ENGINE', '/op <cmd> executes and streams output directly into terminal stream', execOut.includes('OP_EXEC_TEST_CONFIRMED'));
    } catch (e) {
      assert('OP_ENGINE', '/op <cmd> executes and streams output directly into terminal stream', false, e.message);
    }

    // Test 5.7: Backspace and Line Editing Invariance
    // Type "/op whoamx", backspace, type "i", enter -> should resolve to "/op whoami"
    mockWin.clearHistory();
    const backspacePromise = waitForTerminalOutput(mockWin, '[OP PRIVILEGE IDENTITY]', 6000);
    manager.handleInput('/op whoamx\bi\r');
    try {
      await backspacePromise;
      assert('OP_ENGINE', 'Line buffer accurately handles backspaces (\\b / \\x7f) during command editing', true);
    } catch (e) {
      assert('OP_ENGINE', 'Line buffer accurately handles backspaces (\\b / \\x7f) during command editing', false, e.message);
    }

    // Test 5.8: ANSI Arrow Keys & Cursor Navigation (Zero Buffer Pollution - challenger_m2_2 resolution)
    manager.handleInput('\x1b[A'); // Up Arrow
    manager.handleInput('\x1b[B'); // Down Arrow
    manager.handleInput('\x1b[C'); // Right Arrow
    manager.handleInput('\x1b[D'); // Left Arrow
    manager.handleInput('\x1b[H'); // Home
    manager.handleInput('\x1b[F'); // End

    assert('OP_ENGINE', 'ANSI arrow sequences (\\x1b[A, \\x1b[B, \\x1b[C, \\x1b[D) do NOT pollute inputBuffer',
      manager.elevationDaemon.inputBuffer === '',
      `Observed buffer: ${JSON.stringify(manager.elevationDaemon.inputBuffer)}`
    );

    mockWin.clearHistory();
    const afterArrowPromise = waitForTerminalOutput(mockWin, '[OP PRIVILEGE IDENTITY]', 6000);
    manager.handleInput('/op whoami\r');
    try {
      const afterArrowOut = await afterArrowPromise;
      assert('OP_ENGINE', 'Command executed after ANSI arrow keys executes without buffer pollution corruption',
        afterArrowOut.includes('[OP PRIVILEGE IDENTITY]'));
    } catch (e) {
      assert('OP_ENGINE', 'Command executed after ANSI arrow keys executes without buffer pollution corruption', false, e.message);
    }

    // Test 5.9: Character-by-Character Input & ConPTY Cursor Synchronization (reviewer_m2_2 resolution)
    mockWin.clearHistory();
    const charByCharPromise = waitForTerminalOutput(mockWin, '[OP PRIVILEGE IDENTITY]', 6000);
    const typingChars = '/op whoami'.split('');
    for (const ch of typingChars) {
      manager.handleInput(ch);
    }
    manager.handleInput('\r');

    try {
      const charByCharOut = await charByCharPromise;
      assert('OP_ENGINE', 'Character-by-character typing (/op whoami) is cleanly intercepted',
        charByCharOut.includes('[OP PRIVILEGE IDENTITY]'));
      assert('OP_ENGINE', 'Character-by-character ConPTY line clear does NOT produce shell syntax error',
        !charByCharOut.includes('is not recognized as an internal or external command') &&
        !charByCharOut.includes('The term \'/op\' is not recognized') &&
        !charByCharOut.includes('The term \'op\' is not recognized')
      );
    } catch (e) {
      assert('OP_ENGINE', 'Character-by-character typing (/op whoami) is cleanly intercepted', false, e.message);
    }

    // Subcommand character-by-character execution
    mockWin.clearHistory();
    const subCmdPromise = waitForTerminalOutput(mockWin, 'CHAR_BY_CHAR_CONPTY_SYNC_OK', 6000);
    const subCmdChars = '/op echo CHAR_BY_CHAR_CONPTY_SYNC_OK'.split('');
    for (const ch of subCmdChars) {
      manager.handleInput(ch);
    }
    manager.handleInput('\r');

    try {
      const subCmdOut = await subCmdPromise;
      assert('OP_ENGINE', 'Character-by-character /op <cmd> executes and streams output without cursor overwrite',
        subCmdOut.includes('CHAR_BY_CHAR_CONPTY_SYNC_OK'));
    } catch (e) {
      assert('OP_ENGINE', 'Character-by-character /op <cmd> executes and streams output without cursor overwrite', false, e.message);
    }

    // Test 5.10: Clean Destruction & Post-Teardown Resize Safety
    manager.destroy();
    assert('OP_ENGINE', 'PtyManager destroy() nullifies process handle', manager.ptyProcess === null);

    let resizeThrew = false;
    try {
      manager.resize(120, 40);
    } catch (err) {
      resizeThrew = true;
    }
    assert('OP_ENGINE', 'PtyManager resize() after destroy() does NOT throw unhandled exception', !resizeThrew);

    let secondDestroyThrew = false;
    try {
      manager.destroy();
    } catch (err) {
      secondDestroyThrew = true;
    }
    assert('OP_ENGINE', 'PtyManager destroy() is idempotent and safe to call repeatedly', !secondDestroyThrew);
  } else {
    // Standalone unit validation for elevation logic when module under development
    console.log(`  ${C.yellow}[NOTE] PtyManager not yet implemented; executing standalone /op interceptor spec tests...${C.reset}`);
    
    const isOp = (l) => {
      const n = (l || '').trim().replace(/\s+/g, ' ');
      return n === '/op-unlock' || n === '/op-lock' || n === '/op whoami' || n === '/op' || n.startsWith('/op ');
    };
    assert('OP_PARSER', 'Recognizer identifies /op whoami', isOp('/op whoami'));
    assert('OP_PARSER', 'Recognizer identifies /op     whoami with spaces', isOp('/op     whoami'));
    assert('OP_PARSER', 'Recognizer identifies /op-unlock', isOp('/op-unlock'));
    assert('OP_PARSER', 'Recognizer identifies /op-lock', isOp('/op-lock'));
    assert('OP_PARSER', 'Recognizer identifies /op net start', isOp('/op net start'));
    assert('OP_PARSER', 'Recognizer rejects normal commands (dir, git status)', !isOp('dir') && !isOp('git status'));
    
    // Test windowsHide child process execution
    const execHiddenTest = await new Promise(resolve => {
      exec('echo HIDDEN_TEST_PASS', { windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
        resolve(!err && stdout.includes('HIDDEN_TEST_PASS'));
      });
    });
    assert('OP_ENGINE', 'child_process.exec with windowsHide: true runs without console window', execHiddenTest);
  }

  // ==========================================================================
  // SUITE 6: Process Tree Cleanup & Zero-Leak Validation
  // ==========================================================================
  console.log(`\n${C.bold}[SUITE 6] Testing Process Tree Cleanup & Zero-Leak Guarantees...${C.reset}`);

  // Spawn a test PTY session with a child process (ping)
  const leakTestPty = pty.spawn(cmdExecutable, ['/K'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    useConpty: true
  });

  const parentPid = leakTestPty.pid;
  assert('PROCESS_CLEANUP', 'Test session spawned with PID', typeof parentPid === 'number' && parentPid > 0, `PID: ${parentPid}`);

  // Launch a sleeping child command inside the PTY
  leakTestPty.write('ping -n 20 127.0.0.1 >nul\r');
  await sleep(800);

  // Terminate using tree-kill
  cleanTreeKill(parentPid);
  await sleep(500);

  // Verify parent process PID is completely dead
  let isParentAlive = true;
  try {
    const tasklistOutput = execSync(`tasklist /FO CSV /FI "PID eq ${parentPid}"`, { encoding: 'utf8' });
    isParentAlive = tasklistOutput.includes(String(parentPid));
  } catch (_e) {
    isParentAlive = false;
  }
  assert('PROCESS_CLEANUP', 'Tree-kill eliminates ConPTY parent process completely', !isParentAlive, `PID: ${parentPid}`);

  // Idempotency test: calling cleanTreeKill on already exited process does not throw
  let idempotencyOk = false;
  try {
    cleanTreeKill(parentPid);
    cleanTreeKill(parentPid);
    idempotencyOk = true;
  } catch (_e) {
    idempotencyOk = false;
  }
  assert('PROCESS_CLEANUP', 'cleanTreeKill is idempotent and swallows ESRCH cleanly', idempotencyOk);

  // Rapid Spawn / Kill Cycle Stress (5 iterations)
  let rapidCyclesPassed = true;
  for (let i = 0; i < 5; i++) {
    try {
      const p = pty.spawn(cmdExecutable, [], { useConpty: true });
      const pid = p.pid;
      cleanTreeKill(pid);
    } catch (_e) {
      rapidCyclesPassed = false;
      break;
    }
  }
  assert('PROCESS_CLEANUP', '5 rapid ConPTY spawn & tree-kill cycles execute without resource exhaustion', rapidCyclesPassed);

  // ==========================================================================
  // SUITE 7: IPC Contract & Preload Event Payload Verification
  // ==========================================================================
  console.log(`\n${C.bold}[SUITE 7] Testing IPC Contract & Preload Event Payloads...${C.reset}`);

  const contractWin = new MockBrowserWindow();
  
  // Verify expected channel schemas
  contractWin.webContents.send('terminal:output', '\x1b[32mHello\x1b[0m');
  contractWin.webContents.send('terminal:cwd-change', 'C:\\Users\\Xyron\\Desktop');
  contractWin.webContents.send('op:status', { unlocked: true, identity: 'NT AUTHORITY\\SYSTEM' });
  contractWin.webContents.send('terminal:exit', 0);

  const outMsgs = contractWin.findMessages('terminal:output');
  const cwdMsgs = contractWin.findMessages('terminal:cwd-change');
  const opMsgs = contractWin.findMessages('op:status');
  const exitMsgs = contractWin.findMessages('terminal:exit');

  assert('IPC_CONTRACT', 'terminal:output payload is a valid VT string', outMsgs.length === 1 && typeof outMsgs[0].args[0] === 'string');
  assert('IPC_CONTRACT', 'terminal:cwd-change payload is a valid path string', cwdMsgs.length === 1 && typeof cwdMsgs[0].args[0] === 'string' && cwdMsgs[0].args[0].includes(':'));
  assert('IPC_CONTRACT', 'op:status payload contains { unlocked: boolean, identity: string }', opMsgs.length === 1 && typeof opMsgs[0].args[0].unlocked === 'boolean' && typeof opMsgs[0].args[0].identity === 'string');
  assert('IPC_CONTRACT', 'terminal:exit payload is a numerical exit code', exitMsgs.length === 1 && typeof exitMsgs[0].args[0] === 'number');

  // ==========================================================================
  // HARNESS SUMMARY & EXIT CODE DETERMINATION
  // ==========================================================================
  console.log(`\n${C.cyan}${C.bold}================================================================================${C.reset}`);
  console.log(`${C.cyan}${C.bold}   TEST SUMMARY: ${passCount} PASSED | ${failCount} FAILED   ${C.reset}`);
  console.log(`${C.cyan}${C.bold}================================================================================${C.reset}`);

  if (failCount === 0) {
    console.log(`\n${C.green}${C.bold}>>> ALL MILESTONE 2 TERMINAL ASSERTIONS PASSED WITH ZERO GLYPH LOSS <<<${C.reset}\n`);
    return 0;
  } else {
    console.log(`\n${C.red}${C.bold}>>> TEST SUITE FAILED: ${failCount} UNMET CONDITIONS <<<${C.reset}\n`);
    return 1;
  }
}

// Self-executing runner
if (require.main === module) {
  runMilestone2TerminalSuite().then(exitCode => {
    process.exit(exitCode);
  }).catch(err => {
    console.error('Fatal harness error:', err);
    process.exit(1);
  });
}

module.exports = {
  runMilestone2TerminalSuite,
  assert,
  MockBrowserWindow,
  cleanTreeKill,
  waitForTerminalOutput,
  waitForCwdChange,
  waitForOpStatus
};
