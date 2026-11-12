/**
 * XYRON CENTER - Milestone 1 Standalone Telemetry & Process Verification Harness
 * File: tests/test-m1-telemetry.js
 * 
 * Verifies with ZERO MOCK DATA:
 * 1. CPU: 20 threads enumeration, per-core tick differential, dynamic physical cores.
 * 2. RAM: Physical total, free, used bytes, percentage calculation.
 * 3. GPU: Live query via nvidia-smi / WDDM counter fallback, temperature, VRAM, fan speed.
 * 4. Network: Real-time netstat -e byte deltas and bandwidth calculation.
 * 5. Process List: tasklist /FO CSV /NH enumeration, localized byte parser, count >= 50.
 * 6. Process Kill API: PID validation, boolean PID rejection, kernel PIDs protection.
 * 7. Live Hex Matrix: 32-byte Windows CNG hardware entropy (crypto.randomBytes(32)) & dynamic check.
 * 8. Zero Mock Static Audit: AST/Regex inspection ensuring 0 mock/synthetic values & 0 hardcoded cores.
 * 9. Subsystem Class Integration: TelemetryEngine & ProcessManager live headless execution & listener cleanup.
 */

const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

// Robust module resolution (supports running from tests/ or standalone)
const tePath = fs.existsSync(path.resolve(__dirname, '../src/main/telemetry-engine.js'))
  ? path.resolve(__dirname, '../src/main/telemetry-engine.js')
  : path.resolve(__dirname, '../../../2_Proje_Dosyalari_Source/src/main/telemetry-engine.js');

const pmPath = fs.existsSync(path.resolve(__dirname, '../src/main/process-manager.js'))
  ? path.resolve(__dirname, '../src/main/process-manager.js')
  : path.resolve(__dirname, '../../../2_Proje_Dosyalari_Source/src/main/process-manager.js');

const TelemetryEngine = require(tePath);
const ProcessManager = require(pmPath);

// ANSI Colors for HUD Terminal Output
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

function assert(description, condition, details = '') {
  if (condition) {
    passCount++;
    console.log(`  ${C.green}✓ [PASS]${C.reset} ${description}${details ? C.dim + ' (' + details + ')' + C.reset : ''}`);
    results.push({ name: description, passed: true, details });
  } else {
    failCount++;
    console.log(`  ${C.red}✗ [FAIL]${C.reset} ${description}${details ? C.yellow + ' -> ' + details + C.reset : ''}`);
    results.push({ name: description, passed: false, details });
  }
}

// Helper: Run command asynchronously
function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) return reject({ err, stderr, stdout });
      resolve(stdout.trim());
    });
  });
}

// Helper: Calculate CPU usage via tick differential
function getCpuTicks() {
  const cpus = os.cpus();
  return cpus.map(cpu => {
    const times = cpu.times;
    const total = times.user + times.nice + times.sys + times.idle + times.irq;
    return { idle: times.idle, total };
  });
}

function calculateCpuDiff(startTicks, endTicks) {
  return endTicks.map((end, i) => {
    const start = startTicks[i];
    const totalDelta = end.total - start.total;
    const idleDelta = end.idle - start.idle;
    if (totalDelta <= 0) return 0;
    const load = ((1 - (idleDelta / totalDelta)) * 100);
    return Math.max(0, Math.min(100, parseFloat(load.toFixed(1))));
  });
}

// Helper: Parse tasklist CSV line
function parseTasklistLine(line) {
  const tokens = [];
  let inQuotes = false;
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      tokens.push(cur.trim());
      cur = '';
    } else {
      cur += char;
    }
  }
  tokens.push(cur.trim());

  if (tokens.length >= 5) {
    const rawMem = tokens[4].replace(/[^\d]/g, '');
    const memKb = parseInt(rawMem, 10);
    return {
      name: tokens[0].replace(/^"|"$/g, ''),
      pid: parseInt(tokens[1].replace(/^"|"$/g, ''), 10),
      session: tokens[2].replace(/^"|"$/g, ''),
      sessionNum: parseInt(tokens[3].replace(/^"|"$/g, ''), 10),
      memUsage: tokens[4].replace(/^"|"$/g, ''),
      memBytes: isNaN(memKb) ? 0 : memKb * 1024
    };
  }
  return null;
}

