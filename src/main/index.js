/**
 * XYRON CENTER - Main Electron Process Entry Point
 * File: src/main/index.js
 * 
 * Responsibilities:
 * - Electron application lifecycle & single-instance lock enforcement.
 * - Frameless fullscreen BrowserWindow creation with dark carbon styling (#070a0e).
 * - Autoplay policy switch configuration for Web Audio procedural DSP sound synthesis.
 * - Coordination and lifecycle management of core backend subsystems:
 *   * TelemetryEngine (Win32 metrics, 3-tier polling loop)
 *   * ProcessManager (Process enumeration, tree termination, CNG hex matrix)
 *   * PtyManager (Native Windows ConPTY terminal, Turkish UTF-8, OSC 0 CWD tracking)
 *   * ElevationDaemon (In-terminal /op privilege elevation engine)
 * - Active Directory Filesystem IPC:
 *   * fs:read-dir (Returns directory entries with { name, isDirectory, size, mtime })
 *   * fs:watch-dir (200ms debounced active CWD watcher emitting fs:dir-updated)
 * - Window control IPC:
 *   * window:minimize, window:maximize, window:close
 * - Clean teardown and process tree termination on exit.
 */

let electron;
try {
  electron = require('electron');
} catch (_e) {
  try {
    electron = require('../../2_Proje_Dosyalari_Source/node_modules/electron');
  } catch (_e2) {
    electron = null;
  }
}
const path = require('path');
const fs = require('fs');

// Resolve classes whether running in production src/main or from an agent test folder
function resolveInternalModule(moduleName) {
  try {
    return require(`./${moduleName}`);
  } catch (_e1) {
    try {
      return require(`../../../2_Proje_Dosyalari_Source/src/main/${moduleName}`);
    } catch (_e2) {
      return require(path.resolve(__dirname, `../../../../2_Proje_Dosyalari_Source/src/main/${moduleName}`));
    }
  }
}

// Optional startup profiler (XYRON_PERF=1): prints ms-since-process-start per stage.
const PERF = !!process.env.XYRON_PERF;
function perf(stage) {
  if (PERF) console.log(`[perf] ${stage} +${Math.round(process.uptime() * 1000)}ms`);
}
perf('main-loaded');

const TelemetryEngine = resolveInternalModule('telemetry-engine');
const ProcessManager = resolveInternalModule('process-manager');
const PtyManager = resolveInternalModule('pty-manager');
const ElevationDaemon = resolveInternalModule('elevation-daemon');
const ConfigStore = resolveInternalModule('config-store');
const ElevationBootstrap = resolveInternalModule('elevation-bootstrap');
const SystemActions = resolveInternalModule('system-actions');

// Detect if running inside Electron runtime or pure Node (testing)
const isElectron = typeof electron === 'object' && electron !== null && typeof electron.app !== 'undefined';
const app = isElectron ? electron.app : null;
const BrowserWindow = isElectron ? electron.BrowserWindow : null;
const ipcMain = isElectron ? electron.ipcMain : null;
const Tray = isElectron ? electron.Tray : null;
const Menu = isElectron ? electron.Menu : null;
const nativeImage = isElectron ? electron.nativeImage : null;

// Apply Chromium switches before app ready (R2 requirement for procedural Web Audio)
if (isElectron && app) {
  // Autoplay policy: bypass user gesture requirement for procedural Web Audio boot sequence
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('high-dpi-support', '1');
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('disable-http-cache');
  // Correct taskbar/tray grouping and icon on Windows.
  if (typeof app.setAppUserModelId === 'function') app.setAppUserModelId('com.xyron.center');
}

// Application State Bag
let mainWindow = null;
let telemetryEngine = null;
let processManager = null;
let ptyManager = null;
let elevationDaemon = null;
let configStore = null;
let processElevated = false; // set by ensureElevated() before any window exists

// System-tray (notification-area) state. The window hides to the tray on close
// and only a real "Çıkış" / app.quit() ends the process; see createTray().
let tray = null;
let isQuitting = false;       // true once a genuine quit is in progress
let trayHintShown = false;    // one-time "running in tray" balloon guard

// Active Directory Watcher State
let currentWatchedDir = null;
let currentWatcher = null;
let debounceTimer = null;
const WATCH_DEBOUNCE_MS = 200;

/**
 * Enumerate directory contents conforming to HUD contract:
 * Array of { name: string, isDirectory: boolean, size: number, mtime: string|null }
 *
 * @param {string} dirPath - Target folder path
 * @returns {Promise<Array<{ name: string, isDirectory: boolean, size: number, mtime: string|null }>>}
 */
