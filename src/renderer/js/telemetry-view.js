/**
 * XYRON CENTER - Hardware Telemetry Core View
 * File: src/renderer/js/telemetry-view.js
 * 
 * Binds 100% Genuine Win32 hardware telemetry stream to the Left Panel HUD
 * with strict enforcement of the ZERO MOCK INVARIANT.
 */

class TelemetryView {
  constructor() {
    // DOM Elements Cache
    this.dom = {
      clock: document.getElementById('hud-clock'),
      date: document.getElementById('hud-date'),
      uptime: document.getElementById('hud-uptime'),

      cpuModel: document.getElementById('cpu-model-label'),
      cpuOverallPercent: document.getElementById('cpu-overall-percent'),
      cpuOverallBar: document.getElementById('cpu-overall-bar'),
      cpuThreads: document.getElementById('cpu-threads-val'),
      cpuCores: document.getElementById('cpu-cores-val'),
      cpuCoresContainer: document.getElementById('cpu-cores-container'),

      ramPercent: document.getElementById('ram-percent-val'),
      ramBarFill: document.getElementById('ram-bar-fill'),
      ramUsed: document.getElementById('ram-used-val'),
      ramTotal: document.getElementById('ram-total-val'),
      ramFree: document.getElementById('ram-free-val'),

      gpuLoad: document.getElementById('gpu-load-val'),
      gpuName: document.getElementById('gpu-name-label'),
      gpuBarFill: document.getElementById('gpu-bar-fill'),
      vramUsed: document.getElementById('vram-used-val'),
      vramTotal: document.getElementById('vram-total-val'),
      gpuPower: document.getElementById('gpu-power-val'),

      tempCpu: document.getElementById('temp-cpu-val'),
      tempGpu: document.getElementById('temp-gpu-val'),
      tempNvme: document.getElementById('temp-nvme-val'),
      tempMb: document.getElementById('temp-mb-val'),
      fanRpm: document.getElementById('fan-rpm-val'),

      netAdapter: document.getElementById('net-adapter-label'),
      netRxRate: document.getElementById('net-rx-rate'),
      netTxRate: document.getElementById('net-tx-rate'),
      netSparkline: document.getElementById('net-sparkline-canvas')
    };

    // Sparkline History Buffers (40 rolling points)
    this.SPARKLINE_POINTS = 40;
    this.rxHistory = new Array(this.SPARKLINE_POINTS).fill(0);
    this.txHistory = new Array(this.SPARKLINE_POINTS).fill(0);

    // Dynamic Per-Core DOM Cache
    this.coreElements = [];
    this.unsubscribeTelemetry = null;

    // Sparkline Canvas 2D Context & High-DPI Setup
    this.sparkCtx = null;
    this._initCanvas();
  }

  /**
   * Initialize and attach live telemetry listeners.
   */
  init() {
    if (window.telemetryApi && typeof window.telemetryApi.onUpdate === 'function') {
      this.unsubscribeTelemetry = window.telemetryApi.onUpdate(data => this.update(data));
    }
    this.startLiveClock();
  }

  /**
   * Format a Date as HH:MM:SS.mmm (24h, local time).
   * @param {Date} now
   * @returns {string}
   */
  static formatClock(now) {
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
  }

  /**
   * Drive the header clock from the renderer every animation frame, so the
   * milliseconds run continuously instead of jumping with the 500 ms telemetry
   * tick. requestAnimationFrame pauses by itself while the window is hidden.
   */
  startLiveClock() {
    // No requestAnimationFrame (headless tests) -> keep the telemetry-fed clock.
    if (!this.dom.clock || this._clockRunning || typeof requestAnimationFrame !== 'function') return;
    this._clockRunning = true;
    const tick = () => {
      if (!this._clockRunning) return;
      this.dom.clock.textContent = TelemetryView.formatClock(new Date());
      this._clockFrame = requestAnimationFrame(tick);
    };
    tick();
  }

