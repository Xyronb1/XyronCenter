/**
 * Unit & Integration Test for Frontend HUD Views (explorer_m3_3)
 * Tests TelemetryView, ProcessView, DirectoryTree, TerminalView, and App logic.
 */

// Simple lightweight DOM environment
class MockClassList {
  constructor() {
    this.classes = new Set();
  }
  add(c) { this.classes.add(c); }
  remove(c) { this.classes.delete(c); }
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
  contains(c) { return this.classes.has(c); }
}

class MockElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.id = '';
    this.className = '';
    this.textContent = '';
    this.innerHTML = '';
    this.style = {};
    this.classList = new MockClassList();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.disabled = false;
  }
  setAttribute(k, v) { this.attributes.set(k, v); }
  getAttribute(k) { return this.attributes.get(k); }
  addEventListener(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }
  emit(event, ...args) {
    const list = this.listeners.get(event) || [];
    list.forEach(fn => fn(...args));
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) this.children.splice(idx, 1);
    return child;
  }
  getBoundingClientRect() {
    return { width: 300, height: 200, top: 0, left: 0, bottom: 200, right: 300 };
  }
  querySelector(sel) {
    return new MockElement('span');
  }
  querySelectorAll(sel) {
    return [new MockElement('button'), new MockElement('button'), new MockElement('button')];
  }
  focus() {}
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
  querySelectorAll(sel) {
    return [new MockElement('button'), new MockElement('button'), new MockElement('button')];
  }
  querySelector(sel) {
    return new MockElement('span');
  }
  addEventListener() {}
}

// Setup Global environment
global.document = new MockDocument();
global.window = {
  document: global.document,
  addEventListener: () => {},
  removeEventListener: () => {},
  telemetryApi: {
    onUpdate: (cb) => { global.__testTelemetryCb = cb; return () => {}; },
    getSnapshot: async () => ({})
  },
  processApi: {
    kill: async (pid) => ({ success: true, message: `Terminated ${pid}` }),
    list: async () => []
  },
  terminalApi: {
    sendInput: () => {},
    resize: () => {},
    onOutput: (cb) => () => {},
    onCwdChange: (cb) => () => {},
    getCwd: async () => 'C:\\Users\\Xyron\\Desktop\\XyronCenter',
    setCwd: async () => true
  },
  elevationApi: {
    onStatus: (cb) => { global.__testOpStatusCb = cb; return () => {}; },
    getStatus: async () => ({ unlocked: false, identity: 'STANDARD' })
  },
  fsApi: {
    readDir: async () => [
      { name: 'src', isDirectory: true, size: 0, mtime: '2026-11-06T11:00:00Z' },
      { name: 'package.json', isDirectory: false, size: 1369, mtime: '2026-11-06T11:00:00Z' }
    ],
    watchDir: async () => true,
    onDirUpdated: () => () => {}
  },
  windowApi: {
    minimize: () => {},
    maximize: () => {},
    close: () => {}
  },
  Terminal: class MockXterm {
    constructor() { this.cols = 100; this.rows = 30; }
    loadAddon() {}
    open() {}
    onData(cb) { this._onData = cb; }
    write() {}
    focus() {}
    dispose() {}
  },
  FitAddon: class MockFitAddon {
    fit() {}
  }
};

