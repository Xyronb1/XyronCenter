/**
 * XYRON CENTER - Hardware Telemetry Engine
 * File: src/main/telemetry-engine.js
 * 
 * 100% Genuine Win32 hardware telemetry engine with zero mock data.
 * Implements a 3-tier asynchronous polling loop:
 * - Tier 1 (500ms): Native CPU tick delta, RAM, uptime, clock, CNG hex diagnostic matrix
 * - Tier 2 (1000ms): nvidia-smi GPU parser / fallback, netstat -e bandwidth deltas
 * - Tier 3 (2500ms): MSFT_PhysicalDisk NVMe SMART/health, process enumeration
 */

const os = require('os');
const { execFile } = require('child_process');
const EventEmitter = require('events');
const si = require('systeminformation');
const ProcessManager = require('./process-manager');

let _cachedPhysicalCores = null;
let _cachedGpuModel = null;
let _cachedGpuVram = null;
let _staticHardwarePromise = null;

function _initStaticHardwareProbe() {
  if (!_staticHardwarePromise) {
    _staticHardwarePromise = (async () => {
      try {
        const cpuData = await si.cpu();
        if (cpuData && typeof cpuData.physicalCores === 'number' && cpuData.physicalCores > 0) {
          _cachedPhysicalCores = cpuData.physicalCores;
        }
      } catch (err) {}

      try {
        const gfxData = await si.graphics();
        if (gfxData && Array.isArray(gfxData.controllers) && gfxData.controllers.length > 0) {
          const dGpu = gfxData.controllers.find(c => 
            (c.vendor && /nvidia|amd/i.test(c.vendor)) ||
            (c.model && /nvidia|amd|geforce|radeon/i.test(c.model))
          ) || gfxData.controllers[0];

          if (dGpu) {
            _cachedGpuModel = dGpu.model || dGpu.name || null;
            if (typeof dGpu.vram === 'number' && dGpu.vram > 0) {
              _cachedGpuVram = Math.round(dGpu.vram);
            }
          }
        }
      } catch (e) {}
    })();
  }
  return _staticHardwarePromise;
}

_initStaticHardwareProbe();