async function readDirEntries(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') {
    return [];
  }

  const resolved = path.resolve(dirPath);

  try {
    if (!fs.existsSync(resolved)) {
      return [];
    }

    const stat = await fs.promises.stat(resolved);
    if (!stat.isDirectory()) {
      return [];
    }

    const dirents = await fs.promises.readdir(resolved, { withFileTypes: true });

    const entries = await Promise.all(
      dirents.map(async (dirent) => {
        const fullPath = path.join(resolved, dirent.name);
        let isDir = dirent.isDirectory();
        let size = 0;
        let mtime = null;

        try {
          const s = await fs.promises.stat(fullPath);
          isDir = s.isDirectory();
          size = isDir ? 0 : s.size;
          mtime = s.mtime.toISOString();
        } catch (_statErr) {
          // If individual stat fails (e.g. system file lock or missing junction target),
          // fallback gracefully to dirent metadata without failing the whole listing
          isDir = dirent.isDirectory();
        }

        return {
          name: dirent.name,
          isDirectory: isDir,
          size: size,
          mtime: mtime
        };
      })
    );

    // Sort: directories first, then alphabetical (case-insensitive numeric)
    entries.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    return entries;
  } catch (_readErr) {
    // EACCES / EPERM / unhandled errors return empty array gracefully
    return [];
  }
}

/**
 * Watch directory for modifications with a 200ms debounce.
 * Emits `fs:dir-updated` to renderer when changes occur.
 *
 * @param {string} dirPath - Folder to watch
 * @param {Electron.BrowserWindow} [targetWindow] - Target window for IPC broadcast
 * @returns {boolean}
 */
function watchDirectory(dirPath, targetWindow = mainWindow) {
  if (!dirPath || typeof dirPath !== 'string') {
    return false;
  }

  const resolved = path.resolve(dirPath);

  // If already watching this directory, skip re-attaching
  if (currentWatchedDir && currentWatchedDir.toLowerCase() === resolved.toLowerCase() && currentWatcher) {
    return true;
  }

  // Cleanup existing watcher
  if (currentWatcher) {
    try {
      currentWatcher.close();
    } catch (_e) {}
    currentWatcher = null;
  }

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      currentWatchedDir = null;
      return false;
    }

    currentWatchedDir = resolved;
    currentWatcher = fs.watch(resolved, { persistent: false }, (_eventType, _filename) => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        const win = targetWindow || mainWindow;
        if (win && !win.isDestroyed?.() && !win.webContents?.isDestroyed?.()) {
          try {
            win.webContents.send('fs:dir-updated', currentWatchedDir);
          } catch (_e) {}
        }
      }, WATCH_DEBOUNCE_MS);
    });

    currentWatcher.on('error', (_err) => {
      if (currentWatcher) {
        try { currentWatcher.close(); } catch (_) {}
        currentWatcher = null;
      }
    });

    return true;
  } catch (_watchErr) {
    currentWatchedDir = null;
    return false;
  }
}

/**
 * Register core IPC channels for Filesystem, Telemetry Snapshots, and Window Controls.
 *
 * @param {Electron.IpcMain} targetIpc
 * @param {Object} services - Bag of instantiated services
 */
function registerMainIpc(targetIpc, services = {}) {
  if (!targetIpc) return;

  const win = services.mainWindow || mainWindow;
  const engine = services.telemetryEngine || telemetryEngine;

  // 1. Filesystem IPC
  targetIpc.handle('fs:read-dir', async (_event, dirPath) => {
    return await readDirEntries(dirPath);
  });

  targetIpc.handle('fs:watch-dir', async (_event, dirPath) => {
    return watchDirectory(dirPath, services.mainWindow || mainWindow);
  });

  targetIpc.on('fs:watch-dir', (_event, dirPath) => {
    watchDirectory(dirPath, services.mainWindow || mainWindow);
  });

  // 2. Telemetry Snapshot IPC
  targetIpc.handle('telemetry:get-snapshot', async () => {
    if (engine && typeof engine.getLatestTelemetry === 'function') {
      return engine.getLatestTelemetry();
    }
    return null;
  });

  // 3. Window Control IPC (Frameless Fullscreen Window)
  targetIpc.on('window:minimize', () => {
    const w = services.mainWindow || mainWindow;
    if (w && !w.isDestroyed?.()) {
      w.minimize();
    }
  });

  targetIpc.on('window:maximize', () => {
    const w = services.mainWindow || mainWindow;
    if (w && !w.isDestroyed?.()) {
      if (w.isFullScreen?.()) {
        w.setFullScreen(false);
      } else if (w.isMaximized?.()) {
        w.unmaximize();
      } else {
        w.maximize();
      }
    }
  });

  targetIpc.on('window:close', () => {
    const w = services.mainWindow || mainWindow;
    if (w && !w.isDestroyed?.()) {
      w.close();
    }
  });

  // 4. Configuration IPC (customizable boot intro via /xyron commands)
  targetIpc.handle('config:get-boot', async () => {
    const store = services.configStore || configStore;
    return store ? store.getBoot() : null;
  });

  targetIpc.handle('config:get', async () => {
    const store = services.configStore || configStore;
    return store ? store.getAll() : null;
  });

  targetIpc.handle('config:get-theme', async () => {
    const store = services.configStore || configStore;
    return store ? store.getTheme() : null;
  });
}