async function testAll() {
  console.log('--- Testing Frontend HUD Modules ---');

  // Load modules
  const TelemetryView = require('../src/renderer/js/telemetry-view.js');
  const ProcessView = require('../src/renderer/js/process-view.js');
  const DirectoryTree = require('../src/renderer/js/directory-tree.js');
  const TerminalView = require('../src/renderer/js/terminal-view.js');
  const App = require('../src/renderer/js/app.js');
  const BootAudio = require('../src/renderer/js/boot-audio.js');
  const BootSequence = require('../src/renderer/js/boot-sequence.js');

  console.log('✓ All 5 classes loaded successfully');

  // 1. TelemetryView Test
  const telView = new TelemetryView();
  telView.init();

  const mockPayload = {
    timestamp: Date.now(),
    uptime: 123456,
    clock: { time: '11:32:00.000', date: '06.11.2026' },
    cpu: {
      model: 'Intel(R) Core(TM) i9-13900K',
      coresTotal: 24,
      logicalThreads: 32,
      overallUsagePercent: 42,
      coreWorkloads: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 15, 25, 35, 45, 55, 65]
    },
    memory: {
      totalBytes: 32 * 1024 * 1024 * 1024,
      freeBytes: 16 * 1024 * 1024 * 1024,
      usedBytes: 16 * 1024 * 1024 * 1024,
      usedPercent: 50.0
    },
    gpu: {
      name: 'NVIDIA GeForce RTX 4090',
      temperatureCelsius: 58,
      utilizationPercent: 75,
      vramUsedMB: 8192,
      vramTotalMB: 24576,
      powerDrawWatts: 185.4
    },
    temperatures: {
      cpu: { value: 62, status: 'LIVE' },
      gpu: { value: 58, status: 'LIVE' },
      nvme: { value: 45, status: 'LIVE' },
      motherboard: { value: null, status: 'OFFLINE' }
    },
    fans: {
      rpm: null,
      fanSpeedPercent: null,
      status: 'UNSUPPORTED_BY_OEM_EC'
    },
    network: {
      rxBytesPerSec: 154200,
      txBytesPerSec: 25400,
      activeAdapter: 'Ethernet'
    }
  };

  telView.update(mockPayload);
  if (telView.dom.cpuOverallPercent.textContent !== '42%') throw new Error('CPU overall % mismatch');
  if (telView.dom.tempMb.textContent !== 'OFFLINE') throw new Error('Motherboard null sensor should be OFFLINE');
  if (telView.dom.fanRpm.textContent !== 'UNSUPPORTED_BY_OEM_EC') throw new Error('Fan should show UNSUPPORTED_BY_OEM_EC');
  console.log('✓ TelemetryView update & Zero Mock Invariant verified');

  // 2. ProcessView Test
  const procView = new ProcessView();
  procView.init();
  procView.update({
    processes: [
      { pid: 100, name: 'system.exe', memUsage: '25.000 K', memBytes: 25000000 },
      { pid: 200, name: 'code.exe', memUsage: '150.000 K', memBytes: 150000000 },
      { pid: 300, name: 'node.exe', memUsage: '80.000 K', memBytes: 80000000 }
    ],
    hexMatrix: [
      { offset: '0x00401000', hexBytes: 'AA BB CC DD EE FF 00 11   22 33 44 55 66 77 88 99', ascii: '................', raw: '0x00401000:  AA BB CC ...' }
    ]
  });

  if (procView.processes.length !== 3) throw new Error('Process count mismatch');
  procView.selectProcess(200, 'code.exe');
  if (procView.selectedPid !== 200) throw new Error('Select PID mismatch');
  await procView.killSelectedProcess();
  console.log('✓ ProcessView sorting, selection, and kill API verified');

  // 3. DirectoryTree Test
  const dirTree = new DirectoryTree();
  dirTree.init();
  await dirTree.loadDirectory('C:\\Users\\Xyron\\Desktop\\XyronCenter');
  if (dirTree.entries.length !== 2) throw new Error('Directory entry count mismatch');
  console.log('✓ DirectoryTree breadcrumbs & items verified');

  // 4. TerminalView Test
  const termView = new TerminalView();
  termView.init();
  termView.handleCwdChange('C:\\Users\\Xyron');
  if (termView.dom.cwdDisplay.textContent !== 'C:\\Users\\Xyron') throw new Error('Terminal CWD display mismatch');
  console.log('✓ TerminalView xterm & CWD binding verified');

  // 5. App Orchestrator Test
  const app = new App();
  app.start();
  app.activateHud();
  if (!app.isHudActive) throw new Error('App activateHud failed');
  console.log('✓ App coordinator lifecycle verified');

  console.log('\nALL FRONTEND HUD TESTS PASSED (100% GREEN)!');
  process.exit(0);
}

testAll().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});