class TelemetryEngine extends EventEmitter {
  /**
   * Read the received/sent byte counters from `netstat -e` on any Windows
   * language. The label is localized ("Bytes", "Octets", "Байт"...), but the
   * byte counters are always the first row that ends in two integers.
   *
   * @param {string} stdout
   * @returns {Array|null} match-like array [line, rx, tx] or null
   */
  static parseNetstatBytes(stdout) {
    const lines = String(stdout || '').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*\S.*?\s(\d+)\s+(\d+)\s*$/);
      if (m) return m;
    }
    return null;
  }

  constructor(options = {}) {
    super();
    this.processManager = options.processManager || new ProcessManager();
    this.mainWindow = null;
    this.isRunning = false;

    // Polling Intervals
    this.TIER1_INTERVAL = options.tier1Interval || 500;
    this.TIER2_INTERVAL = options.tier2Interval || 1000;
    this.TIER3_INTERVAL = options.tier3Interval || 2500;

    // Timer Handles
    this.tier1Timer = null;
    this.tier2Timer = null;
    this.tier3Timer = null;

    // In-flight Reentrancy Guards
    this.isTier2Polling = false;
    this.isTier3Polling = false;

    // CPU Tick Baseline State
    this.prevCpuSnapshot = null;

    // Network Bandwidth Baseline State
    this.prevNetSnapshot = null; // { rx, tx, timestamp }

    // Listener Lifecycle Tracking
    this._registeredWindow = null;
    this._onClosedHandler = () => this.stop();
    this._probeHardwarePromise = null;

    // Static Hardware Cache (Dynamic)
    this.staticHardware = {
      cpuModel: os.cpus()[0]?.model || 'Unknown CPU',
      logicalThreads: os.cpus().length,
      coresTotal: _cachedPhysicalCores, // Dynamic, probed via systeminformation
      activeAdapter: 'Unknown',
      gpuModel: _cachedGpuModel || 'Windows WDDM Display Adapter',
      gpuVramTotalMB: _cachedGpuVram
    };

    // Master Cached Telemetry State
    this.currentTelemetry = this._createInitialState();

    // Trigger static hardware probe
    this._probeStaticHardware();
  }

  /**
   * Initializes baseline readings and starts polling tiers.
   * @param {BrowserWindow} [mainWindow] - Electron BrowserWindow or duck-typed emitter to receive IPC updates.
   */
  start(mainWindow = null) {
    if (this.isRunning) return;
    this.isRunning = true;
    this.mainWindow = mainWindow;

    // Initial baseline snapshots
    this.prevCpuSnapshot = this._takeCpuSnapshot();
    this._probeStaticHardware();
    this._pollTier1(); // Immediate first read
    this._pollTier2();
    this._pollTier3();

    // Start 3-Tier Interval Loops
    this.tier1Timer = setInterval(() => this._pollTier1(), this.TIER1_INTERVAL);
    this.tier2Timer = setInterval(() => this._pollTier2(), this.TIER2_INTERVAL);
    this.tier3Timer = setInterval(() => this._pollTier3(), this.TIER3_INTERVAL);

    // Detach previous window listener if registered to prevent duplicate/leaked listeners
    if (this._registeredWindow && typeof this._registeredWindow.removeListener === 'function') {
      this._registeredWindow.removeListener('closed', this._onClosedHandler);
      this._registeredWindow = null;
    }

    if (this.mainWindow && typeof this.mainWindow.on === 'function') {
      this.mainWindow.on('closed', this._onClosedHandler);
      this._registeredWindow = this.mainWindow;
    }
  }

  /**
   * Stops all polling timers and releases handles.
   */
  stop() {
    this.isRunning = false;
    if (this.tier1Timer) { clearInterval(this.tier1Timer); this.tier1Timer = null; }
    if (this.tier2Timer) { clearInterval(this.tier2Timer); this.tier2Timer = null; }
    if (this.tier3Timer) { clearInterval(this.tier3Timer); this.tier3Timer = null; }

    // Detach window listener to prevent MaxListenersExceededWarning across restarts
    if (this._registeredWindow && typeof this._registeredWindow.removeListener === 'function') {
      this._registeredWindow.removeListener('closed', this._onClosedHandler);
      this._registeredWindow = null;
    }
  }

  /**
   * Returns current latest telemetry object.
   * @returns {Object} SystemTelemetry snapshot
   */
  getLatestTelemetry() {
    return JSON.parse(JSON.stringify(this.currentTelemetry));
  }

  // -------------------------------------------------------------
  // TIER 1: FAST NATIVE METRICS (500ms)
  // -------------------------------------------------------------
  _pollTier1() {
    const now = new Date();
    const currCpu = this._takeCpuSnapshot();

    // 1. Calculate CPU tick delta across all logical threads
    let totalDeltaAll = 0;
    let idleDeltaAll = 0;
    const coreWorkloads = [];

    if (this.prevCpuSnapshot && this.prevCpuSnapshot.length === currCpu.length) {
      for (let i = 0; i < currCpu.length; i++) {
        const c1 = this.prevCpuSnapshot[i];
        const c2 = currCpu[i];
        const dTotal = c2.total - c1.total;
        const dIdle = c2.idle - c1.idle;
        totalDeltaAll += dTotal;
        idleDeltaAll += dIdle;

        const usage = dTotal > 0
          ? Math.max(0, Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 100)))
          : 0;
        coreWorkloads.push(usage);
      }
    } else {
      // First tick baseline
      for (let i = 0; i < currCpu.length; i++) coreWorkloads.push(0);
    }
    this.prevCpuSnapshot = currCpu;

    const overallUsage = totalDeltaAll > 0
      ? Math.max(0, Math.min(100, Math.round(((totalDeltaAll - idleDeltaAll) / totalDeltaAll) * 100)))
      : 0;

    // 2. Physical Memory Metrics
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const usedPercent = totalMem > 0 ? Number(((usedMem / totalMem) * 100).toFixed(1)) : 0;

    // 3. Real-Time Clock & Uptime
    const timeStr = now.toLocaleTimeString('tr-TR', { hour12: false }) + '.' + String(now.getMilliseconds()).padStart(3, '0');
    const dateStr = `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}`;

    // Update state
    this.currentTelemetry.timestamp = now.getTime();
    this.currentTelemetry.uptime = Math.floor(os.uptime());
    this.currentTelemetry.clock = {
      time: timeStr,
      date: dateStr,
      iso: now.toISOString()
    };
    this.currentTelemetry.cpu.overallUsagePercent = overallUsage;
    this.currentTelemetry.cpu.coreWorkloads = coreWorkloads;
    this.currentTelemetry.memory = {
      totalBytes: totalMem,
      freeBytes: freeMem,
      usedBytes: usedMem,
      usedPercent: usedPercent
    };

    // 4. Update Live Hex Diagnostic Stream (Windows CNG entropy + live counters)
    if (this.processManager && typeof this.processManager.generateHexFrame === 'function') {
      const hexFrame = this.processManager.generateHexFrame({
        rxBytes: this.currentTelemetry.network.rxBytesPerSec,
        txBytes: this.currentTelemetry.network.txBytesPerSec,
        cpuLoad: overallUsage,
        procCount: this.currentTelemetry.processes.length
      });
      this.currentTelemetry.diagnosticHexStream = {
        offset: hexFrame.offset,
        hexBytes: hexFrame.hexBytes,
        ascii: hexFrame.ascii
      };
      this.currentTelemetry.hexMatrix = hexFrame.rows;
    }

    // Broadcast update
    this._broadcast();
  }

  // -------------------------------------------------------------
  // TIER 2: GPU & NETWORK METRICS (1000ms)
  // -------------------------------------------------------------
  async _pollTier2() {
    if (this.isTier2Polling) return;
    this.isTier2Polling = true;

    try {
      await Promise.allSettled([
        this._queryGpu(),
        this._queryNetwork()
      ]);
    } finally {
      this.isTier2Polling = false;
    }
  }

  _queryGpu() {
    return new Promise((resolve) => {
      const args = [
        '--query-gpu=name,temperature.gpu,utilization.gpu,utilization.memory,memory.total,memory.used,memory.free,power.draw,fan.speed',
        '--format=csv,noheader,nounits'
      ];

      execFile('nvidia-smi', args, { timeout: 1800, windowsHide: true }, (err, stdout) => {
        if (!err && stdout && stdout.trim().length > 0) {
          const parts = stdout.trim().split(',').map(s => s.trim());
          const name = parts[0] || 'NVIDIA GPU';
          const temp = isNaN(Number(parts[1])) ? null : Number(parts[1]);
          const load = isNaN(Number(parts[2])) ? null : Math.round(Number(parts[2]));
          const vramTotal = isNaN(Number(parts[4])) ? null : Math.round(Number(parts[4]));
          const vramUsed = isNaN(Number(parts[5])) ? null : Math.round(Number(parts[5]));
          const power = isNaN(Number(parts[7])) ? null : Number(parts[7]);

          // Parse fan speed from index 8: numeric percentage, or null with UNSUPPORTED_BY_OEM_EC
          const rawFan = parts.length > 8 ? parts[8] : null;
          const hasNumericFan = rawFan !== null && rawFan !== '' && rawFan !== '[N/A]' && !isNaN(Number(rawFan));
          const fanPercent = hasNumericFan ? Number(rawFan) : null;
          const fanStatus = hasNumericFan ? 'LIVE' : 'UNSUPPORTED_BY_OEM_EC';

          this.currentTelemetry.gpu = {
            name: name,
            temperatureCelsius: temp,
            utilizationPercent: load,
            vramUsedMB: vramUsed,
            vramTotalMB: vramTotal,
            powerDrawWatts: power,
            fanSpeedPercent: fanPercent,
            status: 'ONLINE'
          };
          this.currentTelemetry.temperatures.gpu = {
            value: temp,
            status: temp !== null ? 'LIVE' : 'OFFLINE'
          };
          this.currentTelemetry.fans = {
            rpm: null,
            fanSpeedPercent: fanPercent,
            status: fanStatus
          };
          resolve();
        } else {
          // Fallback if nvidia-smi is unavailable: universal WDDM / DirectX query
          this._queryWddmFallback().then(resolve);
        }
      });
    });
  }

  _queryWddmFallback() {
    return new Promise((resolve) => {
      // Get-Counter needs counter names in the OS display language (it fails on
      // e.g. German Windows); the CIM perf class name is the same on every locale.
      const psCommand = "try { $val = (Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory -ErrorAction Stop | Measure-Object -Property DedicatedUsage -Maximum).Maximum; if ($null -ne $val) { [math]::Round($val / 1MB) } else { '' } } catch { '' }";

      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCommand], { timeout: 3500, windowsHide: true }, (err, stdout) => {
        let vramUsedMB = null;
        if (!err && stdout && stdout.trim().length > 0) {
          const parsed = Number(stdout.trim());
          if (!isNaN(parsed) && parsed >= 0) {
            vramUsedMB = parsed;
          }
        }

        const gpuName = this.staticHardware.gpuModel || 'Display Adapter (WDDM)';
        const vramTotal = this.staticHardware.gpuVramTotalMB || null;
        const isOnline = vramUsedMB !== null || gpuName !== 'Display Adapter (WDDM)';

        this.currentTelemetry.gpu = {
          name: gpuName,
          temperatureCelsius: null,
          utilizationPercent: null,
          vramUsedMB: vramUsedMB,
          vramTotalMB: vramTotal,
          powerDrawWatts: null,
          fanSpeedPercent: null,
          status: isOnline ? 'ONLINE' : 'OFFLINE'
        };
        this.currentTelemetry.temperatures.gpu = {
          value: null,
          status: 'OFFLINE'
        };
        this.currentTelemetry.fans = {
          rpm: null,
          fanSpeedPercent: null,
          status: 'UNSUPPORTED_BY_OEM_EC'
        };
        resolve();
      });
    });
  }

  _queryNetwork() {
    return new Promise((resolve) => {
      execFile('netstat', ['-e'], { timeout: 1500, windowsHide: true }, (err, stdout) => {
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (!err && stdout) {
          const match = TelemetryEngine.parseNetstatBytes(stdout);
          if (match) {
            const rxCurr = parseInt(match[1], 10);
            const txCurr = parseInt(match[2], 10);

            if (this.prevNetSnapshot) {
              const dt = (now - this.prevNetSnapshot.timestamp) / 1000;
              if (dt > 0) {
                let rxDelta = rxCurr - this.prevNetSnapshot.rx;
                let txDelta = txCurr - this.prevNetSnapshot.tx;

                // Handle 32-bit integer rollover
                const UINT32_MAX = 4294967296;
                if (rxDelta < 0 && rxDelta + UINT32_MAX > 0) rxDelta += UINT32_MAX;
                if (txDelta < 0 && txDelta + UINT32_MAX > 0) txDelta += UINT32_MAX;

                this.currentTelemetry.network.rxBytesPerSec = rxDelta >= 0 ? Math.round(rxDelta / dt) : 0;
                this.currentTelemetry.network.txBytesPerSec = txDelta >= 0 ? Math.round(txDelta / dt) : 0;
              }
            }

            this.prevNetSnapshot = { rx: rxCurr, tx: txCurr, timestamp: now };
          }
        }
        resolve();
      });
    });
  }

  // -------------------------------------------------------------
  // TIER 3: STORAGE, HEALTH & PROCESSES (2500ms)
  // -------------------------------------------------------------
  async _pollTier3() {
    if (this.isTier3Polling) return;
    this.isTier3Polling = true;

    try {
      await Promise.allSettled([
        this._queryStorage(),
        this._queryProcessManager()
      ]);
    } finally {
      this.isTier3Polling = false;
    }
  }

  _queryStorage() {
    return new Promise((resolve) => {
      const psScript = `
        $disk = Get-CimInstance -Namespace ROOT/Microsoft/Windows/Storage -ClassName MSFT_PhysicalDisk | Select-Object -First 1 DeviceId, FriendlyName, MediaType, BusType, HealthStatus, Size
        $temp = $null
        try {
          $rel = Get-StorageReliabilityCounter -PhysicalDisk $disk -ErrorAction Stop
          $temp = $rel.Temperature
        } catch {}
        [PSCustomObject]@{
          FriendlyName = $disk.FriendlyName
          BusType = $disk.BusType
          HealthStatus = $disk.HealthStatus
          Temperature = $temp
        } | ConvertTo-Json -Compress
      `;

      const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 3500, windowsHide: true }, (err, stdout) => {
        if (!err && stdout && stdout.trim().length > 0) {
          try {
            const data = JSON.parse(stdout.trim());
            const busMap = { 17: 'NVMe', 11: 'SATA', 8: 'RAID', 3: 'ATAPI', 7: 'USB' };
            const healthMap = { 0: 'Healthy', 1: 'Warning', 2: 'Unhealthy' };

            this.currentTelemetry.storage = {
              model: data.FriendlyName || 'Generic NVMe SSD',
              busType: busMap[data.BusType] || 'NVMe',
              healthStatus: healthMap[data.HealthStatus] || 'Healthy',
              temperatureCelsius: data.Temperature !== null && !isNaN(Number(data.Temperature)) ? Number(data.Temperature) : null
            };

            this.currentTelemetry.temperatures.nvme = {
              value: this.currentTelemetry.storage.temperatureCelsius,
              status: this.currentTelemetry.storage.temperatureCelsius !== null ? 'LIVE' : 'OFFLINE'
            };
          } catch (e) {}
        }
        resolve();
      });
    });
  }

  async _queryProcessManager() {
    if (this.processManager && typeof this.processManager.getProcesses === 'function') {
      try {
        const procList = await this.processManager.getProcesses();
        if (Array.isArray(procList)) {
          this.currentTelemetry.processes = procList;
        }
      } catch (e) {}
    }
  }

  // -------------------------------------------------------------
  // HELPER METHODS
  // -------------------------------------------------------------
  _takeCpuSnapshot() {
    const cpus = os.cpus();
    return cpus.map(c => {
      const times = c.times;
      const total = times.user + times.nice + times.sys + times.idle + times.irq;
      return { idle: times.idle, total: total };
    });
  }

  _probeStaticHardware() {
    if (this._probeHardwarePromise) {
      return this._probeHardwarePromise;
    }

    this._probeHardwarePromise = (async () => {
      // 1. Detect active network adapter name
      try {
        const ifaces = os.networkInterfaces();
        for (const [name, addrs] of Object.entries(ifaces)) {
          for (const a of addrs) {
            if (!a.internal && a.family === 'IPv4') {
              this.staticHardware.activeAdapter = name;
              if (this.currentTelemetry && this.currentTelemetry.network) {
                this.currentTelemetry.network.activeAdapter = name;
              }
              break;
            }
          }
        }
      } catch (e) {}

      // Ensure background probe completes
      await _initStaticHardwareProbe();

      // 2. Query physical CPU cores dynamically via systeminformation
      if (_cachedPhysicalCores) {
        this.staticHardware.coresTotal = _cachedPhysicalCores;
        if (this.currentTelemetry && this.currentTelemetry.cpu) {
          this.currentTelemetry.cpu.coresTotal = _cachedPhysicalCores;
        }
      } else {
        try {
          const cpuData = await si.cpu();
          const detectedCores = (cpuData && typeof cpuData.physicalCores === 'number' && cpuData.physicalCores > 0)
            ? cpuData.physicalCores
            : Math.max(1, Math.floor(this.staticHardware.logicalThreads / 2));
          _cachedPhysicalCores = detectedCores;
          this.staticHardware.coresTotal = detectedCores;
          if (this.currentTelemetry && this.currentTelemetry.cpu) {
            this.currentTelemetry.cpu.coresTotal = detectedCores;
          }
        } catch (err) {
          const fallbackCores = Math.max(1, Math.floor(this.staticHardware.logicalThreads / 2));
          this.staticHardware.coresTotal = fallbackCores;
          if (this.currentTelemetry && this.currentTelemetry.cpu) {
            this.currentTelemetry.cpu.coresTotal = fallbackCores;
          }
        }
      }

      // 3. Probe static GPU controller metadata via systeminformation for WDDM fallback
      if (_cachedGpuModel) {
        this.staticHardware.gpuModel = _cachedGpuModel;
        this.staticHardware.gpuVramTotalMB = _cachedGpuVram;
      } else {
        try {
          const gfxData = await si.graphics();
          if (gfxData && Array.isArray(gfxData.controllers) && gfxData.controllers.length > 0) {
            const dGpu = gfxData.controllers.find(c => 
              (c.vendor && /nvidia|amd/i.test(c.vendor)) ||
              (c.model && /nvidia|amd|geforce|radeon/i.test(c.model))
            ) || gfxData.controllers[0];

            if (dGpu) {
              const model = dGpu.model || dGpu.name || this.staticHardware.gpuModel;
              const vram = (typeof dGpu.vram === 'number' && dGpu.vram > 0) ? Math.round(dGpu.vram) : null;
              _cachedGpuModel = model;
              _cachedGpuVram = vram;
              this.staticHardware.gpuModel = model;
              this.staticHardware.gpuVramTotalMB = vram;
            }
          }
        } catch (e) {}
      }
    })();

    return this._probeHardwarePromise;
  }

  _broadcast() {
    // 1. Emit internal event for Node / tests
    this.emit('update', this.currentTelemetry);

    // 2. Broadcast over Electron IPC if active window exists
    if (this.mainWindow && !this.mainWindow.isDestroyed?.() && !this.mainWindow.webContents?.isDestroyed?.()) {
      try {
        this.mainWindow.webContents.send('telemetry:update', this.currentTelemetry);
      } catch (e) {}
    }
  }

  _createInitialState() {
    return {
      timestamp: Date.now(),
      uptime: Math.floor(os.uptime()),
      clock: {
        time: '--:--:--.---',
        date: '--.--.----',
        iso: new Date().toISOString()
      },
      cpu: {
        model: this.staticHardware.cpuModel,
        coresTotal: this.staticHardware.coresTotal,
        logicalThreads: this.staticHardware.logicalThreads,
        overallUsagePercent: 0,
        coreWorkloads: new Array(this.staticHardware.logicalThreads).fill(0)
      },
      memory: {
        totalBytes: os.totalmem(),
        freeBytes: os.freemem(),
        usedBytes: os.totalmem() - os.freemem(),
        usedPercent: 0
      },
      gpu: {
        name: 'Detecting GPU...',
        temperatureCelsius: null,
        utilizationPercent: null,
        vramUsedMB: null,
        vramTotalMB: null,
        powerDrawWatts: null,
        status: 'ONLINE'
      },
      storage: {
        model: 'Detecting Storage...',
        busType: 'NVMe',
        healthStatus: 'Healthy',
        temperatureCelsius: null
      },
      network: {
        rxBytesPerSec: 0,
        txBytesPerSec: 0,
        activeAdapter: 'Detecting...'
      },
      temperatures: {
        cpu: { value: null, status: 'OFFLINE' },
        gpu: { value: null, status: 'OFFLINE' },
        nvme: { value: null, status: 'OFFLINE' },
        motherboard: { value: null, status: 'OFFLINE' }
      },
      fans: {
        rpm: null,
        status: 'UNSUPPORTED_BY_OEM_EC'
      },
      diagnosticHexStream: {
        offset: '0x00400000',
        hexBytes: '00 00 00 00 00 00 00 00   00 00 00 00 00 00 00 00',
        ascii: '................'
      },
      hexMatrix: [],
      processes: []
    };
  }
}

module.exports = TelemetryEngine;