/**
 * Tear down all active services, timers, watchers, and processes cleanly.
 *
 * @param {Object} services
 */
function cleanupServices(services = {}) {
  if (currentWatcher) {
    try { currentWatcher.close(); } catch (_e) {}
    currentWatcher = null;
  }

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  const engine = services.telemetryEngine || telemetryEngine;
  if (engine && typeof engine.stop === 'function') {
    engine.stop();
  }

  const pty = services.ptyManager || ptyManager;
  if (pty && typeof pty.destroy === 'function') {
    pty.destroy(services.ipcMain || ipcMain);
  }

  const daemon = services.elevationDaemon || elevationDaemon;
  if (daemon && typeof daemon.destroy === 'function') {
    daemon.destroy();
  }
}

/**
 * Create and configure the primary Electron BrowserWindow.
 *
 * @returns {Electron.BrowserWindow}
 */
/**
 * Where the terminal starts: the directory of the last session if it still
 * exists, otherwise the user profile.
 * @param {Object} store - ConfigStore
 * @returns {string}
 */
function resolveInitialCwd(store) {
  const fallback = process.env.USERPROFILE || process.cwd();
  try {
    const last = store && typeof store.getLastCwd === 'function' ? store.getLastCwd() : '';
    if (last && path.isAbsolute(last) && fs.statSync(last).isDirectory()) return last;
  } catch (_e) {}
  return fallback;
}

/**
 * Resolve the app icon on disk, whether running from source or inside app.asar.
 * @returns {string} absolute path to icon.ico (preferred) or icon.png
 */
function resolveIconPath() {
  const base = path.join(__dirname, '../../assets');
  const unpacked = base.replace('app.asar', 'app.asar.unpacked'); // real file in packaged builds
  const candidates = [
    path.join(unpacked, 'icon.ico'),
    path.join(base, 'icon.ico'),
    path.join(unpacked, 'icon.png'),
    path.join(base, 'icon.png'),
    path.resolve(__dirname, '../../../2_Proje_Dosyalari_Source/assets/icon.ico')
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_e) {}
  }
  return candidates[1];
}

/**
 * Bring the window back from the tray / minimized state and focus it. Does not
 * reload the renderer, so the boot intro never replays while the app stays open.
 */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed?.()) return;
  if (mainWindow.isMinimized?.()) mainWindow.restore();
  if (!mainWindow.isVisible?.()) mainWindow.show();
  mainWindow.focus();
}

/**
 * Create the notification-area (system tray) icon with a quick-access menu.
 * Left-click toggles the window; "Çıkış" is the only real way to end the app.
 * Safe no-op when the Tray API is unavailable.
 */
function createTray() {
  if (!Tray || tray) return;
  try {
    let image = resolveIconPath();
    if (nativeImage && typeof nativeImage.createFromPath === 'function') {
      const img = nativeImage.createFromPath(image);
      if (img && !img.isEmpty()) image = img;
    }
    tray = new Tray(image);
    tray.setToolTip('Xyron Center');

    const contextMenu = Menu.buildFromTemplate([
      { label: 'Xyron Center', enabled: false },
      { type: 'separator' },
      { label: 'Göster', click: () => showMainWindow() },
      {
        label: 'Gizle',
        click: () => { if (mainWindow && !mainWindow.isDestroyed?.()) mainWindow.hide(); }
      },
      { type: 'separator' },
      {
        label: 'Çıkış',
        click: () => { isQuitting = true; app.quit(); }
      }
    ]);
    tray.setContextMenu(contextMenu);

    // A single click brings the HUD straight back from the tray.
    tray.on('click', () => {
      if (mainWindow && mainWindow.isVisible?.() && !mainWindow.isMinimized?.()) {
        mainWindow.focus();
      } else {
        showMainWindow();
      }
    });
    tray.on('double-click', () => showMainWindow());
  } catch (_e) {
    tray = null; // tray is a convenience; never let its failure break startup
  }
}

