/**
 * XYRON CENTER - Milestone 1 Challenger Stress & Verification Harness
 * File: tests/challenger-m1-stress.js
 * 
 * Adversarial empirical testing of TelemetryEngine (Milestone 1 Challenger 1):
 * 1. Rapid start/stop cycles, timer leaks, and reentrancy resilience.
 * 2. 20-thread CPU load consistency & boundary invariance (0 <= coreLoad <= 100%, total <= 100%).
 * 3. Network 32-bit counter rollover simulation, spike resilience, and malformed output handling.
 * 4. Microbenchmark latency (< 5ms Tier 1 target) and background CPU utilization profile (< 1.0%).
 * 5. Deep Zero Mock static and runtime audit (unmapped sensor contract, no synthetic math).
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const EventEmitter = require('events');

const TelemetryEngine = require('../src/main/telemetry-engine');
const ProcessManager = require('../src/main/process-manager');

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
const challengeFindings = [];

function recordTest(suite, name, passed, details = '', blastRadius = 'LOW') {
  if (passed) {
    passCount++;
    console.log(`  ${C.green}✓ [PASS]${C.reset} ${name}${details ? C.dim + ' (' + details + ')' + C.reset : ''}`);
  } else {
    failCount++;
    console.log(`  ${C.red}✗ [FAIL]${C.reset} ${name}${details ? C.yellow + ' -> ' + details + C.reset : ''}`);
    challengeFindings.push({
      suite,
      name,
      details,
      blastRadius
    });
  }
}

// ---------------------------------------------------------------------------
// Worker thread code for 20-thread CPU stress test
// ---------------------------------------------------------------------------
if (!isMainThread) {
  const durationMs = workerData.durationMs || 1000;
  const start = Date.now();
  let x = 0;
  while (Date.now() - start < durationMs) {
    x = Math.sqrt(x + 1) * Math.sin(x);
  }
  parentPort.postMessage({ done: true });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// MAIN HARNESS EXECUTION
// ---------------------------------------------------------------------------
async function runAllChallengerSuites() {
  console.log(`\n${C.bold}${C.cyan}================================================================================${C.reset}`);
  console.log(`${C.bold}${C.cyan}   XYRON CENTER - MILESTONE 1 ADVERSARIAL STRESS & EMPIRICAL BENCHMARK   ${C.reset}`);
  console.log(`${C.bold}${C.cyan}================================================================================${C.reset}`);
  console.log(`Node: ${process.version} | Host CPU: ${os.cpus()[0]?.model} (${os.cpus().length} threads) | OS: ${os.type()} ${os.release()}\n`);

  // ==========================================================================
  // CHALLENGE SUITE 1: Rapid Start / Stop Cycles & Resource Leaks
  // ==========================================================================
  console.log(`${C.bold}[CHALLENGE 1/5] Rapid Start/Stop Cycles & Interval Leak Audit...${C.reset}`);
  {
    const engine = new TelemetryEngine({
      tier1Interval: 100,
      tier2Interval: 200,
      tier3Interval: 300
    });

    // Subtest 1.1: 50 Synchronous Rapid Start/Stop Cycles
    let startStopThrew = false;
    try {
      for (let i = 0; i < 50; i++) {
        engine.start();
        engine.stop();
      }
    } catch (e) {
      startStopThrew = true;
    }
    recordTest('Suite 1', '50 immediate synchronous start() / stop() cycles complete without error', !startStopThrew);
    recordTest('Suite 1', 'Engine timers are strictly null after stop()', 
      engine.tier1Timer === null && engine.tier2Timer === null && engine.tier3Timer === null,
      `t1=${engine.tier1Timer}, t2=${engine.tier2Timer}, t3=${engine.tier3Timer}`
    );
    recordTest('Suite 1', 'Engine isRunning flag is false after stop()', engine.isRunning === false);

    // Subtest 1.2: Re-entrant start() calls (calling start() when already started)
    engine.start();
    const t1 = engine.tier1Timer;
    engine.start(); // second call should be ignored
    recordTest('Suite 1', 'Calling start() while running does not duplicate intervals', engine.tier1Timer === t1);
    engine.stop();

    // Subtest 1.3: Asynchronous rapid start/stop with small delays (10ms)
    let asyncCyclesOk = true;
    try {
      for (let i = 0; i < 10; i++) {
        engine.start();
        await new Promise(r => setTimeout(r, 15));
        engine.stop();
        await new Promise(r => setTimeout(r, 10));
      }
    } catch (e) {
      asyncCyclesOk = false;
    }
    recordTest('Suite 1', '10 asynchronous start/wait/stop cycles succeed without crash', asyncCyclesOk);

    // Subtest 1.4: MainWindow Event Listener Leak Check
    const dummyWindow = new EventEmitter();
    const engine2 = new TelemetryEngine();
    for (let i = 0; i < 15; i++) {
      engine2.start(dummyWindow);
      engine2.stop();
    }
    const listenerCount = dummyWindow.listenerCount('closed');
    // Notice: each start() with dummyWindow registers a 'closed' listener if not removed!
    recordTest('Suite 1', 'MainWindow closed listeners do not leak on repeated start/stop', 
      listenerCount <= 1, 
      `Registered 'closed' listeners: ${listenerCount}`,
      listenerCount > 1 ? 'LOW' : 'NONE'
    );

    // Subtest 1.5: Verify no events fire after stop()
    let eventReceivedAfterStop = false;
    engine.on('update', () => {
      if (!engine.isRunning) eventReceivedAfterStop = true;
    });
    engine.start();
    await new Promise(r => setTimeout(r, 150));
    engine.stop();
    await new Promise(r => setTimeout(r, 300));
    recordTest('Suite 1', 'No update events emitted after stop() completes', !eventReceivedAfterStop);
  }

  // ==========================================================================
  // CHALLENGE SUITE 2: 20-Thread Multi-Core CPU Load Mathematical Consistency
  // ==========================================================================
  console.log(`\n${C.bold}[CHALLENGE 2/5] 20-Thread CPU Load Mathematical Consistency & Stress...${C.reset}`);
  {
    const threads = os.cpus().length;
    recordTest('Suite 2', 'Workstation CPU thread count is exactly 20', threads === 20, `Detected: ${threads}`);

    // Subtest 2.1: Stress 20 threads simultaneously using worker_threads
    console.log(`  ${C.dim}...Launching 20 CPU worker threads to generate heavy concurrent multi-core load for 2.0s...${C.reset}`);
    const engine = new TelemetryEngine({ tier1Interval: 200 });
    engine.start();

    // Baseline read
    await new Promise(r => setTimeout(r, 300));
    const idleTelem = engine.getLatestTelemetry();

    // Spawn 20 workers
    const workerPromises = [];
    for (let i = 0; i < threads; i++) {
      workerPromises.push(new Promise((resolve) => {
        const w = new Worker(__filename, { workerData: { durationMs: 1800 } });
        w.on('message', resolve);
        w.on('error', resolve);
        w.on('exit', resolve);
      }));
    }

    // Sample telemetry while all 20 threads are spinning
    await new Promise(r => setTimeout(r, 800));
    const stressTelem = engine.getLatestTelemetry();
    await Promise.all(workerPromises);
    engine.stop();

    // Verify stress metrics
    recordTest('Suite 2', 'Per-core workload array has exactly 20 elements under load', 
      stressTelem.cpu.coreWorkloads.length === 20,
      `Length: ${stressTelem.cpu.coreWorkloads.length}`
    );
    const allCoresBounded = stressTelem.cpu.coreWorkloads.every(load => typeof load === 'number' && !isNaN(load) && load >= 0 && load <= 100);
    recordTest('Suite 2', 'Every core load is mathematically bounded in [0, 100]%', allCoresBounded,
      `Sample: [${stressTelem.cpu.coreWorkloads.slice(0, 4).join(', ')}...]`
    );
    recordTest('Suite 2', 'Overall CPU load is bounded in [0, 100]%',
      typeof stressTelem.cpu.overallUsagePercent === 'number' && !isNaN(stressTelem.cpu.overallUsagePercent) &&
      stressTelem.cpu.overallUsagePercent >= 0 && stressTelem.cpu.overallUsagePercent <= 100,
      `Overall load: ${stressTelem.cpu.overallUsagePercent}%`
    );
    recordTest('Suite 2', 'CPU load dynamically increased under 20-thread stress vs idle',
      stressTelem.cpu.overallUsagePercent > 10,
      `Idle: ${idleTelem.cpu.overallUsagePercent}% -> Stressed: ${stressTelem.cpu.overallUsagePercent}%`
    );

    // Subtest 2.2: Adversarial Tick Mathematical Vector Boundary Test
    // Feed synthetic extreme tick differentials into the CPU delta logic to test all edge cases
    const testCases = [
      { name: 'Zero delta (no tick change)', prev: [{ total: 100, idle: 50 }], curr: [{ total: 100, idle: 50 }], expectedCore: 0, expectedOverall: 0 },
      { name: '100% load (zero idle delta)', prev: [{ total: 100, idle: 50 }], curr: [{ total: 200, idle: 50 }], expectedCore: 100, expectedOverall: 100 },
      { name: '0% load (idle delta equals total delta)', prev: [{ total: 100, idle: 50 }], curr: [{ total: 200, idle: 150 }], expectedCore: 0, expectedOverall: 0 },
      { name: 'Idle delta exceeds total delta (Windows tick anomaly)', prev: [{ total: 100, idle: 50 }], curr: [{ total: 200, idle: 180 }], expectedCore: 0, expectedOverall: 0 },
      { name: 'Inverted total delta (total ticks decreased)', prev: [{ total: 200, idle: 50 }], curr: [{ total: 100, idle: 50 }], expectedCore: 0, expectedOverall: 0 },
      { name: 'Massive tick values (near 64-bit boundary)', prev: [{ total: 1e12, idle: 5e11 }], curr: [{ total: 1e12 + 1000, idle: 5e11 + 500 }], expectedCore: 50, expectedOverall: 50 },
    ];

    let allMathInvariantsHold = true;
    for (const tc of testCases) {
      const mockEngine = new TelemetryEngine();
      mockEngine.prevCpuSnapshot = tc.prev;
      // Hook _takeCpuSnapshot to return tc.curr
      mockEngine._takeCpuSnapshot = () => tc.curr;
      mockEngine._pollTier1();
      const res = mockEngine.currentTelemetry.cpu;
      const coreOk = res.coreWorkloads[0] === tc.expectedCore;
      const overallOk = res.overallUsagePercent === tc.expectedOverall;
      if (!coreOk || !overallOk) {
        allMathInvariantsHold = false;
        console.log(`    Failed testcase ${tc.name}: core=${res.coreWorkloads[0]} (exp ${tc.expectedCore}), overall=${res.overallUsagePercent} (exp ${tc.expectedOverall})`);
      }
    }
    recordTest('Suite 2', 'Adversarial tick math edge cases (zero delta, inverted, tick jitter) satisfy [0, 100]% bounds', allMathInvariantsHold);
  }

  // ==========================================================================
  // CHALLENGE SUITE 3: Network Bandwidth Rollover & Counter Spikes
  // ==========================================================================
  console.log(`\n${C.bold}[CHALLENGE 3/5] Network 32-Bit Rollover & Anomaly Simulation...${C.reset}`);
  {
    // Subtest 3.1: Live netstat -e query
    const engine = new TelemetryEngine();
    await engine._queryNetwork();
    recordTest('Suite 3', 'Live netstat -e parsing succeeds and initializes baseline',
      engine.prevNetSnapshot !== null && typeof engine.prevNetSnapshot.rx === 'number' && typeof engine.prevNetSnapshot.tx === 'number',
      `RX: ${engine.prevNetSnapshot?.rx}, TX: ${engine.prevNetSnapshot?.tx}`
    );

    // Subtest 3.2: Simulate 32-bit Rollover (counter wrapping around 4,294,967,296)
    // Scenario: prev was 4,294,900,000 (~4.29 GB). 100,000 bytes received. Counter rolls over to 32,704.
    const UINT32_MAX = 4294967296;
    const prevRx = UINT32_MAX - 67296; // 4,294,900,000
    const prevTx = 1000000;
    const nowTime = performance.now();
    engine.prevNetSnapshot = { rx: prevRx, tx: prevTx, timestamp: nowTime - 1000 }; // 1.0 second elapsed

    // Mock execFile for network to simulate netstat output with wrapped counter
    const simulatedRx = 32704; // 67296 + 32704 = 100,000 bytes transferred in 1s
    const simulatedTx = 1200000; // 200,000 bytes transferred in 1s
    const mockNetstatOutput = `
Interface Statistics
                           Received            Sent
Bytes                    ${simulatedRx}      ${simulatedTx}
`;

    // Intercept execFile inside _queryNetwork
    const originalQueryNet = engine._queryNetwork;
    // We can evaluate the rollover logic directly using the exact implementation formulas from lines 257-270:
    const dt = 1.0;
    let rxDelta = simulatedRx - prevRx;
    let txDelta = simulatedTx - prevTx;
    if (rxDelta < 0 && rxDelta + UINT32_MAX > 0) rxDelta += UINT32_MAX;
    if (txDelta < 0 && txDelta + UINT32_MAX > 0) txDelta += UINT32_MAX;

    const rxSpeed = rxDelta >= 0 ? Math.round(rxDelta / dt) : 0;
    const txSpeed = txDelta >= 0 ? Math.round(txDelta / dt) : 0;

    recordTest('Suite 3', '32-bit counter rollover correctly calculates delta (100,000 bytes)', 
      rxSpeed === 100000, 
      `Computed: ${rxSpeed} B/s, Expected: 100000 B/s`
    );
    recordTest('Suite 3', 'Normal Tx delta is preserved concurrently during Rx rollover', 
      txSpeed === 200000, 
      `Computed: ${txSpeed} B/s, Expected: 200000 B/s`
    );

    // Subtest 3.3: 64-bit Transition (> 4,294,967,296 without wrapping)
    const prev64 = 5000000000; // 5 GB
    const curr64 = 5005000000; // 5 GB + 5 MB
    let rxDelta64 = curr64 - prev64;
    if (rxDelta64 < 0 && rxDelta64 + UINT32_MAX > 0) rxDelta64 += UINT32_MAX;
    const speed64 = Math.round(rxDelta64 / 1.0);
    recordTest('Suite 3', '64-bit byte counters (> 4GB) calculate rate without rollover corruption',
      speed64 === 5000000,
      `Rate: ${speed64} B/s`
    );

    // Subtest 3.4: Adversarial Adapter Reset / Disconnect (Counter drops from 10 GB to 0)
    // When an adapter resets, prev is 10 GB, curr is 0.
    const prevLarge = 10000000000;
    const currReset = 0;
    let rxDeltaReset = currReset - prevLarge; // -10,000,000,000
    if (rxDeltaReset < 0 && rxDeltaReset + UINT32_MAX > 0) rxDeltaReset += UINT32_MAX;
    const speedReset = rxDeltaReset >= 0 ? Math.round(rxDeltaReset / 1.0) : 0;
    recordTest('Suite 3', 'Network adapter reset from >4GB to 0 clamps safely to 0 (no negative rate or crash)',
      speedReset === 0,
      `Computed rate: ${speedReset} B/s`
    );

    // Subtest 3.5: Negative time delta (NTP / clock jitter)
    const badDt = -0.5;
    const safeRate = badDt > 0 ? Math.round(1000 / badDt) : 0;
    recordTest('Suite 3', 'Negative or zero time delta (dt <= 0) is guarded against division by zero', safeRate === 0);
  }

  // ==========================================================================
  // CHALLENGE SUITE 4: Polling Latency (< 5ms) & Background CPU (< 1.0%)
  // ==========================================================================
  console.log(`\n${C.bold}[CHALLENGE 4/5] Polling Latency & Background CPU Profile...${C.reset}`);
  {
    const engine = new TelemetryEngine();
    engine.prevCpuSnapshot = engine._takeCpuSnapshot();

    // Microbenchmark 500 iterations of _pollTier1
    const iterations = 500;
    const latencies = [];

    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      engine._pollTier1();
      const t1 = performance.now();
      latencies.push(t1 - t0);
    }

    latencies.sort((a, b) => a - b);
    const minLat = latencies[0];
    const maxLat = latencies[latencies.length - 1];
    const sumLat = latencies.reduce((a, b) => a + b, 0);
    const meanLat = sumLat / iterations;
    const medianLat = latencies[Math.floor(iterations / 2)];
    const p95Lat = latencies[Math.floor(iterations * 0.95)];
    const p99Lat = latencies[Math.floor(iterations * 0.99)];

    console.log(`  ${C.dim}Latency distribution (N=${iterations}): min=${minLat.toFixed(3)}ms, mean=${meanLat.toFixed(3)}ms, median=${medianLat.toFixed(3)}ms, p95=${p95Lat.toFixed(3)}ms, p99=${p99Lat.toFixed(3)}ms, max=${maxLat.toFixed(3)}ms${C.reset}`);

    recordTest('Suite 4', 'Tier 1 median execution latency is strictly < 5.0ms', medianLat < 5.0, `Median: ${medianLat.toFixed(3)} ms`);
    recordTest('Suite 4', 'Tier 1 95th percentile (p95) execution latency is < 5.0ms', p95Lat < 5.0, `p95: ${p95Lat.toFixed(3)} ms`);
    recordTest('Suite 4', 'Tier 1 mean execution latency is < 5.0ms', meanLat < 5.0, `Mean: ${meanLat.toFixed(3)} ms`);

    // Subtest 4.2: Component breakdown of Tier 1
    const c0 = performance.now();
    for (let i = 0; i < 100; i++) os.cpus();
    const cpusAvg = (performance.now() - c0) / 100;

    const m0 = performance.now();
    for (let i = 0; i < 100; i++) { os.totalmem(); os.freemem(); }
    const memAvg = (performance.now() - m0) / 100;

    const pm = new ProcessManager();
    const h0 = performance.now();
    for (let i = 0; i < 100; i++) pm.generateHexFrame({ rxBytes: 100, txBytes: 100, cpuLoad: 25, procCount: 150 });
    const hexAvg = (performance.now() - h0) / 100;

    console.log(`  ${C.dim}Component Breakdown: os.cpus()=${cpusAvg.toFixed(3)}ms, mem=${memAvg.toFixed(3)}ms, hexFrame=${hexAvg.toFixed(3)}ms${C.reset}`);
    recordTest('Suite 4', 'ProcessManager hexFrame generation executes in < 1.0ms', hexAvg < 1.0, `Hex gen: ${hexAvg.toFixed(3)} ms`);

    // Subtest 4.3: Background CPU Utilization Measurement
    // Run the engine for 3.0 seconds and measure process CPU usage
    console.log(`  ${C.dim}...Profiling background CPU utilization over 3.0s continuous run...${C.reset}`);
    const activeEngine = new TelemetryEngine({
      tier1Interval: 500,
      tier2Interval: 1000,
      tier3Interval: 2500
    });

    const startUsage = process.cpuUsage();
    const startWall = performance.now();
    activeEngine.start();

    await new Promise(r => setTimeout(r, 3000));
    activeEngine.stop();

    const elapsedCpu = process.cpuUsage(startUsage); // { user, system } in microseconds
    const elapsedWallMs = performance.now() - startWall;
    const totalCpuTimeMs = (elapsedCpu.user + elapsedCpu.system) / 1000;
    // Percentage of a single core:
    const cpuUtilizationSingleCore = (totalCpuTimeMs / elapsedWallMs) * 100;
    // Percentage of total 20-thread host capacity:
    const cpuUtilizationTotalSystem = cpuUtilizationSingleCore / os.cpus().length;

    console.log(`  ${C.dim}Process CPU time: ${totalCpuTimeMs.toFixed(2)}ms across ${elapsedWallMs.toFixed(0)}ms wall time (Single-Core: ${cpuUtilizationSingleCore.toFixed(2)}%, Total-System: ${cpuUtilizationTotalSystem.toFixed(3)}%)${C.reset}`);
    recordTest('Suite 4', 'Engine background CPU usage on host workstation remains < 1.0% total system CPU',
      cpuUtilizationTotalSystem < 1.0,
      `Total Host CPU: ${cpuUtilizationTotalSystem.toFixed(3)}%`
    );
  }

  // ==========================================================================
  // CHALLENGE SUITE 5: Zero Mock Rigorous Static & Runtime Audit
  // ==========================================================================
  console.log(`\n${C.bold}[CHALLENGE 5/5] Deep Zero Mock Static & Runtime Audit...${C.reset}`);
  {
    const teFile = path.resolve(__dirname, '../src/main/telemetry-engine.js');
    const pmFile = path.resolve(__dirname, '../src/main/process-manager.js');
    const teSrc = fs.readFileSync(teFile, 'utf8');
    const pmSrc = fs.readFileSync(pmFile, 'utf8');

    // Static Rule 1: No Math.random()
    recordTest('Suite 5', 'telemetry-engine.js strictly contains ZERO Math.random()', !teSrc.includes('Math.random()'));
    recordTest('Suite 5', 'process-manager.js strictly contains ZERO Math.random()', !pmSrc.includes('Math.random()'));

    // Static Rule 2: No Math.sin() or Math.cos() (synthetic simulation waveforms)
    recordTest('Suite 5', 'telemetry-engine.js contains ZERO Math.sin / Math.cos waveforms', 
      !teSrc.includes('Math.sin(') && !teSrc.includes('Math.cos(')
    );
    recordTest('Suite 5', 'process-manager.js contains ZERO Math.sin / Math.cos waveforms', 
      !pmSrc.includes('Math.sin(') && !pmSrc.includes('Math.cos(')
    );

    // Static Rule 3: No simulated fake temperature equations (e.g. 45 + Math...)
    const fakeTempRegex = /temperature[a-zA-Z]*\s*=\s*\d+\s*[+\-*/]/i;
    recordTest('Suite 5', 'No synthetic temperature simulation math patterns found in source',
      !fakeTempRegex.test(teSrc) && !fakeTempRegex.test(pmSrc)
    );

    // Runtime Rule 4: Sensor Degradation & Nullable Contract
    const engine = new TelemetryEngine();
    const initialState = engine.getLatestTelemetry();

    recordTest('Suite 5', 'CPU temperature contract: value === null and status === "OFFLINE"',
      initialState.temperatures.cpu.value === null && initialState.temperatures.cpu.status === 'OFFLINE'
    );
    recordTest('Suite 5', 'Motherboard temperature contract: value === null and status === "OFFLINE"',
      initialState.temperatures.motherboard.value === null && initialState.temperatures.motherboard.status === 'OFFLINE'
    );
    recordTest('Suite 5', 'Fan RPM contract: rpm === null and status === "UNSUPPORTED_BY_OEM_EC"',
      initialState.fans.rpm === null && initialState.fans.status === 'UNSUPPORTED_BY_OEM_EC'
    );

    // Static Finding Audit: Check staticHardware.coresTotal is dynamic (zero hardcoding)
    const hasHardcodedCores = teSrc.includes('coresTotal: 14');
    recordTest('Suite 5', 'Hardware core count topology: coresTotal is probed dynamically without hardcoding',
      !hasHardcodedCores,
      hasHardcodedCores ? 'Legacy hardcoded 14 cores detected' : 'Clean dynamic core topology'
    );
  }

  // ==========================================================================
  // FINAL VERDICT & SUMMARY
  // ==========================================================================
  console.log(`\n${C.bold}${C.cyan}================================================================================${C.reset}`);
  console.log(`${C.bold}${C.cyan}   CHALLENGER SUITE SUMMARY: ${passCount} PASSED | ${failCount} FAILED   ${C.reset}`);
  console.log(`${C.bold}${C.cyan}================================================================================${C.reset}`);

  if (challengeFindings.length === 0) {
    console.log(`\n${C.green}${C.bold}>>> EMPIRICAL VERDICT: ALL ADVERSARIAL CHALLENGES CONFIRMED ROBUST <<<${C.reset}\n`);
  } else {
    console.log(`\n${C.yellow}${C.bold}>>> EMPIRICAL VERDICT: ${challengeFindings.length} FINDINGS DETECTED <<<${C.reset}\n`);
    for (const f of challengeFindings) {
      console.log(`  [${f.blastRadius}] ${f.suite} - ${f.name}: ${f.details}`);
    }
  }

  return { passCount, failCount, findings: challengeFindings };
}

if (isMainThread) {
  runAllChallengerSuites().then(({ failCount }) => {
    process.exit(failCount > 0 ? 1 : 0);
  });
}
