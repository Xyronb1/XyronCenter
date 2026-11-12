/**
 * XYRON CENTER - Windows Process Monitor & Live Hex Diagnostic View
 * File: src/renderer/js/process-view.js
 * 
 * Manages real-time OS process enumeration, search filtering, RAM/PID/Name sorting,
 * process tree termination API invocation, and live Windows CNG entropy hex matrix.
 */

class ProcessView {
  constructor() {
    this.processes = [];
    this.selectedPid = null;
    this.selectedName = null;
    this.currentSort = 'mem'; // 'mem' | 'pid' | 'name'
    this.filterQuery = '';

    this.dom = {
      totalCount: document.getElementById('proc-total-count'),
      searchInput: document.getElementById('proc-search-input'),
      sortButtons: (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') 
        ? document.querySelectorAll('.process-sort-bar .sort-btn') 
        : [],
      tableBody: document.getElementById('proc-table-body'),
      selectedInfo: document.getElementById('selected-proc-info'),
      btnKill: document.getElementById('btn-kill-process'),
      toast: document.getElementById('proc-toast'),
      hexDisplay: document.getElementById('hex-matrix-display')
    };

    this.toastTimer = null;
  }

  /**
   * Initializes user interactions and event bindings.
   */
  init() {
    // 1. Search Filter Input
    if (this.dom.searchInput) {
      this.dom.searchInput.addEventListener('input', (e) => {
        this.filterQuery = (e.target.value || '').trim().toLowerCase();
        this.renderTable();
      });
    }

    // 2. Sort Button Toggles
    if (this.dom.sortButtons) {
      this.dom.sortButtons.forEach(btn => {
        btn.addEventListener('click', () => {
          this.dom.sortButtons.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.currentSort = btn.getAttribute('data-sort') || 'mem';
          this.renderTable();
        });
      });
    }

    // 3. Terminate Process Button
    if (this.dom.btnKill) {
      this.dom.btnKill.addEventListener('click', () => {
        this.killSelectedProcess();
      });
    }
  }

  /**
   * Updates process monitor and hex matrix from incoming live telemetry.
   * @param {Object} telemetry - SystemTelemetry object
   */
  update(telemetry) {
    if (!telemetry || typeof telemetry !== 'object') return;

    // 1. Process List
    if (Array.isArray(telemetry.processes)) {
      this.processes = telemetry.processes;
      if (this.dom.totalCount) {
        this.dom.totalCount.textContent = `${this.processes.length} PROCS`;
      }
      this.renderTable();
    }

    // 2. Windows CNG Hardware Entropy Hex Diagnostic Matrix
    if (this.dom.hexDisplay) {
      if (Array.isArray(telemetry.hexMatrix) && telemetry.hexMatrix.length > 0) {
        const lines = telemetry.hexMatrix.slice(0, 7).map(r => r.raw || `${r.offset}:  ${r.hexBytes}  |${r.ascii}|`);
        this.dom.hexDisplay.textContent = lines.join('\n');
      } else if (telemetry.diagnosticHexStream) {
        const stream = telemetry.diagnosticHexStream;
        this.dom.hexDisplay.textContent = `${stream.offset}:  ${stream.hexBytes}  |${stream.ascii}|`;
      }
    }
  }

  /**
   * Renders the process table with current filter and sort mode.
   */
  renderTable() {
    if (!this.dom.tableBody) return;

    // Filter processes
    let filtered = this.processes;
    if (this.filterQuery) {
      filtered = this.processes.filter(p => {
        const nameMatch = p.name && p.name.toLowerCase().includes(this.filterQuery);
        const pidMatch = String(p.pid).includes(this.filterQuery);
        return nameMatch || pidMatch;
      });
    }

    // Sort processes
    filtered.sort((a, b) => {
      if (this.currentSort === 'mem') {
        const memA = typeof a.memBytes === 'number' ? a.memBytes : 0;
        const memB = typeof b.memBytes === 'number' ? b.memBytes : 0;
        return memB - memA;
      }
      if (this.currentSort === 'pid') {
        return (a.pid || 0) - (b.pid || 0);
      }
      if (this.currentSort === 'name') {
        return String(a.name || '').localeCompare(String(b.name || ''));
      }
      return 0;
    });

    // Render top 80 processes to maintain 60 FPS
    const slice = filtered.slice(0, 80);
    const fragment = document.createDocumentFragment();

    slice.forEach(proc => {
      const tr = document.createElement('tr');
      if (this.selectedPid === proc.pid) {
        tr.classList.add('selected');
      }

      tr.addEventListener('click', () => {
        this.selectProcess(proc.pid, proc.name);
      });

      // PID Column
      const tdPid = document.createElement('td');
      tdPid.className = 'col-pid';
      tdPid.textContent = proc.pid;

      // Name Column
      const tdName = document.createElement('td');
      tdName.className = 'col-name';
      tdName.textContent = proc.name;
      tdName.title = proc.name;

      // Memory Column
      const tdMem = document.createElement('td');
      tdMem.className = 'col-mem';
      tdMem.textContent = proc.memUsage || `${(proc.memBytes / 1024).toFixed(0)} K`;

      tr.appendChild(tdPid);
      tr.appendChild(tdName);
      tr.appendChild(tdMem);
      fragment.appendChild(tr);
    });

    this.dom.tableBody.innerHTML = '';
    this.dom.tableBody.appendChild(fragment);
  }

  /**
   * Sets active selected process.
   * @param {number} pid
   * @param {string} name
   */
  selectProcess(pid, name) {
    this.selectedPid = pid;
    this.selectedName = name;

    if (this.dom.selectedInfo) {
      this.dom.selectedInfo.textContent = `SELECTED: [PID ${pid}] ${name}`;
    }

    if (this.dom.btnKill) {
      this.dom.btnKill.disabled = false;
    }

    this.renderTable();
  }

  /**
   * Clear active selection.
   */
  clearSelection() {
    this.selectedPid = null;
    this.selectedName = null;

    if (this.dom.selectedInfo) {
      this.dom.selectedInfo.textContent = 'NO PROCESS SELECTED';
    }

    if (this.dom.btnKill) {
      this.dom.btnKill.disabled = true;
    }

    this.renderTable();
  }

  /**
   * Terminate selected process via Win32 process tree kill API.
   */
  async killSelectedProcess() {
    if (!this.selectedPid) return;

    const targetPid = this.selectedPid;
    const targetName = this.selectedName;

    // Safety guard against kernel structures
    if (targetPid === 0 || targetPid === 4) {
      this.showToast(`Protected Windows Kernel process (PID ${targetPid}) cannot be terminated.`, 'error');
      return;
    }

    if (!window.processApi || typeof window.processApi.kill !== 'function') {
      this.showToast('Process API unavailable in current context.', 'error');
      return;
    }

    try {
      if (this.dom.btnKill) this.dom.btnKill.disabled = true;
      const res = await window.processApi.kill(targetPid);

      if (res && res.success) {
        this.showToast(`[OK] Terminated ${targetName} (PID ${targetPid})`, 'success');
        this.clearSelection();
      } else {
        const msg = (res && res.message) ? res.message : 'Termination failed';
        this.showToast(`[ERR] ${msg}`, 'error');
      }
    } catch (err) {
      this.showToast(`[ERR] ${err.message}`, 'error');
    } finally {
      if (this.selectedPid && this.dom.btnKill) {
        this.dom.btnKill.disabled = false;
      }
    }
  }

  /**
   * Show feedback toast banner.
   * @param {string} msg
   * @param {'success'|'error'} type
   */
  showToast(msg, type = 'success') {
    if (!this.dom.toast) return;

    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
    }

    this.dom.toast.textContent = msg;
    this.dom.toast.className = `proc-toast ${type}`;

    this.toastTimer = setTimeout(() => {
      if (this.dom.toast) {
        this.dom.toast.className = 'proc-toast hidden';
      }
    }, 3500);
  }
}

// Attach to window or CommonJS
if (typeof window !== 'undefined') {
  window.ProcessView = ProcessView;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ProcessView;
}