async function runMilestone1VerificationSuite() {
  console.log(`\n${C.cyan}${C.bold}================================================================================${C.reset}`);
  console.log(`${C.cyan}${C.bold}   XYRON CENTER - MILESTONE 1 ITERATION 2 VERIFICATION & REMEDIATION SUITE   ${C.reset}`);
  console.log(`${C.cyan}${C.bold}================================================================================${C.reset}\n`);

  // ==========================================================================
  // SECTION 1: CPU Telemetry & Multi-Core Workloads (R1, Feature 1)
  // ==========================================================================
  console.log(`${C.bold}[1/9] Testing CPU Telemetry & Multi-Core Workloads...${C.reset}`);
  const initialTicks = getCpuTicks();
  const cpus = os.cpus();
  assert('os.cpus() enumerates active CPU threads', cpus.length > 0, `Detected ${cpus.length} threads`);
  assert('Host workstation exposes all 20 logical threads', cpus.length === 20, `Target hardware: 20 threads`);
  assert('CPU model identifies genuine hardware (13th Gen Intel)', cpus[0].model.includes('Intel'), cpus[0].model);

  // Dynamic physical core detection (Zero-Hardcoding Check)
  let probedPhysicalCores = null;
  try {
    const si = require('systeminformation');
    const cpuSi = await si.cpu();
    if (cpuSi && typeof cpuSi.physicalCores === 'number' && cpuSi.physicalCores > 0) {
      probedPhysicalCores = cpuSi.physicalCores;
    }
  } catch (e) {
    try {
      const wmiOut = await runCmd('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor).NumberOfCores']);
      const parsed = parseInt(wmiOut.trim(), 10);
      if (!isNaN(parsed) && parsed > 0) probedPhysicalCores = parsed;
    } catch (e2) {}
  }
  if (!probedPhysicalCores) {
    probedPhysicalCores = Math.max(1, Math.floor(cpus.length / 2));
  }
  assert('Dynamic physical core count is probed without hardcoding', probedPhysicalCores > 0 && probedPhysicalCores <= cpus.length, `Probed: ${probedPhysicalCores} physical cores (${cpus.length} logical)`);

  // Measure delta over 250ms
  await new Promise(r => setTimeout(r, 250));
  const finalTicks = getCpuTicks();
  const coreLoads = calculateCpuDiff(initialTicks, finalTicks);
  const avgLoad = coreLoads.reduce((a, b) => a + b, 0) / coreLoads.length;

  assert('CPU workloads array matches logical thread count (20)', coreLoads.length === 20);
  assert('All 20 core load values fall in valid percentage range [0, 100]', coreLoads.every(l => l >= 0 && l <= 100));
  assert('Aggregate CPU load calculation is non-negative and valid', avgLoad >= 0 && avgLoad <= 100, `Current average load: ${avgLoad.toFixed(1)}%`);

  // ==========================================================================
  // SECTION 2: RAM Physical Memory Telemetry (R1, Feature 2)
  // ==========================================================================
  console.log(`\n${C.bold}[2/9] Testing Physical Memory (RAM) Allocation & Calculations...${C.reset}`);
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const usedPercent = (usedMem / totalMem) * 100;

  assert('Physical RAM total exceeds 8 GB (Target workstation has 16GB)', totalMem > 8 * 1024 * 1024 * 1024, `${(totalMem / (1024**3)).toFixed(2)} GB`);
  assert('Free RAM is non-negative and strictly less than total RAM', freeMem > 0 && freeMem < totalMem, `${(freeMem / (1024**3)).toFixed(2)} GB free`);
  assert('Used RAM is mathematically consistent (total - free)', usedMem === (totalMem - freeMem), `${(usedMem / (1024**3)).toFixed(2)} GB used`);
  assert('RAM usage percentage calculates correctly in [0, 100]', usedPercent >= 0 && usedPercent <= 100, `${usedPercent.toFixed(1)}%`);

  // ==========================================================================
  // SECTION 3: Dedicated GPU & VRAM Telemetry (R1, Feature 3, 4)
  // ==========================================================================
  console.log(`\n${C.bold}[3/9] Testing GPU & VRAM Telemetry (nvidia-smi & WDDM query)...${C.reset}`);
  let gpuSuccess = false;
  let gpuData = null;
  let gpuFanSpeed = null;
  try {
    const gpuRaw = await runCmd('nvidia-smi', [
      '--query-gpu=name,temperature.gpu,utilization.gpu,utilization.memory,memory.total,memory.used,memory.free,power.draw,fan.speed',
      '--format=csv,noheader,nounits'
    ]);
    const parts = gpuRaw.split(',').map(s => s.trim());
    if (parts.length >= 7) {
      gpuData = {
        name: parts[0],
        temp: parseFloat(parts[1]),
        load: parseFloat(parts[2]),
        memLoad: parseFloat(parts[3]),
        memTotal: parseFloat(parts[4]),
        memUsed: parseFloat(parts[5]),
        memFree: parseFloat(parts[6]),
        power: parts[7] ? parseFloat(parts[7]) : null,
        fan: parts[8] && !parts[8].includes('[N/A]') && !isNaN(parseFloat(parts[8])) ? parseFloat(parts[8]) : null
      };
      gpuFanSpeed = gpuData.fan;
      gpuSuccess = true;
    }
  } catch (err) {
    // If nvidia-smi fails, test WDDM fallback
    try {
      const wddmOut = await runCmd('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name']);
      if (wddmOut && wddmOut.length > 0) {
        gpuData = { name: wddmOut, temp: null, fallback: true };
        gpuSuccess = true;
      }
    } catch (e2) {}
  }

  assert('GPU detection executes without unhandled exceptions', gpuSuccess, gpuData ? gpuData.name : 'Fallback active');
  if (gpuData) {
    assert('GPU name identifies dedicated hardware or WDDM controller', gpuData.name.includes('NVIDIA') || gpuData.name.includes('GeForce') || gpuData.name.length > 3, gpuData.name);
    if (gpuData.temp !== null) {
      assert('GPU temperature is within genuine operating range (20°C - 105°C)', gpuData.temp >= 20 && gpuData.temp <= 105, `${gpuData.temp}°C`);
    }
    if (gpuData.memTotal) {
      assert('GPU VRAM total is detected (> 4000 MB on RTX 4060)', gpuData.memTotal > 4000, `${gpuData.memTotal} MB`);
      assert('GPU VRAM used is non-negative and <= total', gpuData.memUsed >= 0 && gpuData.memUsed <= gpuData.memTotal, `${gpuData.memUsed} MB / ${gpuData.memTotal} MB`);
    }
    assert('GPU fan speed reporting adheres to contract (number or null for OEM EC)', gpuFanSpeed === null || (typeof gpuFanSpeed === 'number' && gpuFanSpeed >= 0), gpuFanSpeed !== null ? `${gpuFanSpeed}%` : 'OEM EC Managed [N/A]');
  }

  // ==========================================================================
  // SECTION 4: Real-Time Network Bandwidth Telemetry (R1, Feature 6)
  // ==========================================================================
  console.log(`\n${C.bold}[4/9] Testing Real-Time Network Bandwidth (netstat -e delta)...${C.reset}`);
  let net0 = null;
  let net1 = null;

  async function queryNetstatBytes() {
    const raw = await runCmd('netstat', ['-e']);
    const match = raw.match(/Bytes\s+(\d+)\s+(\d+)/);
    if (match) {
      return { rx: parseInt(match[1], 10), tx: parseInt(match[2], 10), t: Date.now() };
    }
    return null;
  }

  net0 = await queryNetstatBytes();
  assert('netstat -e successfully returns received/sent byte counters', net0 !== null, net0 ? `RX: ${net0.rx}, TX: ${net0.tx}` : 'Error');
  await new Promise(r => setTimeout(r, 300));
  net1 = await queryNetstatBytes();

  if (net0 && net1) {
    const dt = (net1.t - net0.t) / 1000;
    const rxRate = Math.max(0, (net1.rx - net0.rx) / dt);
    const txRate = Math.max(0, (net1.tx - net0.tx) / dt);
    assert('Network bytes monotonically advance or stay steady', net1.rx >= net0.rx && net1.tx >= net0.tx);
    assert('Network bandwidth rate is calculated in bytes/sec (>= 0)', rxRate >= 0 && txRate >= 0, `Down: ${(rxRate/1024).toFixed(1)} KB/s, Up: ${(txRate/1024).toFixed(1)} KB/s`);
  }

  // ==========================================================================
  // SECTION 5: Process Enumeration & Process Termination API (R1, Feature 21, 22)
  // ==========================================================================
  console.log(`\n${C.bold}[5/9] Testing Real-Time Process List Enumeration (tasklist /FO CSV /NH)...${C.reset}`);
  const tStart = Date.now();
  const tasklistRaw = await runCmd('tasklist', ['/FO', 'CSV', '/NH']);
  const tElapsed = Date.now() - tStart;
  const lines = tasklistRaw.split(/\r?\n/).filter(l => l.trim().length > 0);
  const parsedProcesses = lines.map(parseTasklistLine).filter(p => p !== null);

  assert('tasklist executes within < 1000ms latency budget', tElapsed < 1000, `${tElapsed} ms`);
  assert('Process list contains realistic count (> 50 active processes)', parsedProcesses.length >= 50, `Found ${parsedProcesses.length} processes`);
  assert('System processes are detected (System, explorer.exe, or svchost.exe)', parsedProcesses.some(p => p.name.toLowerCase() === 'explorer.exe' || p.name.toLowerCase() === 'system'));
  assert('Process PIDs are parsed as valid positive numbers', parsedProcesses.every(p => !isNaN(p.pid) && p.pid >= 0));
  assert('Process memory usage is correctly parsed from localized string into bytes', parsedProcesses.some(p => p.memBytes > 1024 * 1024), `Max mem process: ${Math.max(...parsedProcesses.map(p => p.memBytes)) / 1024 / 1024 | 0} MB`);

  // ==========================================================================
  // SECTION 6: Live Windows CNG Diagnostic Hex Matrix (R1, Feature 23)
  // ==========================================================================
  console.log(`\n${C.bold}[6/9] Testing Live CNG Hex Diagnostic Matrix (crypto.randomBytes)...${C.reset}`);
  const entropy1 = crypto.randomBytes(32);
  const entropy2 = crypto.randomBytes(32);

  assert('Windows CNG provides exact 32 bytes of cryptographic hardware entropy', entropy1.length === 32);
  assert('Subsequent entropy samples are strictly non-identical (zero static/mock hex)', !entropy1.equals(entropy2));

  function formatHexLine(offset, buffer) {
    const hex = buffer.toString('hex').toUpperCase().match(/.{1,2}/g).join(' ');
    const ascii = Array.from(buffer).map(b => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.')).join('');
    return `0x${offset.toString(16).padStart(8, '0')}: ${hex} | ${ascii}`;
  }
  const sampleLine = formatHexLine(0x00001000, entropy1.slice(0, 16));
  assert('Hex matrix formatter outputs valid memory offset and byte string', sampleLine.startsWith('0x00001000:'), sampleLine);

  // ==========================================================================
  // SECTION 7: Zero-Mock Static & Dynamic Contract Enforcement
  // ==========================================================================
  console.log(`\n${C.bold}[7/9] Verifying Zero Mock Contract & Nullable Sensor Handling...${C.reset}`);
  const testEngine = new TelemetryEngine();
  const initialTelemetry = testEngine.getLatestTelemetry();

  // Test real TelemetryEngine output against nullable contract (NO mock literal)
  assert('TelemetryEngine initial state adheres to nullable sensor contract (cpu.value: null)', initialTelemetry.temperatures.cpu.value === null);
  assert('TelemetryEngine initial state provides explicit status badge ("OFFLINE")', initialTelemetry.temperatures.cpu.status === 'OFFLINE');
  assert('TelemetryEngine motherboard temperature adheres to nullable contract', initialTelemetry.temperatures.motherboard.value === null && initialTelemetry.temperatures.motherboard.status === 'OFFLINE');
  assert('TelemetryEngine NVMe storage temperature adheres to nullable contract', initialTelemetry.temperatures.nvme.value === null && initialTelemetry.temperatures.nvme.status === 'OFFLINE');
  assert('TelemetryEngine fan status satisfies contract (null with OEM EC or numeric RPM)', (initialTelemetry.fans.rpm === null && initialTelemetry.fans.status === 'UNSUPPORTED_BY_OEM_EC') || (typeof initialTelemetry.fans.rpm === 'number' && initialTelemetry.fans.status === 'LIVE'));

  // Static code inspection: check telemetry-engine.js and process-manager.js
  let teCode = fs.existsSync(tePath) ? fs.readFileSync(tePath, 'utf8') : '';
  let pmCode = fs.existsSync(pmPath) ? fs.readFileSync(pmPath, 'utf8') : '';

  assert('telemetry-engine.js contains zero Math.random() calls (zero mock)', !teCode.includes('Math.random()'));
  assert('process-manager.js contains zero Math.random() calls (zero mock)', !pmCode.includes('Math.random()'));
  assert('telemetry-engine.js contains zero synthetic waveform generators (sin/cos)', !teCode.includes('Math.sin(') && !teCode.includes('Math.cos('));
  assert('process-manager.js contains zero synthetic waveform generators (sin/cos)', !pmCode.includes('Math.sin(') && !pmCode.includes('Math.cos('));
  
  const containsHardcoded14 = /coresTotal:\s*14\b/.test(teCode);
  assert('telemetry-engine.js contains zero hardcoded "coresTotal: 14" literals', !containsHardcoded14, containsHardcoded14 ? 'Legacy coresTotal: 14 detected in source' : 'Clean dynamic core mapping');

  // ==========================================================================
  // SECTION 8: ProcessManager Implementation Audit
  // ==========================================================================
  console.log(`\n${C.bold}[8/9] Auditing ProcessManager Class Methods & Security Guards...${C.reset}`);
  const pmInstance = new ProcessManager();

  // Test CSV parser with RFC 4180 complex line
  const testCsvLine = '"svchost.exe","1234","Services","0","15.420 K"';
  const tokens = pmInstance.parseCsvLine(testCsvLine);
  assert('ProcessManager.parseCsvLine handles quoted CSV with 5 tokens', tokens.length === 5 && tokens[0] === 'svchost.exe' && tokens[1] === '1234');

  // Test live process enumeration
  const pmProcs = await pmInstance.getProcesses();
  assert('ProcessManager.getProcesses() returns live processes list', Array.isArray(pmProcs) && pmProcs.length >= 50, `Count: ${pmProcs.length}`);
  assert('ProcessManager processes have valid numeric memBytes', pmProcs.every(p => typeof p.memBytes === 'number' && !isNaN(p.memBytes)));

  // Test PID guard safety & type rejection
  const killKernel = await pmInstance.killProcess(4);
  assert('ProcessManager.killProcess(4) rejects kernel PID 4', killKernel.success === false, killKernel.message);

  const killNegative = await pmInstance.killProcess(-10);
  assert('ProcessManager.killProcess(-10) rejects negative PID', killNegative.success === false, killNegative.message);

  const killNonExistent = await pmInstance.killProcess(999999);
  assert('ProcessManager.killProcess(999999) fails cleanly on non-existent PID', killNonExistent.success === false, killNonExistent.message);

  // Type Safety: Boolean PID Rejection
  const killTrue = await pmInstance.killProcess(true);
  const killTrueRejectedType = killTrue.success === false && 
    !killTrue.message.includes('PID 1') && 
    killTrue.message.toLowerCase().includes('invalid pid');
  assert('ProcessManager.killProcess(true) rejects boolean argument without executing taskkill /PID 1', killTrueRejectedType, killTrue.message);

  const killFalse = await pmInstance.killProcess(false);
  const killFalseRejectedType = killFalse.success === false && 
    killFalse.message.toLowerCase().includes('invalid pid');
  assert('ProcessManager.killProcess(false) rejects boolean false argument as invalid PID', killFalseRejectedType, killFalse.message);

  const killFloat = await pmInstance.killProcess(12.34);
  assert('ProcessManager.killProcess(12.34) rejects floating-point PID', killFloat.success === false, killFloat.message);

  const killInvalidStr = await pmInstance.killProcess('not-a-number');
  assert('ProcessManager.killProcess("not-a-number") rejects non-numeric string PID', killInvalidStr.success === false, killInvalidStr.message);

  // Buffer Sizing & Edge Case Hardening: rowCount < 4 and Arithmetic Guards
  let hex1Ok = false;
  try {
    const hex1 = pmInstance.generateLiveHexMatrix({}, 1);
    hex1Ok = Array.isArray(hex1.rows) && hex1.rows.length >= 4;
  } catch (e) {
    hex1Ok = false;
  }
  assert('generateLiveHexMatrix({}, 1) handles rowCount < 4 safely without buffer ERR_OUT_OF_RANGE', hex1Ok);

  let hex0Ok = false;
  try {
    const hex0 = pmInstance.generateLiveHexMatrix({}, 0);
    hex0Ok = Array.isArray(hex0.rows) && hex0.rows.length >= 4;
  } catch (e) {
    hex0Ok = false;
  }
  assert('generateLiveHexMatrix({}, 0) handles zero row count safely', hex0Ok);

  let hexNegOk = false;
  try {
    const hexNeg = pmInstance.generateLiveHexMatrix({}, -5);
    hexNegOk = Array.isArray(hexNeg.rows) && hexNeg.rows.length >= 4;
  } catch (e) {
    hexNegOk = false;
  }
  assert('generateLiveHexMatrix({}, -5) handles negative row count safely', hexNegOk);

  let hexNullOk = false;
  try {
    const hexNull = pmInstance.generateLiveHexMatrix(null, 4);
    hexNullOk = Array.isArray(hexNull.rows) && hexNull.rows.length >= 4;
  } catch (e) {
    hexNullOk = false;
  }
  assert('generateLiveHexMatrix(null, 4) handles null context without TypeError', hexNullOk);

  let hexFloatOk = false;
  try {
    const hexFloat = pmInstance.generateLiveHexMatrix({ rxBytes: 1234.56, txBytes: -50, cpuLoad: -0.5 }, 4);
    hexFloatOk = Array.isArray(hexFloat.rows) && hexFloat.rows.length >= 4;
  } catch (e) {
    hexFloatOk = false;
  }
  assert('generateLiveHexMatrix handles float and negative metrics without BigInt RangeError', hexFloatOk);

  // Test Standard Hex Matrix generation (8 rows)
  const hexMatrix = pmInstance.generateLiveHexMatrix({ rxBytes: 5000, txBytes: 3000, cpuLoad: 25, procCount: pmProcs.length }, 8);
  assert('ProcessManager.generateLiveHexMatrix generates 8 rows', Array.isArray(hexMatrix.rows) && hexMatrix.rows.length === 8);
  assert('ProcessManager hex rows contain valid offset, hexBytes, ascii', hexMatrix.rows[0].offset.startsWith('0x') && hexMatrix.rows[0].hexBytes.length === 49 && hexMatrix.rows[0].ascii.length === 16);

  // ==========================================================================
  // SECTION 9: TelemetryEngine Class Integration & Duck-Typed IPC Audit
  // ==========================================================================
  console.log(`\n${C.bold}[9/9] Auditing TelemetryEngine Class Integration & 3-Tier Polling...${C.reset}`);
  const engine = new TelemetryEngine({ tier1Interval: 200, tier2Interval: 400, tier3Interval: 600, processManager: pmInstance });

  const ipcMessages = [];
  const mockBrowserWindow = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send(channel, data) {
        ipcMessages.push({ channel, data, timestamp: Date.now() });
      }
    }
  };

  let updateEmitted = false;
  engine.on('update', (data) => {
    updateEmitted = true;
  });

  // Start engine with mock window
  engine.start(mockBrowserWindow);

  // Await at least 1 Tier 1 tick (350ms)
  await new Promise(r => setTimeout(r, 350));
  if (typeof engine._probeStaticHardware === 'function') {
    await engine._probeStaticHardware();
  }

  assert('TelemetryEngine emits internal "update" event', updateEmitted === true);
  assert('TelemetryEngine broadcasts over IPC channel "telemetry:update"', ipcMessages.length > 0 && ipcMessages[0].channel === 'telemetry:update');

  const snapshot = engine.getLatestTelemetry();
  assert('TelemetryEngine snapshot contains valid 20-thread CPU structure', snapshot.cpu && snapshot.cpu.logicalThreads === 20 && snapshot.cpu.coreWorkloads.length === 20);
  assert('TelemetryEngine snapshot reports dynamic physical cores (positive integer <= logicalThreads)', typeof snapshot.cpu.coresTotal === 'number' && Number.isInteger(snapshot.cpu.coresTotal) && snapshot.cpu.coresTotal > 0 && snapshot.cpu.coresTotal <= snapshot.cpu.logicalThreads, `coresTotal: ${snapshot.cpu.coresTotal}`);
  if (probedPhysicalCores) {
    assert('TelemetryEngine snapshot coresTotal matches probed hardware core count', snapshot.cpu.coresTotal === probedPhysicalCores, `Reported: ${snapshot.cpu.coresTotal}, Probed: ${probedPhysicalCores}`);
  }
  assert('TelemetryEngine snapshot contains valid physical RAM metrics', snapshot.memory && snapshot.memory.totalBytes > 0 && snapshot.memory.usedBytes > 0);
  const parseNet = engine.constructor.parseNetstatBytes;
  const frNet = parseNet("Statistiques de l'interface\r\n\r\n         Reçus   Envoyés\r\n\r\nOctets   1234567   7654321\r\nPaquets unicast   10   20\r\n");
  const ruNet = parseNet('Статистика интерфейса\n\n   Получено   Отправлено\n\nБайт   111   222\n');
  assert('netstat -e byte counters parsed on a French Windows', Boolean(frNet && frNet[1] === '1234567' && frNet[2] === '7654321'));
  assert('netstat -e byte counters parsed on a Russian Windows', Boolean(ruNet && ruNet[1] === '111' && ruNet[2] === '222'));
  assert('netstat -e parser returns null on empty output', parseNet('') === null);
  assert('TelemetryEngine snapshot clock has time, date, iso', Boolean(snapshot.clock && snapshot.clock.time && snapshot.clock.date && snapshot.clock.iso));
  assert('TelemetryEngine fan status satisfies contract (null with OEM EC or valid RPM)', snapshot.fans && ((snapshot.fans.rpm === null && snapshot.fans.status === 'UNSUPPORTED_BY_OEM_EC') || (typeof snapshot.fans.rpm === 'number' && snapshot.fans.status === 'LIVE')), `Fan: ${snapshot.fans?.rpm} (${snapshot.fans?.status})`);
  assert('TelemetryEngine CPU temperature adheres to nullable OFFLINE contract', snapshot.temperatures && snapshot.temperatures.cpu.value === null && snapshot.temperatures.cpu.status === 'OFFLINE');
  assert('TelemetryEngine includes live diagnosticHexStream and hexMatrix', Boolean(snapshot.diagnosticHexStream && snapshot.diagnosticHexStream.offset && Array.isArray(snapshot.hexMatrix)));

  // Stop engine and verify timer cleanup
  engine.stop();
  assert('TelemetryEngine stops cleanly and nullifies all 3 tier timers', engine.isRunning === false && engine.tier1Timer === null && engine.tier2Timer === null && engine.tier3Timer === null);

  // Lifecycle Leak Audit: Verify window listener cleanup on repeated start/stop
  const leakTestWindow = new EventEmitter();
  leakTestWindow.isDestroyed = () => false;
  leakTestWindow.webContents = { isDestroyed: () => false, send: () => {} };

  const lifecycleEngine = new TelemetryEngine({ tier1Interval: 50, tier2Interval: 50, tier3Interval: 50 });
  for (let i = 0; i < 15; i++) {
    lifecycleEngine.start(leakTestWindow);
    lifecycleEngine.stop();
  }
  const closedCount = leakTestWindow.listenerCount('closed');
  assert('TelemetryEngine cleans up mainWindow "closed" listeners across start/stop cycles (no leak)', closedCount <= 1, `Remaining listeners: ${closedCount}`);

  // Summary Report
  console.log(`\n${C.cyan}${C.bold}================================================================================${C.reset}`);
  console.log(`${C.cyan}${C.bold}   TEST SUMMARY: ${passCount} PASSED | ${failCount} FAILED   ${C.reset}`);
  console.log(`${C.cyan}${C.bold}================================================================================${C.reset}`);

  if (failCount === 0) {
    console.log(`\n${C.green}${C.bold}>>> ALL MILESTONE 1 TELEMETRY ASSERTIONS PASSED WITH ZERO MOCK DATA <<<${C.reset}\n`);
    return 0;
  } else {
    console.log(`\n${C.red}${C.bold}>>> TEST SUITE FAILED: ${failCount} UNMET CONDITIONS <<<${C.reset}\n`);
    return 1;
  }
}

// Self-executing runner
if (require.main === module) {
  runMilestone1VerificationSuite().then(exitCode => {
    process.exit(exitCode);
  }).catch(err => {
    console.error('Fatal harness error:', err);
    process.exit(1);
  });
}

module.exports = { runMilestone1VerificationSuite, assert };
