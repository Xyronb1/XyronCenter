/**
 * XYRON CENTER - Milestone 3 Adversarial Stress Test Suite
 * File: tests/challenger-m3-directory-sync.js
 * Author: challenger_m3_2 (EMPIRICAL CHALLENGER)
 * 
 * Rigorously stress tests:
 * 1. Terminal CWD synchronization stress: 50 rapid transitions & breadcrumb integrity.
 * 2. Turkish & Unicode path handling: 'Türkçe_Klasör_ğüşöçİ', UTF-8 filenames, and 10-level deep nesting.
 * 3. Rapid file modifications: 20 rapid create/delete mutations in <100ms vs 200ms debounce of fs:watch-dir.
 * 4. Error resilience: Non-existent paths, Access Denied ('C:\System Volume Information'), DOS devices, zero crashes.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

// Robust Project Root Resolution
let PROJECT_ROOT = path.resolve(__dirname, '..');
if (!fs.existsSync(path.join(PROJECT_ROOT, 'package.json'))) {
  const candidate = path.resolve(__dirname, '../../../2_Proje_Dosyalari_Source');
  if (fs.existsSync(path.join(candidate, 'package.json'))) {
    PROJECT_ROOT = candidate;
  }
}

const MAIN_INDEX_PATH = path.resolve(PROJECT_ROOT, 'src/main/index.js');
const PRELOAD_INDEX_PATH = path.resolve(PROJECT_ROOT, 'src/preload/index.js');
const DIR_TREE_PATH = path.resolve(PROJECT_ROOT, 'src/renderer/js/directory-tree.js');

const mainIndex = require(MAIN_INDEX_PATH);
const { readDirEntries, watchDirectory, registerMainIpc, cleanupServices, WATCH_DEBOUNCE_MS } = mainIndex;

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
const unhandledExceptions = [];

process.on('uncaughtException', (err) => {
  unhandledExceptions.push({ type: 'uncaughtException', error: err.message, stack: err.stack });
  console.error(`${C.red}CRITICAL: Uncaught Exception in stress test:${C.reset}`, err);
});
process.on('unhandledRejection', (reason) => {
  unhandledExceptions.push({ type: 'unhandledRejection', reason: String(reason) });
  console.error(`${C.red}CRITICAL: Unhandled Rejection in stress test:${C.reset}`, reason);
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

// -------------------------------------------------------------
// Lightweight Headless DOM & Electron IPC Mock Framework
// -------------------------------------------------------------

class MockClassList {
  constructor() {
    this.classes = new Set();
  }
  add(c) { this.classes.add(c); }
  remove(c) { this.classes.delete(c); }
  contains(c) { return this.classes.has(c); }
  toggle(c, force) {
    if (force === undefined) {
      if (this.classes.has(c)) this.classes.delete(c);
      else this.classes.add(c);
    } else if (force) {
      this.classes.add(c);
    } else {
      this.classes.delete(c);
    }
  }
}

class MockElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.id = '';
    this.className = '';
    this._textContent = '';
    this.title = '';
    this._innerHTML = '';
    this.style = {};
    this.classList = new MockClassList();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
  }

  get textContent() {
    if (this._textContent !== '') {
      return this._textContent;
    }
    if (this.children.length > 0) {
      return this.children.map(c => c.textContent).join(' ');
    }
    return '';
  }

  set textContent(val) {
    this._textContent = val;
  }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(val) {
    this._innerHTML = val;
    if (val === '') {
      this.children = [];
    }
  }

  setAttribute(k, v) { this.attributes.set(k, v); }
  getAttribute(k) { return this.attributes.get(k); }

  appendChild(child) {
    if (!child) return child;
    if (child.tagName === 'FRAGMENT') {
      this.children.push(...child.children);
    } else {
      this.children.push(child);
    }
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) this.children.splice(idx, 1);
    return child;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (selector.startsWith('.') && child.className && child.className.includes(selector.slice(1))) {
        return child;
      }
      if (selector.startsWith('#') && child.id === selector.slice(1)) {
        return child;
      }
      if (child.querySelector) {
        const found = child.querySelector(selector);
        if (found) return found;
      }
    }
    return null;
  }

  querySelectorAll(selector) {
    const matched = [];
    for (const child of this.children) {
      if (selector.startsWith('.') && child.className && child.className.includes(selector.slice(1))) {
        matched.push(child);
      }
      if (child.querySelectorAll) {
        matched.push(...child.querySelectorAll(selector));
      }
    }
    return matched;
  }

  addEventListener(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }

  emit(event, ...args) {
    const list = this.listeners.get(event) || [];
    list.forEach(fn => fn(...args));
  }

  click() {
    this.emit('click');
  }

  dblclick() {
    this.emit('dblclick');
  }
}

class MockDocument {
  constructor() {
    this.elements = new Map();
  }

  getElementById(id) {
    if (!this.elements.has(id)) {
      const el = new MockElement();
      el.id = id;
      this.elements.set(id, el);
    }
    return this.elements.get(id);
  }

  createElement(tag) {
    return new MockElement(tag);
  }

  createDocumentFragment() {
    return new MockElement('fragment');
  }
}

class MockBrowserWindow extends EventEmitter {
  constructor() {
    super();
    this._isDestroyed = false;
    this.sentMessages = [];
    const wcEmitter = new EventEmitter();
    this.webContents = Object.assign(wcEmitter, {
      isDestroyed: () => this._isDestroyed,
      send: (channel, ...args) => {
        this.sentMessages.push({ channel, args, timestamp: Date.now() });
        wcEmitter.emit(channel, ...args);
      }
    });
  }

  isDestroyed() { return this._isDestroyed; }
  close() { this._isDestroyed = true; this.emit('closed'); }
}

class MockIpcMain extends EventEmitter {
  constructor() {
    super();
    this.handlers = new Map();
  }

  handle(channel, handler) {
    this.handlers.set(channel, handler);
  }

  removeHandler(channel) {
    this.handlers.delete(channel);
  }

  async invoke(channel, ...args) {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`No IPC handler registered for '${channel}'`);
    return await handler({ sender: null }, ...args);
  }
}

// -------------------------------------------------------------
// ADVERSARIAL STRESS SUITES
// -------------------------------------------------------------

async function runAllChallengerSuites() {
  console.log(`\n${C.bold}${C.cyan}================================================================================${C.reset}`);
  console.log(`${C.bold}${C.cyan}   XYRON CENTER - EMPIRICAL CHALLENGER: M3 DIRECTORY & CWD STRESS HARNESS       ${C.reset}`);
  console.log(`${C.bold}${C.cyan}================================================================================${C.reset}`);
  console.log(`Host OS: ${os.type()} ${os.release()} (${os.arch()}) | Node: ${process.version}`);
  console.log(`Target Codebase: ${PROJECT_ROOT}`);
  console.log(`Start Time: ${new Date().toISOString()}\n`);

  // Base temporary directory for isolation
  const STRESS_TEMP_BASE = path.join(os.tmpdir(), `xyron_m3_stress_${Date.now()}`);
  fs.mkdirSync(STRESS_TEMP_BASE, { recursive: true });

  try {
    // =========================================================================
    // SUITE 1: Terminal CWD Synchronization Stress (50 Rapid Transitions)
    // =========================================================================
    console.log(`${C.bold}${C.magenta}[SUITE 1] Terminal CWD Synchronization Stress (50 Rapid Transitions)...${C.reset}`);

    // Create 50 distinct real test directories on disk
    const TRANSITIONS_COUNT = 50;
    const cwdStressRoot = path.join(STRESS_TEMP_BASE, 'cwd_stress_dirs');
    fs.mkdirSync(cwdStressRoot, { recursive: true });

    const dirPaths = [];
    for (let i = 0; i < TRANSITIONS_COUNT; i++) {
      const pad = String(i).padStart(2, '0');
      const dir = path.join(cwdStressRoot, `nav_step_${pad}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `marker_${pad}.txt`), `Marker file for transition ${i}`);
      dirPaths.push(dir);
    }

    assert('CWD_STRESS', '50 distinct physical directories prepared', dirPaths.length === 50);

    // Initialize Mock Environment
    const doc = new MockDocument();
    global.document = doc;

    const mockWin = new MockBrowserWindow();
    const mockIpc = new MockIpcMain();
    registerMainIpc(mockIpc, { mainWindow: mockWin });

    // Track terminal input navigation events
    const terminalNavLog = [];
    global.window = {
      document: doc,
      fsApi: {
        readDir: async (dirPath) => await mockIpc.invoke('fs:read-dir', dirPath),
        watchDir: async (dirPath) => await mockIpc.invoke('fs:watch-dir', dirPath),
        onDirUpdated: (cb) => {
          const handler = (dir) => cb(dir);
          mockWin.webContents.on('fs:dir-updated', handler);
          return () => mockWin.webContents.removeListener('fs:dir-updated', handler);
        }
      },
      terminalApi: {
        setCwd: async (targetDir) => {
          terminalNavLog.push({ method: 'setCwd', target: targetDir });
          return true;
        },
        sendInput: (input) => {
          terminalNavLog.push({ method: 'sendInput', input });
        }
      }
    };

    const DirectoryTree = require(DIR_TREE_PATH);
    const tree = new DirectoryTree();
    tree.init();

    assert('CWD_STRESS', 'DirectoryTree initialized and bound to mock APIs', Boolean(tree.dom.breadcrumbs && tree.dom.treeList));

    // Stress Phase 1.1: Rapid-fire 50 CWD transitions sequentially with 0-delay
    const t0 = Date.now();
    for (let i = 0; i < TRANSITIONS_COUNT; i++) {
      await tree.loadDirectory(dirPaths[i], true);
    }
    const durationFast = Date.now() - t0;

    assert('CWD_STRESS', `50 sequential rapid transitions completed in ${durationFast}ms (< 3000ms)`, durationFast < 3000);
    assert('CWD_STRESS', 'Final tree currentPath matches 50th directory', tree.currentPath === dirPaths[TRANSITIONS_COUNT - 1]);

    // Verify breadcrumbs integrity for 50th directory
    const breadcrumbCrumbs = doc.getElementById('dir-breadcrumbs').children.filter(c => c.className === 'breadcrumb-crumb');
    const expectedParts = dirPaths[TRANSITIONS_COUNT - 1].replace(/\//g, '\\').split('\\').filter(p => p.length > 0);
    assert('CWD_STRESS', `Breadcrumb segments count strictly equals ${expectedParts.length}`, breadcrumbCrumbs.length === expectedParts.length);

    // Verify last crumb text matches 'nav_step_49'
    const lastCrumb = breadcrumbCrumbs[breadcrumbCrumbs.length - 1];
    assert('CWD_STRESS', "Last breadcrumb segment displays 'nav_step_49'", lastCrumb.textContent === 'nav_step_49');

    // Breadcrumb click test: click an ancestor crumb (e.g. index 2 or 3) and verify terminal navigation hook
    const testCrumbIdx = Math.min(2, breadcrumbCrumbs.length - 1);
    const targetCrumb = breadcrumbCrumbs[testCrumbIdx];
    terminalNavLog.length = 0;
    targetCrumb.click();
    assert('CWD_STRESS', 'Crumb click dispatches terminal navigation', terminalNavLog.length === 1 && terminalNavLog[0].target === targetCrumb.title);

    // Verify items in 50th directory
    const dirCards = doc.getElementById('dir-tree-list').children;
    assert('CWD_STRESS', 'Directory item rendered for 50th step (marker_49.txt)', dirCards.length === 1 && dirCards[0].textContent.includes('marker_49.txt'));

    // Stress Phase 1.2: Overlapping Concurrent Burst (Simulate 50 parallel asynchronous CWD requests)
    const concurrentPromises = dirPaths.map((p) => tree.loadDirectory(p, true));
    await Promise.all(concurrentPromises);
    assert('CWD_STRESS', '50 concurrent overlapping transitions completed without unhandled exceptions', true);
    assert('CWD_STRESS', 'DirectoryTree currentPath settled on a valid non-empty path', typeof tree.currentPath === 'string' && tree.currentPath.length > 0);

    // Cleanup tree
    tree.destroy();

    // =========================================================================
    // SUITE 2: Turkish & Unicode Path Handling & Deep Nesting
    // =========================================================================
    console.log(`\n${C.bold}${C.magenta}[SUITE 2] Turkish & Unicode Path Handling & Deep Nesting...${C.reset}`);

    // Create complex Turkish path with full Turkish character set: ç, ğ, ı, ö, ş, ü, Ç, Ğ, İ, Ö, Ş, Ü
    const turkishDirName = 'Türkçe_Klasör_ğüşöçİ_ÖŞÜĞÇI';
    const turkishRoot = path.join(STRESS_TEMP_BASE, turkishDirName);
    fs.mkdirSync(turkishRoot, { recursive: true });

    // Subdirectories
    const subFolder1 = path.join(turkishRoot, 'Klasör_Türkçe_Öğrenci_İşleri');
    const subFolder2 = path.join(turkishRoot, 'Dizin_çŞğÜöI_Test');
    fs.mkdirSync(subFolder1, { recursive: true });
    fs.mkdirSync(subFolder2, { recursive: true });

    // Files with Turkish names and UTF-8 Turkish content
    const file1 = path.join(turkishRoot, 'türkçe_belge_ıüşöğç.txt');
    const file2 = path.join(turkishRoot, 'rapor_İĞÜŞÖÇ.json');
    const file3 = path.join(turkishRoot, 'özel_kod_çö.js');
    fs.writeFileSync(file1, 'Çetin çamlar, ılık şelaleler, özgür kuşlar.', 'utf8');
    fs.writeFileSync(file2, JSON.stringify({ durum: 'BAŞARILI', mesaj: 'Türkçe karakter desteği kusursuz' }), 'utf8');
    fs.writeFileSync(file3, '// Türkçe yorum: test', 'utf8');

    // 1. Test readDirEntries on Turkish path
    const turkishEntries = await readDirEntries(turkishRoot);
    assert('TURKISH_UNICODE', 'readDirEntries successfully read Turkish directory', Array.isArray(turkishEntries) && turkishEntries.length === 5);

    // Verify directories first, then files
    const dirCount = turkishEntries.filter(e => e.isDirectory).length;
    const fileCount = turkishEntries.filter(e => !e.isDirectory).length;
    assert('TURKISH_UNICODE', 'Accurately recognized 2 subdirectories and 3 files', dirCount === 2 && fileCount === 3);
    assert('TURKISH_UNICODE', 'First 2 entries are strictly directories', turkishEntries[0].isDirectory && turkishEntries[1].isDirectory);

    // Verify Turkish filenames preserved without mojibake
    const names = turkishEntries.map(e => e.name);
    assert('TURKISH_UNICODE', "Preserved 'Klasör_Türkçe_Öğrenci_İşleri' intact", names.includes('Klasör_Türkçe_Öğrenci_İşleri'));
    assert('TURKISH_UNICODE', "Preserved 'Dizin_çŞğÜöI_Test' intact", names.includes('Dizin_çŞğÜöI_Test'));
    assert('TURKISH_UNICODE', "Preserved 'türkçe_belge_ıüşöğç.txt' intact", names.includes('türkçe_belge_ıüşöğç.txt'));
    assert('TURKISH_UNICODE', "Preserved 'rapor_İĞÜŞÖÇ.json' intact", names.includes('rapor_İĞÜŞÖÇ.json'));
    assert('TURKISH_UNICODE', "Preserved 'özel_kod_çö.js' intact", names.includes('özel_kod_çö.js'));

    // 2. Test watchDirectory on Turkish path
    const watchOk = watchDirectory(turkishRoot, mockWin);
    assert('TURKISH_UNICODE', 'watchDirectory successfully attached to Turkish directory', watchOk === true);

    // 3. Test DirectoryTree rendering with Turkish path
    const turkishTree = new DirectoryTree();
    turkishTree.init();
    await turkishTree.loadDirectory(turkishRoot);

    // Breadcrumbs check
    const turkishCrumbs = doc.getElementById('dir-breadcrumbs').children.filter(c => c.className === 'breadcrumb-crumb');
    const turkishCrumbText = turkishCrumbs.map(c => c.textContent);
    assert('TURKISH_UNICODE', `Breadcrumbs contain Turkish folder name segment '${turkishDirName}'`, turkishCrumbText.includes(turkishDirName));

    // Items cards check
    const turkishCards = doc.getElementById('dir-tree-list').children;
    assert('TURKISH_UNICODE', '5 visual item cards rendered for Turkish directory', turkishCards.length === 5);

    // Double-click folder navigation check
    const dirCardTarget = turkishCards.find(c => c.className.includes('is-dir'));
    assert('TURKISH_UNICODE', 'Found directory card for double-click test', Boolean(dirCardTarget));

    terminalNavLog.length = 0;
    if (dirCardTarget) {
      dirCardTarget.dblclick();
      assert('TURKISH_UNICODE', 'Double-click on Turkish directory card triggered terminal navigation', terminalNavLog.length === 1 && terminalNavLog[0].target.includes(turkishDirName));
    }

    // 4. Test Deep Nested Structure (10-level deep Turkish hierarchy)
    console.log(`  ${C.dim}Constructing 10-level deep Turkish folder hierarchy...${C.reset}`);
    const deepSegments = [
      'düzey_1_ç',
      'düzey_2_ğ',
      'düzey_3_ı',
      'düzey_4_ö',
      'düzey_5_ş',
      'düzey_6_ü',
      'düzey_7_Ç',
      'düzey_8_Ğ',
      'düzey_9_İ',
      'düzey_10_Son'
    ];

    let currentDeepPath = turkishRoot;
    for (const seg of deepSegments) {
      currentDeepPath = path.join(currentDeepPath, seg);
      fs.mkdirSync(currentDeepPath, { recursive: true });
    }
    const deepTargetFile = path.join(currentDeepPath, 'hedef_dosya_İ.txt');
    fs.writeFileSync(deepTargetFile, 'Deep Turkish target reached', 'utf8');

    // Load deepest directory into DirectoryTree
    await turkishTree.loadDirectory(currentDeepPath);

    const deepCrumbs = doc.getElementById('dir-breadcrumbs').children.filter(c => c.className === 'breadcrumb-crumb');
    assert('TURKISH_UNICODE', `10-level deep breadcrumbs chain rendered (${deepCrumbs.length} crumbs)`, deepCrumbs.length >= 11);

    // Verify level 5 crumb click
    const crumbLevel5 = deepCrumbs.find(c => c.textContent === 'düzey_5_ş');
    assert('TURKISH_UNICODE', "Found breadcrumb for 'düzey_5_ş'", Boolean(crumbLevel5));

    terminalNavLog.length = 0;
    if (crumbLevel5) {
      crumbLevel5.click();
      assert('TURKISH_UNICODE', "Clicking level 5 crumb navigates to '...\\düzey_5_ş'", terminalNavLog.length === 1 && terminalNavLog[0].target.endsWith('düzey_5_ş'));
    }

    // Verify deep item card displays target file
    const deepCards = doc.getElementById('dir-tree-list').children;
    assert('TURKISH_UNICODE', "Deep target card displays 'hedef_dosya_İ.txt'", deepCards.length === 1 && deepCards[0].textContent.includes('hedef_dosya_İ.txt'));

    turkishTree.destroy();

    // =========================================================================
    // SUITE 3: Rapid File Modifications (20 Rapid Writes in 100ms vs 200ms Debounce)
    // =========================================================================
    console.log(`\n${C.bold}${C.magenta}[SUITE 3] Rapid File Modifications (20 Events in <100ms vs 200ms Debounce)...${C.reset}`);

    const debounceTestDir = path.join(STRESS_TEMP_BASE, 'debounce_stress_dir');
    fs.mkdirSync(debounceTestDir, { recursive: true });

    const debounceWin = new MockBrowserWindow();
    let fsDirUpdatedEvents = [];

    debounceWin.webContents.on('fs:dir-updated', (dir) => {
      fsDirUpdatedEvents.push({ dir, timestamp: Date.now() });
    });

    const watchAttached = watchDirectory(debounceTestDir, debounceWin);
    assert('DEBOUNCE_STRESS', 'watchDirectory attached to debounce test folder', watchAttached === true);
    assert('DEBOUNCE_STRESS', 'WATCH_DEBOUNCE_MS is configured to 200ms', WATCH_DEBOUNCE_MS === 200);

    // Fire 20 rapid file creation and deletion mutations in < 100ms
    fsDirUpdatedEvents = [];
    const burstStart = Date.now();
    const RAPID_MUTATION_COUNT = 20;

    for (let i = 0; i < RAPID_MUTATION_COUNT; i++) {
      const tempFilePath = path.join(debounceTestDir, `burst_file_${i}.tmp`);
      if (i % 2 === 0) {
        fs.writeFileSync(tempFilePath, `data_${i}`);
      } else {
        const prevPath = path.join(debounceTestDir, `burst_file_${i - 1}.tmp`);
        if (fs.existsSync(prevPath)) {
          fs.unlinkSync(prevPath);
        } else {
          fs.writeFileSync(tempFilePath, `data_${i}`);
        }
      }
    }
    const burstDuration = Date.now() - burstStart;

    assert('DEBOUNCE_STRESS', `20 file mutations completed in ${burstDuration}ms (< 100ms)`, burstDuration < 100);

    // Check IMMEDIATELY after burst: should be ZERO emissions (debouncing prevents synchronous spam)
    assert('DEBOUNCE_STRESS', 'Zero events emitted during active burst (no UI flood)', fsDirUpdatedEvents.length === 0);

    // Wait 100ms (total < 150ms from last event): should STILL be 0 emissions
    await sleep(100);
    assert('DEBOUNCE_STRESS', 'Zero events emitted before 200ms debounce expires (timer properly postponed)', fsDirUpdatedEvents.length === 0);

    // Wait another 200ms (total > 300ms from last event): exactly 1 emission must fire
    await sleep(200);
    assert('DEBOUNCE_STRESS', `Exactly 1 debounced fs:dir-updated event fired (Received: ${fsDirUpdatedEvents.length})`, fsDirUpdatedEvents.length === 1);

    if (fsDirUpdatedEvents.length > 0) {
      const emittedPath = path.resolve(fsDirUpdatedEvents[0].dir).toLowerCase();
      const expectedPath = path.resolve(debounceTestDir).toLowerCase();
      assert('DEBOUNCE_STRESS', 'Emitted payload strictly matches watched directory path', emittedPath === expectedPath);
    }

    // Stress Phase 3.2: Second burst of 20 rapid mutations to ensure watcher remains responsive and unblocked
    fsDirUpdatedEvents = [];
    for (let i = 0; i < 20; i++) {
      const f = path.join(debounceTestDir, `second_burst_${i}.tmp`);
      fs.writeFileSync(f, `second_${i}`);
    }
    // Wait for second debounce resolution (> 250ms)
    await sleep(300);
    assert('DEBOUNCE_STRESS', `Second burst coalesced into exactly 1 event (Received: ${fsDirUpdatedEvents.length})`, fsDirUpdatedEvents.length === 1);

    // =========================================================================
    // SUITE 4: Error Resilience & Adversarial Paths Hardening
    // =========================================================================
    console.log(`\n${C.bold}${C.magenta}[SUITE 4] Error Resilience & Adversarial Paths Hardening...${C.reset}`);

    // 1. Access Denied Windows System Directory (C:\System Volume Information)
    const sysVolInfo = 'C:\\System Volume Information';
    const sysEntries = await readDirEntries(sysVolInfo);
    assert('ERROR_RESILIENCE', `readDirEntries('${sysVolInfo}') returns empty array gracefully`, Array.isArray(sysEntries) && sysEntries.length === 0);

    const sysWatch = watchDirectory(sysVolInfo, mockWin);
    assert('ERROR_RESILIENCE', `watchDirectory('${sysVolInfo}') returns false without throwing`, sysWatch === false);

    // DirectoryTree load on Access Denied folder
    const resilientTree = new DirectoryTree();
    resilientTree.init();
    await resilientTree.loadDirectory(sysVolInfo);
    assert('ERROR_RESILIENCE', 'DirectoryTree gracefully handles locked system folder (no crash or hang)', Array.isArray(resilientTree.entries));

    // 2. Completely Non-Existent Path
    const nonExistentPath = 'C:\\XYRON_CENTER_DEFINITELY_NON_EXISTENT_FOLDER_987654321';
    const nonExistentEntries = await readDirEntries(nonExistentPath);
    assert('ERROR_RESILIENCE', 'readDirEntries on non-existent path returns empty array', Array.isArray(nonExistentEntries) && nonExistentEntries.length === 0);

    const nonExistentWatch = watchDirectory(nonExistentPath, mockWin);
    assert('ERROR_RESILIENCE', 'watchDirectory on non-existent path returns false', nonExistentWatch === false);

    await resilientTree.loadDirectory(nonExistentPath);
    assert('ERROR_RESILIENCE', 'DirectoryTree safely renders empty notice for non-existent path', resilientTree.entries.length === 0);

    // 3. File Path Passed Instead of Directory
    const filePath = path.resolve(PROJECT_ROOT, 'package.json');
    const fileEntries = await readDirEntries(filePath);
    assert('ERROR_RESILIENCE', 'readDirEntries on a file returns empty array', Array.isArray(fileEntries) && fileEntries.length === 0);

    const fileWatch = watchDirectory(filePath, mockWin);
    assert('ERROR_RESILIENCE', 'watchDirectory on a file returns false', fileWatch === false);

    // 4. Windows Invalid Path Characters (colons, wildcards, pipes)
    const invalidCharsPath = 'C:\\Test\\invalid:*?"<>|\\path';
    const invalidCharEntries = await readDirEntries(invalidCharsPath);
    assert('ERROR_RESILIENCE', 'readDirEntries with forbidden Windows chars returns empty array', Array.isArray(invalidCharEntries) && invalidCharEntries.length === 0);

    const invalidCharWatch = watchDirectory(invalidCharsPath, mockWin);
    assert('ERROR_RESILIENCE', 'watchDirectory with forbidden Windows chars returns false', invalidCharWatch === false);

    // 5. Windows DOS Reserved Device Names (CON, PRN, AUX, NUL, COM1, LPT1)
    const dosDevices = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT1'];
    for (const dev of dosDevices) {
      const devPath = `C:\\${dev}`;
      const devEntries = await readDirEntries(devPath);
      assert('ERROR_RESILIENCE', `readDirEntries('${devPath}') handled gracefully`, Array.isArray(devEntries) && devEntries.length === 0);
      const devWatch = watchDirectory(devPath, mockWin);
      assert('ERROR_RESILIENCE', `watchDirectory('${devPath}') handled gracefully`, devWatch === false);
    }

    // 6. Extreme Boundary & Invalid Type Inputs
    const badInputs = [null, undefined, '', '   ', 12345, {}, [], false, true];
    for (const bad of badInputs) {
      const res = await readDirEntries(bad);
      assert('ERROR_RESILIENCE', `readDirEntries(${JSON.stringify(bad)}) returns empty array`, Array.isArray(res) && res.length === 0);

      const wres = watchDirectory(bad, mockWin);
      assert('ERROR_RESILIENCE', `watchDirectory(${JSON.stringify(bad)}) returns false`, wres === false);
    }

    // 7. Very Long Path (MAX_PATH Stress > 260 characters)
    let longPath = STRESS_TEMP_BASE;
    for (let i = 0; i < 15; i++) {
      longPath = path.join(longPath, `nested_long_segment_${i}`);
    }
    const longEntries = await readDirEntries(longPath);
    assert('ERROR_RESILIENCE', `readDirEntries on >260 char path (${longPath.length} chars) safely handled`, Array.isArray(longEntries));

    // 8. Global Unhandled Exceptions and Rejections Audit
    assert('UNHANDLED_AUDIT', `Zero uncaught exceptions logged (Count: ${unhandledExceptions.length})`, unhandledExceptions.length === 0);

    resilientTree.destroy();
    cleanupServices();

  } finally {
    // Teardown and clean up temporary stress directories
    try {
      fs.rmSync(STRESS_TEMP_BASE, { recursive: true, force: true });
    } catch (_e) {}
  }

  // =========================================================================
  // FINAL HARNESS VERDICT & SUMMARY
  // =========================================================================
  console.log(`\n${C.bold}${C.cyan}================================================================================${C.reset}`);
  console.log(`${C.bold}   CHALLENGER STRESS HARNESS SUMMARY                                            ${C.reset}`);
  console.log(`${C.bold}${C.cyan}================================================================================${C.reset}`);
  console.log(`Total Assertions: ${passCount + failCount}`);
  console.log(`  Passed: ${C.green}${passCount}${C.reset}`);
  console.log(`  Failed: ${C.red}${failCount}${C.reset}`);
  console.log(`  Unhandled Errors: ${unhandledExceptions.length > 0 ? C.red + unhandledExceptions.length : C.green + '0'}${C.reset}`);

  if (failCount === 0 && unhandledExceptions.length === 0) {
    console.log(`\n${C.bold}${C.green}>>> EMPIRICAL VERDICT: CONFIRM_CORRECTNESS <<<${C.reset}`);
    console.log(`${C.green}Active directory tree, Turkish Unicode handling, debounced file watcher, and CWD synchronization fully validated under high adversarial stress.${C.reset}\n`);
    process.exit(0);
  } else {
    console.log(`\n${C.bold}${C.red}>>> EMPIRICAL VERDICT: FLAG_ISSUES <<<${C.reset}`);
    console.log(`${C.red}Failures detected during adversarial stress testing. See logs above for details.${C.reset}\n`);
    process.exit(1);
  }
}

runAllChallengerSuites().catch((err) => {
  console.error(`${C.red}FATAL ERROR IN CHALLENGER HARNESS:${C.reset}`, err);
  process.exit(1);
});