function createMainWindow() {
  // Persistent user configuration (boot intro, theme, last directory)
  configStore = new ConfigStore({ electronApp: app });
  const initialCwd = resolveInitialCwd(configStore);

  // Env-gated non-intrusive smoke mode: run windowed + hidden and auto-quit,
  // so CI / local validation can boot the full app without hijacking the screen.
  const SMOKE = !!process.env.XYRON_SMOKE;
  // Env-gated developer mode: run windowed (not fullscreen) and visible, so the
  // UI can be observed / driven during development without going fullscreen.
  const WINDOWED = !!process.env.XYRON_WINDOWED;

  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    // Below this the three-column grid cannot fit its labels and text overlaps.
    minWidth: 1180,
    minHeight: 700,
    fullscreen: true,
    frame: false,
    backgroundColor: '#000000',
    title: 'XYRON CENTER',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false
    }
  });

  // Env-gated smoke mode runs windowed (not fullscreen) so CI / local validation
  // never hijacks the screen. The window is created fullscreen by default above.
  if ((SMOKE || WINDOWED) && typeof mainWindow.setFullScreen === 'function') {
    mainWindow.setFullScreen(false);
    if (WINDOWED && typeof mainWindow.setSize === 'function') {
      mainWindow.setSize(1280, 800);
      if (typeof mainWindow.center === 'function') mainWindow.center();
    }
  }

  // Instantiate Subsystems
  processManager = new ProcessManager();
  processManager.registerIpc(ipcMain);

  elevationDaemon = new ElevationDaemon({
    mainWindow: mainWindow,
    cwd: initialCwd,
    configStore: configStore,
    elevated: processElevated,
    // /op types commands into the real shell so output stays in sync with ConPTY.
    passThrough: true
  });

  ptyManager = new PtyManager({
    mainWindow: mainWindow,
    elevationDaemon: elevationDaemon,
    cwd: initialCwd,
    shellType: 'powershell',
    cols: 100,
    rows: 30,
    // Hold shell output until the renderer's terminal is attached, so the
    // first prompt is never lost (the terminal used to start blank).
    deferUntilRenderer: true,
    // Where the in-shell helper script (xcmd / xadmin / xsys) is written.
    helperDir: app ? app.getPath('userData') : undefined
  });
  ptyManager.init();
  ptyManager.registerIpc(ipcMain);

  // Synchronize Terminal CWD changes with Active Directory Watcher & Tree
  ptyManager.on('cwd-change', (newCwd) => {
    watchDirectory(newCwd, mainWindow);
    if (configStore && typeof configStore.setLastCwd === 'function') configStore.setLastCwd(newCwd);
    if (mainWindow && !mainWindow.isDestroyed?.() && !mainWindow.webContents?.isDestroyed?.()) {
      try {
        mainWindow.webContents.send('fs:dir-updated', newCwd);
      } catch (_e) {}
    }
  });

  // Instantiate Telemetry Engine (3-tier polling loop)
  telemetryEngine = new TelemetryEngine({
    processManager: processManager
  });
  // Start polling only once the page has loaded: the first polls spawn several
  // PowerShell/nvidia-smi processes, which used to compete with window startup.
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (telemetryEngine && mainWindow && !mainWindow.isDestroyed?.()) {
        telemetryEngine.start(mainWindow);
      }
    }, 200);
  });

  // Register Main Filesystem, Snapshot, and Window IPC
  registerMainIpc(ipcMain, {
    mainWindow,
    telemetryEngine,
    processManager,
    ptyManager,
    elevationDaemon,
    configStore
  });

  // Desktop integration: open/reveal files, links, terminal log, drive space
  if (SystemActions && electron && electron.shell) {
    SystemActions.unregisterSystemIpc(ipcMain);
    SystemActions.registerSystemIpc(ipcMain, {
      shell: electron.shell,
      getLogDir: () => path.join(app.getPath('documents'), 'XyronCenter', 'logs')
    });
  }

  // Initial Directory Watcher setup
  watchDirectory(initialCwd, mainWindow);

  // Load UI
  const rendererPath = path.join(__dirname, '../renderer/index.html');
  if (fs.existsSync(rendererPath)) {
    mainWindow.loadFile(rendererPath);
  } else {
    // Elegant fallback during modular development
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
      <!DOCTYPE html>
      <html>
        <head><meta charset="utf-8"><title>XYRON CENTER</title></head>
        <body style="background:#000;color:#fff;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
          <div style="text-align:center;">
            <h1 style="letter-spacing:4px;">XYRON CENTER</h1>
            <p style="color:#888;">Subsystems initialized. Awaiting interface...</p>
          </div>
        </body>
      </html>
    `));
  }

  mainWindow.once('ready-to-show', () => {
    perf('ready-to-show');
    if (!SMOKE) {
      mainWindow.show();
    }
  });
  if (PERF) {
    mainWindow.webContents.once('did-finish-load', () => perf('did-finish-load'));
  }

  // Smoke validation harness: surface renderer errors and auto-quit cleanly.
  if (SMOKE || PERF) {
    mainWindow.webContents.on('console-message', (_e, _level, message) => {
      console.log('[renderer]', message);
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error('[did-fail-load]', code, desc);
    });
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      console.error('[render-process-gone]', JSON.stringify(details));
    });
    mainWindow.webContents.once('did-finish-load', () => {
      console.log('[smoke] renderer did-finish-load OK');
      setTimeout(() => { try { app.quit(); } catch (_) {} }, 5000);
    });
  }

  // Quick-access tray: closing the window hides it there instead of quitting,
  // so the HUD stays one click away and its boot intro is not replayed on return.
  if (!SMOKE) createTray();

  mainWindow.on('close', (event) => {
    if (!isQuitting && tray) {
      event.preventDefault();
      mainWindow.hide();
      if (!trayHintShown) {
        trayHintShown = true;
        try {
          tray.displayBalloon({
            title: 'Xyron Center',
            content: 'Arka planda calisiyor. Simgeden geri acabilir, "Cikis" ile tamamen kapatabilirsin.'
          });
        } catch (_e) {}
      }
    }
  });

  mainWindow.on('closed', () => {
    cleanupServices({
      telemetryEngine,
      ptyManager,
      elevationDaemon,
      ipcMain
    });
    mainWindow = null;
  });

  return mainWindow;
}

/**
 * Make sure the process runs as Administrator before anything else starts.
 * Not elevated -> relaunch through the normal UAC consent flow and quit this
 * (unelevated) copy. UAC off / already admin -> silent. User declines -> keep
 * running in standard mode (the app still opens).
 *
 * @returns {Promise<boolean>} true when a new elevated copy took over and this
 *   process should exit.
 */
async function ensureElevated() {
  processElevated = ElevationBootstrap.isElevated();
  perf(`elevation-check elevated=${processElevated}`);

  const ctx = {
    platform: process.platform,
    env: process.env,
    argv: process.argv,
    elevated: processElevated
  };
  if (!ElevationBootstrap.shouldSelfElevate(ctx)) return false;

  const exePath = ElevationBootstrap.resolveRelaunchExe(process.env, process.execPath);
  const started = await ElevationBootstrap.relaunchElevated({
    exePath,
    args: process.argv.slice(1),
    cwd: process.cwd()
  });
  perf(`elevation-relaunch started=${started}`);
  return started;
}

// Single Instance Application Lock & Lifecycle Management
async function startApplication() {
  if (await ensureElevated()) {
    app.quit();
    return;
  }

  const hasLock = app.requestSingleInstanceLock();

  if (!hasLock) {
    app.quit();
  } else {
    // Launching the app again while it lives in the tray just brings it back,
    // without starting a second copy or replaying the boot intro.
    app.on('second-instance', () => {
      showMainWindow();
    });

    app.whenReady().then(() => {
      perf('app-ready');
      createMainWindow();
      perf('main-window-created');

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          createMainWindow();
        }
      });
    });

    app.on('window-all-closed', () => {
      cleanupServices({
        telemetryEngine,
        ptyManager,
        elevationDaemon,
        ipcMain
      });
      if (process.platform !== 'darwin') {
        app.quit();
      }
    });

    app.on('before-quit', () => {
      isQuitting = true; // let the window close for real instead of hiding to tray
      if (tray) {
        try { tray.destroy(); } catch (_e) {}
        tray = null;
      }
      cleanupServices({
        telemetryEngine,
        ptyManager,
        elevationDaemon,
        ipcMain
      });
    });
  }
}

if (isElectron && app) {
  startApplication().catch((err) => {
    console.error('[startup] fatal:', err && err.stack ? err.stack : err);
    try { app.quit(); } catch (_e) {}
  });
}

// Module exports for headless testing and external harnesses
module.exports = {
  readDirEntries,
  watchDirectory,
  registerMainIpc,
  cleanupServices,
  createMainWindow,
  WATCH_DEBOUNCE_MS,
  resolveInitialCwd
};