  /**
   * Stop the live clock loop.
   */
  stopLiveClock() {
    this._clockRunning = false;
    if (this._clockFrame != null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._clockFrame);
      this._clockFrame = null;
    }
  }

  /**
   * Configure high-DPI scaling for sparkline canvas.
   * @private
   */
  _initCanvas() {
    if (!this.dom.netSparkline) return;
    const canvas = this.dom.netSparkline;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || 280;
    const height = rect.height || 42;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    if (typeof canvas.getContext === 'function') {
      this.sparkCtx = canvas.getContext('2d');
      if (this.sparkCtx) {
        this.sparkCtx.scale(dpr, dpr);
      }
    }
  }

  /**
   * Main telemetry dispatch handler.
   * @param {Object} data - SystemTelemetry snapshot from main process
   */
  update(data) {
    if (!data || typeof data !== 'object') return;

    this._updateClockAndUptime(data);
    this._updateCpu(data.cpu);
    this._updateMemory(data.memory);
    this._updateGpu(data.gpu);
    this._updateThermals(data.temperatures, data.fans, data.storage);
    this._updateNetwork(data.network);
  }

  /**
   * Real-time clock and uptime binding.
   * @private
   */
  _updateClockAndUptime(data) {
    if (data.clock) {
      // The live renderer loop owns the clock; telemetry only fills it if that loop is not running.
      if (this.dom.clock && data.clock.time && !this._clockRunning) this.dom.clock.textContent = data.clock.time;
      if (this.dom.date && data.clock.date) this.dom.date.textContent = data.clock.date;
    }
    if (typeof data.uptime === 'number' && this.dom.uptime) {
      const days = Math.floor(data.uptime / 86400);
      const hours = Math.floor((data.uptime % 86400) / 3600);
      const minutes = Math.floor((data.uptime % 3600) / 60);
      const seconds = data.uptime % 60;
      this.dom.uptime.textContent = `UPTIME: ${days}d ${hours}h ${minutes}m ${seconds}s`;
    }
  }

  /**
   * CPU telemetry binding with dynamic per-core bar generation.
   * @private
   */
  _updateCpu(cpu) {
    if (!cpu) return;

    // Overall CPU load %
    const overall = typeof cpu.overallUsagePercent === 'number' ? Math.max(0, Math.min(100, Math.round(cpu.overallUsagePercent))) : 0;
    if (this.dom.cpuOverallPercent) this.dom.cpuOverallPercent.textContent = `${overall}%`;
    if (this.dom.cpuOverallBar) this.dom.cpuOverallBar.style.width = `${overall}%`;
    TelemetryView.markLevel([this.dom.cpuOverallBar, this.dom.cpuOverallPercent], TelemetryView.loadLevel(overall));

    // Static hardware info
    if (cpu.model && this.dom.cpuModel) this.dom.cpuModel.textContent = cpu.model;
    if (cpu.logicalThreads && this.dom.cpuThreads) this.dom.cpuThreads.textContent = cpu.logicalThreads;
    if (cpu.coresTotal && this.dom.cpuCores) this.dom.cpuCores.textContent = cpu.coresTotal;

    // Per-core workload bars
    if (Array.isArray(cpu.coreWorkloads) && this.dom.cpuCoresContainer) {
      const count = cpu.coreWorkloads.length;

      // Dynamically build DOM elements if count differs
      if (this.coreElements.length !== count) {
        this.dom.cpuCoresContainer.innerHTML = '';
        this.coreElements = [];

        for (let i = 0; i < count; i++) {
          const row = document.createElement('div');
          row.className = 'core-row';

          const header = document.createElement('div');
          header.className = 'core-header';

          const nameSpan = document.createElement('span');
          nameSpan.textContent = `CORE #${i}`;

          const valSpan = document.createElement('span');
          valSpan.textContent = '0%';

          header.appendChild(nameSpan);
          header.appendChild(valSpan);

          const track = document.createElement('div');
          track.className = 'core-bar-track';

          const fill = document.createElement('div');
          fill.className = 'core-bar-fill';
          fill.style.width = '0%';

          track.appendChild(fill);
          row.appendChild(header);
          row.appendChild(track);

          this.dom.cpuCoresContainer.appendChild(row);
          this.coreElements.push({ valSpan, fill });
        }
      }

      // Update per-core fill and values
      for (let i = 0; i < count; i++) {
        const usage = Math.max(0, Math.min(100, Math.round(cpu.coreWorkloads[i] || 0)));
        const el = this.coreElements[i];
        if (el) {
          el.valSpan.textContent = `${usage}%`;
          el.fill.style.width = `${usage}%`;
          // Load level is expressed through the stylesheet (solid / hatched), not
          // through hard-coded colors, so it follows the live theme.
          el.fill.classList.toggle('level-high', usage > 80);
          el.fill.classList.toggle('level-mid', usage > 50 && usage <= 80);
        }
      }
    }
  }

  /**
   * Physical RAM telemetry binding.
   * @private
   */
  _updateMemory(mem) {
    if (!mem) return;

    const percent = typeof mem.usedPercent === 'number' ? mem.usedPercent : 0;
    if (this.dom.ramPercent) this.dom.ramPercent.textContent = `${percent.toFixed(1)}%`;
    if (this.dom.ramBarFill) this.dom.ramBarFill.style.width = `${percent}%`;
    TelemetryView.markLevel([this.dom.ramBarFill, this.dom.ramPercent], TelemetryView.loadLevel(percent));

    const usedGB = (mem.usedBytes / (1024 ** 3)).toFixed(1);
    const totalGB = (mem.totalBytes / (1024 ** 3)).toFixed(1);
    const freeGB = (mem.freeBytes / (1024 ** 3)).toFixed(1);

    if (this.dom.ramUsed) this.dom.ramUsed.textContent = `${usedGB} GB`;
    if (this.dom.ramTotal) this.dom.ramTotal.textContent = `${totalGB} GB`;
    if (this.dom.ramFree) this.dom.ramFree.textContent = `${freeGB} GB`;
  }

  /**
   * GPU & VRAM telemetry binding.
   * @private
   */
  _updateGpu(gpu) {
    if (!gpu) return;

    if (gpu.name && this.dom.gpuName) this.dom.gpuName.textContent = gpu.name;

    // GPU Utilization %
    if (gpu.utilizationPercent !== null && gpu.utilizationPercent !== undefined) {
      const load = Math.round(gpu.utilizationPercent);
      if (this.dom.gpuLoad) this.dom.gpuLoad.textContent = `${load}%`;
      if (this.dom.gpuBarFill) this.dom.gpuBarFill.style.width = `${load}%`;
      TelemetryView.markLevel([this.dom.gpuBarFill, this.dom.gpuLoad], TelemetryView.loadLevel(load));
    } else {
      TelemetryView.markLevel([this.dom.gpuBarFill, this.dom.gpuLoad], '');
      if (this.dom.gpuLoad) this.dom.gpuLoad.textContent = 'OFFLINE';
      if (this.dom.gpuBarFill) this.dom.gpuBarFill.style.width = '0%';
    }

    // VRAM Metrics
    if (gpu.vramUsedMB !== null && gpu.vramUsedMB !== undefined) {
      if (this.dom.vramUsed) this.dom.vramUsed.textContent = `${gpu.vramUsedMB} MB`;
    } else {
      if (this.dom.vramUsed) this.dom.vramUsed.textContent = 'OFFLINE';
    }

    if (gpu.vramTotalMB !== null && gpu.vramTotalMB !== undefined) {
      if (this.dom.vramTotal) this.dom.vramTotal.textContent = `${gpu.vramTotalMB} MB`;
    } else {
      if (this.dom.vramTotal) this.dom.vramTotal.textContent = 'OFFLINE';
    }

    // Power draw
    if (gpu.powerDrawWatts !== null && gpu.powerDrawWatts !== undefined) {
      if (this.dom.gpuPower) this.dom.gpuPower.textContent = `${gpu.powerDrawWatts.toFixed(1)} W`;
    } else {
      if (this.dom.gpuPower) this.dom.gpuPower.textContent = 'OFFLINE';
    }
  }

  /**
   * Load level for a percentage: '' (normal), 'warn' or 'crit'.
   * @param {number} percent
   * @param {number} [warnAt=85]
   * @param {number} [critAt=95]
   * @returns {''|'warn'|'crit'}
   */
  static loadLevel(percent, warnAt = 85, critAt = 95) {
    const n = Number(percent);
    if (!isFinite(n)) return '';
    if (n >= critAt) return 'crit';
    if (n >= warnAt) return 'warn';
    return '';
  }

  /**
   * Tag elements with load-warn / load-crit. The look comes from the stylesheet
   * (hatching, blinking), so it follows the live monochrome theme.
   * @param {Array<Element|null>} elements
   * @param {''|'warn'|'crit'} level
   */
  static markLevel(elements, level) {
    elements.forEach((el) => {
      if (!el || !el.classList) return;
      el.classList.toggle('load-warn', level === 'warn');
      el.classList.toggle('load-crit', level === 'crit');
    });
  }

  /**
   * @param {number} bytes
   * @returns {string} e.g. "381 GB", "1.82 TB"
   */
  static formatCapacity(bytes) {
    const n = Number(bytes) || 0;
    const tb = n / (1024 ** 4);
    if (tb >= 1) return `${tb.toFixed(2)} TB`;
    const gb = n / (1024 ** 3);
    return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
  }

  /**
   * Render the STORAGE section from systemApi.getDrives().
   * @param {Array<{drive:string,totalBytes:number,freeBytes:number,usedPercent:number}>} drives
   */
  updateDrives(drives) {
    const host = document.getElementById('drive-list');
    if (!host) return;
    host.innerHTML = '';
    if (!Array.isArray(drives) || !drives.length) {
      const empty = document.createElement('div');
      empty.className = 'drive-empty';
      empty.textContent = 'NO DRIVES';
      host.appendChild(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    drives.slice(0, 8).forEach((d) => {
      const row = document.createElement('div');
      row.className = 'drive-row';
      row.title = `${d.drive}\\  ${TelemetryView.formatCapacity(d.freeBytes)} free of ${TelemetryView.formatCapacity(d.totalBytes)}`;

      const head = document.createElement('div');
      head.className = 'drive-head';
      const name = document.createElement('span');
      name.className = 'drive-name';
      name.textContent = d.drive;
      const pct = document.createElement('span');
      pct.className = 'drive-pct';
      pct.textContent = `${d.usedPercent}%`;
      head.appendChild(name);
      head.appendChild(pct);

      const track = document.createElement('div');
      track.className = 'gauge-bar-track';
      const fill = document.createElement('div');
      fill.className = 'gauge-bar-fill';
      fill.style.width = `${d.usedPercent}%`;
      track.appendChild(fill);

      const meta = document.createElement('div');
      meta.className = 'drive-meta';
      meta.textContent = `FREE ${TelemetryView.formatCapacity(d.freeBytes)} / ${TelemetryView.formatCapacity(d.totalBytes)}`;

      TelemetryView.markLevel([fill, pct], TelemetryView.loadLevel(d.usedPercent, 90, 97));
      row.appendChild(head);
      row.appendChild(track);
      row.appendChild(meta);
      frag.appendChild(row);
    });
    host.appendChild(frag);
  }

  /**
   * Thermal & Cooling Matrix (Zero Mock Fallback Contract).
   * @private
   */
  _updateThermals(temps, fans, storage) {
    // 1. CPU Temperature
    this._renderSensor(this.dom.tempCpu, temps?.cpu?.value, temps?.cpu?.status);

    // 2. GPU Temperature
    this._renderSensor(this.dom.tempGpu, temps?.gpu?.value, temps?.gpu?.status);

    // 3. NVMe SSD Temperature
    const nvmeTemp = storage?.temperatureCelsius ?? temps?.nvme?.value;
    const nvmeStatus = storage?.temperatureCelsius !== null ? 'LIVE' : (temps?.nvme?.status || 'OFFLINE');
    this._renderSensor(this.dom.tempNvme, nvmeTemp, nvmeStatus);

    // 4. Motherboard Temperature
    this._renderSensor(this.dom.tempMb, temps?.motherboard?.value, temps?.motherboard?.status);

    // 5. Fan Tachometer
    if (this.dom.fanRpm) {
      if (fans && fans.rpm !== null && fans.rpm !== undefined) {
        this.dom.fanRpm.textContent = `${fans.rpm} RPM`;
        this.dom.fanRpm.className = 'fan-val badge-sensor status-nominal';
      } else if (fans && fans.fanSpeedPercent !== null && fans.fanSpeedPercent !== undefined) {
        this.dom.fanRpm.textContent = `${fans.fanSpeedPercent}%`;
        this.dom.fanRpm.className = 'fan-val badge-sensor status-nominal';
      } else {
        this.dom.fanRpm.textContent = 'UNSUPPORTED_BY_OEM_EC';
        this.dom.fanRpm.className = 'fan-val badge-sensor status-unsupported';
      }
    }
  }

  /**
   * Helper to format temperature sensor values.
   * @private
   */
  _renderSensor(el, value, status) {
    if (!el) return;
    if (value !== null && value !== undefined && !isNaN(Number(value))) {
      const temp = Math.round(Number(value));
      el.textContent = `${temp}°C`;
      if (temp > 85) {
        el.className = 'sensor-val badge-sensor status-critical';
      } else if (temp > 68) {
        el.className = 'sensor-val badge-sensor status-warm';
      } else {
        el.className = 'sensor-val badge-sensor status-nominal';
      }
    } else {
      el.textContent = 'OFFLINE';
      el.className = 'sensor-val badge-sensor status-offline';
    }
  }

  /**
   * Network bandwidth calculation and rolling sparkline canvas rendering.
   * @private
   */
  _updateNetwork(net) {
    if (!net) return;

    if (net.activeAdapter && this.dom.netAdapter) {
      this.dom.netAdapter.textContent = net.activeAdapter;
    }

    const rx = typeof net.rxBytesPerSec === 'number' ? net.rxBytesPerSec : 0;
    const tx = typeof net.txBytesPerSec === 'number' ? net.txBytesPerSec : 0;

    if (this.dom.netRxRate) this.dom.netRxRate.textContent = this._formatRate(rx);
    if (this.dom.netTxRate) this.dom.netTxRate.textContent = this._formatRate(tx);

    // Push into rolling buffers
    this.rxHistory.push(rx);
    this.rxHistory.shift();

    this.txHistory.push(tx);
    this.txHistory.shift();

    this._drawSparkline();
  }

  /**
   * Draw dual RX (cyan) & TX (amber) sparkline curves on HTML5 canvas.
   * @private
   */
  _drawSparkline() {
    if (!this.sparkCtx || !this.dom.netSparkline) return;
    const ctx = this.sparkCtx;
    const width = 280;
    const height = 42;

    ctx.clearRect(0, 0, width, height);

    // Compute peak bandwidth for auto-scaling
    let maxVal = 1024; // 1 KB/s minimum scale floor
    for (let i = 0; i < this.SPARKLINE_POINTS; i++) {
      if (this.rxHistory[i] > maxVal) maxVal = this.rxHistory[i];
      if (this.txHistory[i] > maxVal) maxVal = this.txHistory[i];
    }

    // Colors follow the live theme: RX is the text color, TX a dimmed copy of it.
    const css = (typeof getComputedStyle === 'function' && typeof document !== 'undefined' && document.documentElement)
      ? getComputedStyle(document.documentElement)
      : null;
    const readVar = (name, fallback) => (css && String(css.getPropertyValue(name) || '').trim()) || fallback;
    const fg = readVar('--fg', '#ffffff');
    const fgRgb = readVar('--fg-rgb', '255, 255, 255');

    // Grid baseline
    ctx.strokeStyle = `rgba(${fgRgb}, 0.18)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height - 1);
    ctx.lineTo(width, height - 1);
    ctx.stroke();

    const step = width / (this.SPARKLINE_POINTS - 1);

    // Draw RX Curve (solid text color)
    ctx.strokeStyle = fg;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < this.SPARKLINE_POINTS; i++) {
      const x = i * step;
      const y = height - (this.rxHistory[i] / maxVal) * (height - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw TX Curve (dashed, dimmed text color)
    ctx.strokeStyle = `rgba(${fgRgb}, 0.55)`;
    ctx.lineWidth = 1.2;
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (let i = 0; i < this.SPARKLINE_POINTS; i++) {
      const x = i * step;
      const y = height - (this.txHistory[i] / maxVal) * (height - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
  }

  /**
   * Format bytes/sec to human readable string (B/s, KB/s, MB/s).
   * @private
   */
  _formatRate(bytes) {
    if (bytes < 1024) return `${bytes} B/s`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB/s`;
    return `${(bytes / 1048576).toFixed(2)} MB/s`;
  }

  /**
   * Teardown and detach IPC listener.
   */
  destroy() {
    this.stopLiveClock();
    if (typeof this.unsubscribeTelemetry === 'function') {
      this.unsubscribeTelemetry();
      this.unsubscribeTelemetry = null;
    }
  }
}

// Attach to window or CommonJS
if (typeof window !== 'undefined') {
  window.TelemetryView = TelemetryView;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TelemetryView;
}
