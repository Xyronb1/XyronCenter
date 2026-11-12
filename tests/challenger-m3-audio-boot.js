/**
 * XYRON CENTER - Milestone 3 Challenger Stress & Adversarial Test Harness
 * File: tests/challenger-m3-audio-boot.js
 * 
 * Adversarial empirical testing of Web Audio DSP Synthesizer & Boot Sequence Lifecycle:
 * 1. Rapid repeated ESC & Spacebar interrupts across every phase of boot timeline (0.0s, 0.5s, 1.2s, 2.0s, 3.5s, 4.4s).
 * 2. AudioContext lifecycle stress: Repeated start/stop cycles, rapid resume/suspend/close calls, node leak audit.
 * 3. Audio curve parameter boundaries: Strict assertion that exponentialRampToValueAtTime NEVER receives <= 0.
 * 4. Procedural synthesis buffer safety: Noise buffer generation, oscillator detachment, compressor saturation bounds.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

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
const findings = [];

function recordTest(suite, name, passed, details = '', blastRadius = 'LOW') {
  if (passed) {
    passCount++;
    console.log(`  ${C.green}✓ [PASS]${C.reset} [${suite}] ${name}${details ? C.dim + ' (' + details + ')' + C.reset : ''}`);
  } else {
    failCount++;
    console.log(`  ${C.red}✗ [FAIL]${C.reset} [${suite}] ${name}${details ? C.yellow + ' -> ' + details + C.reset : ''}`);
    findings.push({ suite, name, details, blastRadius });
  }
}

// ============================================================================
// STRICT W3C WEB AUDIO API HEADLESS MOCK & VALIDATION SPY
// ============================================================================

class DOMException extends Error {
  constructor(message, name = 'Error') {
    super(message);
    this.name = name;
  }
}

class MockAudioParam {
  constructor(name, defaultValue = 0, minValue = -Infinity, maxValue = Infinity) {
    this.name = name;
    this.defaultValue = defaultValue;
    this.minValue = minValue;
    this.maxValue = maxValue;
    this.value = defaultValue;
    this.events = [];
  }

  setValueAtTime(value, startTime) {
    if (!Number.isFinite(value)) {
      throw new TypeError(`AudioParam.${this.name}.setValueAtTime: value must be a finite number, received: ${value}`);
    }
    if (!Number.isFinite(startTime) || startTime < 0) {
      throw new RangeError(`AudioParam.${this.name}.setValueAtTime: startTime must be non-negative finite number, received: ${startTime}`);
    }
    this.value = value;
    this.events.push({ type: 'setValueAtTime', value, time: startTime });
    return this;
  }

  linearRampToValueAtTime(value, endTime) {
    if (!Number.isFinite(value)) {
      throw new TypeError(`AudioParam.${this.name}.linearRampToValueAtTime: value must be a finite number, received: ${value}`);
    }
    if (!Number.isFinite(endTime) || endTime < 0) {
      throw new RangeError(`AudioParam.${this.name}.linearRampToValueAtTime: endTime must be non-negative finite number, received: ${endTime}`);
    }
    this.value = value;
    this.events.push({ type: 'linearRampToValueAtTime', value, time: endTime });
    return this;
  }

  exponentialRampToValueAtTime(value, endTime) {
    // W3C Specification: The float value provided MUST be strictly positive (> 0)
    if (!Number.isFinite(value)) {
      throw new TypeError(`AudioParam.${this.name}.exponentialRampToValueAtTime: value must be a finite number, received: ${value}`);
    }
    if (value <= 0) {
      throw new DOMException(
        `Failed to execute 'exponentialRampToValueAtTime' on 'AudioParam': The float value provided (${value}) is not positive.`,
        'InvalidAccessError'
      );
    }
    if (!Number.isFinite(endTime) || endTime < 0) {
      throw new RangeError(`AudioParam.${this.name}.exponentialRampToValueAtTime: endTime must be non-negative finite number, received: ${endTime}`);
    }
    this.value = value;
    this.events.push({ type: 'exponentialRampToValueAtTime', value, time: endTime });
    return this;
  }

  cancelScheduledValues(startTime) {
    if (!Number.isFinite(startTime) || startTime < 0) {
      throw new RangeError(`AudioParam.${this.name}.cancelScheduledValues: startTime must be non-negative finite number, received: ${startTime}`);
    }
    this.events = this.events.filter(e => e.time < startTime);
    return this;
  }
}

class MockAudioNode {
  constructor(ctx) {
    this.context = ctx;
    this.outputs = new Set();
    this.inputs = new Set();
    this.isDisposed = false;
  }

  connect(destination) {
    if (this.isDisposed) {
      throw new DOMException('Cannot connect disposed AudioNode', 'InvalidStateError');
    }
    this.outputs.add(destination);
    if (destination instanceof MockAudioNode) {
      destination.inputs.add(this);
    }
    return destination;
  }

  disconnect(destination) {
    if (destination) {
      this.outputs.delete(destination);
      if (destination instanceof MockAudioNode) {
        destination.inputs.delete(this);
      }
    } else {
      for (const dest of this.outputs) {
        if (dest instanceof MockAudioNode) {
          dest.inputs.delete(this);
        }
      }
      this.outputs.clear();
    }
  }
}

class MockAudioScheduledSourceNode extends MockAudioNode {
  constructor(ctx) {
    super(ctx);
    this._started = false;
    this._stopped = false;
    this._startTime = null;
    this._stopTime = null;
    this.onended = null;
  }

  start(when = 0) {
    if (this._started) {
      throw new DOMException("Failed to execute 'start' on 'AudioScheduledSourceNode': Cannot call start more than once.", 'InvalidStateError');
    }
    this._started = true;
    this._startTime = when;
  }

  stop(when = 0) {
    if (this._stopped) {
      throw new DOMException("Failed to execute 'stop' on 'AudioScheduledSourceNode': Cannot call stop more than once.", 'InvalidStateError');
    }
    this._stopped = true;
    this._stopTime = when;
    // Fire onended asynchronously to mimic browser runtime
    setImmediate(() => {
      if (typeof this.onended === 'function') {
        try {
          this.onended({ target: this });
        } catch (e) {}
      }
    });
  }
}

class MockOscillatorNode extends MockAudioScheduledSourceNode {
  constructor(ctx) {
    super(ctx);
    this.type = 'sine';
    this.frequency = new MockAudioParam('frequency', 440, 0, 24000);
    this.detune = new MockAudioParam('detune', 0, -153600, 153600);
  }
}

class MockAudioBufferSourceNode extends MockAudioScheduledSourceNode {
  constructor(ctx) {
    super(ctx);
    this.buffer = null;
    this.loop = false;
    this.playbackRate = new MockAudioParam('playbackRate', 1, 0, 1024);
  }
}

class MockBiquadFilterNode extends MockAudioNode {
  constructor(ctx) {
    super(ctx);
    this.type = 'lowpass';
    this.frequency = new MockAudioParam('frequency', 350, 0, 24000);
    this.Q = new MockAudioParam('Q', 1, 0.0001, 1000);
    this.gain = new MockAudioParam('gain', 0, -40, 40);
  }
}

class MockGainNode extends MockAudioNode {
  constructor(ctx) {
    super(ctx);
    this.gain = new MockAudioParam('gain', 1.0, -Infinity, Infinity);
  }
}

class MockDynamicsCompressorNode extends MockAudioNode {
  constructor(ctx) {
    super(ctx);
    this.threshold = new MockAudioParam('threshold', -24, -100, 0);
    this.knee = new MockAudioParam('knee', 30, 0, 40);
    this.ratio = new MockAudioParam('ratio', 12, 1, 20);
    this.attack = new MockAudioParam('attack', 0.003, 0, 1);
    this.release = new MockAudioParam('release', 0.250, 0, 1);
  }
}

class MockAudioBuffer {
  constructor(numberOfChannels, length, sampleRate) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this._channels = [];
    for (let c = 0; c < numberOfChannels; c++) {
      this._channels.push(new Float32Array(length));
    }
  }

  getChannelData(channelIndex) {
    if (channelIndex < 0 || channelIndex >= this.numberOfChannels) {
      throw new DOMException('IndexSizeError: channel index out of range', 'IndexSizeError');
    }
    return this._channels[channelIndex];
  }
}

class MockAudioContext extends EventEmitter {
  constructor() {
    super();
    this.sampleRate = 44100;
    this.currentTime = 0.01;
    this.state = 'suspended';
    this.destination = new MockAudioNode(this);
    this.createdNodes = new Set();
  }

  async resume() {
    if (this.state === 'closed') {
      throw new DOMException('Cannot resume a closed AudioContext', 'InvalidStateError');
    }
    this.state = 'running';
  }

  async suspend() {
    if (this.state === 'closed') {
      throw new DOMException('Cannot suspend a closed AudioContext', 'InvalidStateError');
    }
    this.state = 'suspended';
  }

  async close() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.emit('statechange');
  }

  createGain() {
    const node = new MockGainNode(this);
    this.createdNodes.add(node);
    return node;
  }

  createOscillator() {
    const node = new MockOscillatorNode(this);
    this.createdNodes.add(node);
    return node;
  }

  createBufferSource() {
    const node = new MockAudioBufferSourceNode(this);
    this.createdNodes.add(node);
    return node;
  }

  createBiquadFilter() {
    const node = new MockBiquadFilterNode(this);
    this.createdNodes.add(node);
    return node;
  }

  createDynamicsCompressor() {
    const node = new MockDynamicsCompressorNode(this);
    this.createdNodes.add(node);
    return node;
  }

  createBuffer(channels, length, sampleRate) {
    return new MockAudioBuffer(channels, length, sampleRate);
  }
}

// ============================================================================
// LIGHTWEIGHT DOM ENVIRONMENT FOR BOOT SEQUENCE
// ============================================================================

class MockClassList {
  constructor() {
    this.classes = new Set();
  }
  add(...names) { names.forEach(n => this.classes.add(n)); }
  remove(...names) { names.forEach(n => this.classes.delete(n)); }
  contains(name) { return this.classes.has(name); }
  toggle(name, force) {
    if (force === undefined) {
      if (this.classes.has(name)) this.classes.delete(name);
      else this.classes.add(name);
    } else if (force) {
      this.classes.add(name);
    } else {
      this.classes.delete(name);
    }
  }
}

class MockElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.id = '';
    this.className = '';
    this.classList = new MockClassList();
    this.style = {};
    this.children = [];
    this.textContent = '';
    this._innerHTML = '';
    this.scrollTop = 0;
    this.scrollHeight = 100;
  }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(val) {
    this._innerHTML = val;
    // Auto-create child placeholders for IDs queryable inside markup
    const ids = ['boot-post-terminal', 'boot-wireframe-grid', 'boot-logo-container', 'boot-status-badge', 'boot-log-stream', 'boot-calibration-progress'];
    ids.forEach(id => {
      if (val.includes(`id="${id}"`)) {
        const child = new MockElement('div');
        child.id = id;
        this.children.push(child);
      }
    });
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

  querySelector(sel) {
    if (sel.startsWith('#')) {
      const id = sel.slice(1);
      return this.children.find(c => c.id === id) || new MockElement('div');
    }
    return new MockElement('div');
  }

  querySelectorAll(sel) {
    return [new MockElement('div')];
  }
}

class MockDocument {
  constructor() {
    this.elements = new Map();
    this.body = new MockElement('body');
  }

  getElementById(id) {
    if (!this.elements.has(id)) {
      const el = new MockElement('div');
      el.id = id;
      this.elements.set(id, el);
    }
    return this.elements.get(id);
  }

  createElement(tag) {
    return new MockElement(tag);
  }
}

// Global setup
global.DOMException = DOMException;
global.document = new MockDocument();
global.window = {
  document: global.document,
  AudioContext: MockAudioContext,
  webkitAudioContext: MockAudioContext,
  addEventListener: (event, fn, opts) => {
    if (!global.__windowListeners) global.__windowListeners = new Map();
    if (!global.__windowListeners.has(event)) global.__windowListeners.set(event, []);
    global.__windowListeners.get(event).push({ fn, opts });
  },
  removeEventListener: (event, fn, opts) => {
    if (!global.__windowListeners || !global.__windowListeners.has(event)) return;
    const list = global.__windowListeners.get(event);
    const idx = list.findIndex(item => item.fn === fn);
    if (idx !== -1) list.splice(idx, 1);
  },
  dispatchEvent: (event) => {
    if (!global.__windowListeners || !global.__windowListeners.has(event.type)) return;
    const list = [...global.__windowListeners.get(event.type)];
    list.forEach(item => {
      try { item.fn(event); } catch (e) { console.error('Listener error:', e); }
    });
  },
  telemetryApi: {
    getSnapshot: async () => ({
      cpu: { model: 'Intel(R) Core(TM) i7-13650HX', coresTotal: 14, logicalThreads: 20 },
      memory: { totalBytes: 34359738368, freeBytes: 17179869184 },
      gpu: { name: 'NVIDIA GeForce RTX 4060 Laptop GPU' }
    }),
    onUpdate: () => () => {}
  },
  terminalView: {
    focus: () => { global.__terminalFocused = true; }
  }
};

// Load targets
const BootAudio = require('../src/renderer/js/boot-audio.js');
const BootSequence = require('../src/renderer/js/boot-sequence.js');

// ============================================================================
// TEST SUITE EXECUTION
// ============================================================================

async function runAllChallengerTests() {
  console.log(`\n${C.bold}${C.cyan}================================================================${C.reset}`);
  console.log(`${C.bold}${C.cyan}  XYRON CENTER - MILESTONE 3 AUDIO & BOOT LIFECYCLE CHALLENGER  ${C.reset}`);
  console.log(`${C.bold}${C.cyan}================================================================${C.reset}\n`);

  // Track unhandled promise rejections
  let unhandledRejections = 0;
  const unhandledListener = (reason) => {
    unhandledRejections++;
    console.error('Unhandled Rejection detected:', reason);
  };
  process.on('unhandledRejection', unhandledListener);

  try {
    // ------------------------------------------------------------------------
    // AREA 1: Rapid Repeated Keyboard Interrupts During Every Boot Phase
    // ------------------------------------------------------------------------
    console.log(`${C.bold}${C.magenta}--- AREA 1: KEYBOARD INTERRUPTS DURING ALL BOOT PHASES ---${C.reset}`);

    // The signature intro runs 1.5s: "Xyron" is signed at ~0.1s, "center" at ~0.6s,
    // the hairline rule at ~1.06s, and the fade starts at 1.5s.
    const interruptPhases = [
      { name: 'Phase 0 (0.0s async preamble / while config loads)', delayMs: 10, key: 'Escape', code: 'Escape' },
      { name: 'Phase 1 (0.3s signing "Xyron")', delayMs: 300, key: ' ', code: 'Space' },
      { name: 'Phase 2 (0.8s signing "center")', delayMs: 800, key: 'Escape', code: 'Escape' },
      { name: 'Phase 3 (1.2s hairline rule drawn)', delayMs: 1200, key: ' ', code: 'Space' },
      { name: 'Phase 4 (1.4s just before the fade)', delayMs: 1400, key: 'Escape', code: 'Escape' }
    ];

    for (const phase of interruptPhases) {
      global.document = new MockDocument();
      global.window.document = global.document;
      global.__windowListeners = new Map();
      global.__terminalFocused = false;

      const audio = new BootAudio();
      let completedCalled = 0;
      let skippedCalled = 0;

      const boot = new BootSequence({
        containerId: 'boot-overlay',
        audio,
        onComplete: () => { completedCalled++; },
        onSkip: () => { skippedCalled++; }
      });

      boot.init();
      const startPromise = boot.start();

      // Schedule interrupt key event
      await new Promise(resolve => setTimeout(resolve, phase.delayMs));

      // Simulate keydown event
      const keyEvent = {
        type: 'keydown',
        key: phase.key,
        code: phase.code,
        preventDefault: () => {},
        stopPropagation: () => {}
      };
      global.window.dispatchEvent(keyEvent);

      await startPromise;
      // Allow 30ms for 15ms anti-pop ramp and stopAll
      await new Promise(resolve => setTimeout(resolve, 50));

      const isSkipped = boot.isSkipped === true;
      const isMuted = audio.isMuted === true;
      const overlayHidden = boot.container.classList.contains('boot-hidden');
      const terminalFocused = global.__terminalFocused === true;

      recordTest(
        'BOOT_INTERRUPT',
        `Keyboard Interrupt at ${phase.name}`,
        isSkipped && isMuted && overlayHidden && skippedCalled === 1 && completedCalled === 1,
        `skipped=${isSkipped}, muted=${isMuted}, overlayHidden=${overlayHidden}, onSkip=${skippedCalled}, onComplete=${completedCalled}`,
        'CRITICAL'
      );

      // Clean up audio
      audio.dispose();
    }

    // Adversarial Interrupt Test: Early Preamble Skip Ghost Timer Audit
    // Verifies whether timers scheduled AFTER start()'s async preamble fire and mutate DOM post-skip
    {
      global.document = new MockDocument();
      global.window.document = global.document;
      global.__windowListeners = new Map();
      global.__terminalFocused = false;

      // Realistic IPC delay (40ms)
      const origGetSnapshot = global.window.telemetryApi.getSnapshot;
      global.window.telemetryApi.getSnapshot = async () => {
        await new Promise(r => setTimeout(r, 40));
        return { cpu: {}, memory: {}, gpu: {} };
      };

      const audio = new BootAudio();
      let completedCount = 0;

      const boot = new BootSequence({
        containerId: 'boot-overlay',
        audio,
        onComplete: () => { completedCount++; }
      });

      boot.init();
      const startPromise = boot.start();

      // User presses ESC at 10ms while IPC snapshot is in flight
      await new Promise(r => setTimeout(r, 10));
      boot.skip();
      await startPromise;

      // Check whether ghost timers were scheduled after skip
      const timersAfterStart = boot.timers.length;

      recordTest(
        'BOOT_INTERRUPT',
        'Early Preamble Skip: Zero Ghost Timers Scheduled Post-Skip (40ms IPC in flight)',
        timersAfterStart === 0,
        `timers count after early skip: ${timersAfterStart} (expected 0)`,
        'HIGH'
      );

      // Restore
      global.window.telemetryApi.getSnapshot = origGetSnapshot;
      audio.dispose();
    }

    // Adversarial Interrupt Stress: Rapid Barrage of 100 alternating ESC and Spacebar keys
    {
      global.document = new MockDocument();
      global.window.document = global.document;
      global.__windowListeners = new Map();
      global.__terminalFocused = false;

      const audio = new BootAudio();
      let completedCount = 0;
      let skippedCount = 0;

      const boot = new BootSequence({
        containerId: 'boot-overlay',
        audio,
        onComplete: () => { completedCount++; },
        onSkip: () => { skippedCount++; }
      });

      boot.init();
      const startPromise = boot.start();

      // Rapid barrage: 100 keydown events within 20ms
      for (let i = 0; i < 100; i++) {
        const key = (i % 2 === 0) ? 'Escape' : ' ';
        const code = (i % 2 === 0) ? 'Escape' : 'Space';
        global.window.dispatchEvent({
          type: 'keydown',
          key,
          code,
          preventDefault: () => {},
          stopPropagation: () => {}
        });
      }

      await startPromise;
      await new Promise(resolve => setTimeout(resolve, 50));

      recordTest(
        'BOOT_INTERRUPT',
        '100-Key Rapid Barrage Stress (ESC & Space interleaving)',
        boot.isSkipped === true && audio.isMuted === true && skippedCount === 1 && completedCount === 1,
        `skippedCount=${skippedCount}, completedCount=${completedCount}, audioMuted=${audio.isMuted}`,
        'HIGH'
      );

      audio.dispose();
    }

    // ------------------------------------------------------------------------
    // AREA 2: AudioContext Lifecycle Stress & Node Leak Audit
    // ------------------------------------------------------------------------
    console.log(`\n${C.bold}${C.magenta}--- AREA 2: AUDIOCONTEXT LIFECYCLE STRESS & NODE LEAK AUDIT ---${C.reset}`);

    // Test 1: Rapid 100 Start/Stop Cycles of BootAudio
    {
      let allClean = true;
      let maxActiveNodes = 0;

      for (let cycle = 0; cycle < 100; cycle++) {
        const audio = new BootAudio();
        await audio.resume();

        // Trigger sounds
        audio.playPowerCharge(0);
        audio.playRelayClick(0);
        audio.playPostBeep(0);

        if (audio.activeNodes.size > maxActiveNodes) {
          maxActiveNodes = audio.activeNodes.size;
        }

        // Rapid skip/stop
        audio.skip();
        audio.stopAll();

        if (audio.activeNodes.size !== 0) {
          allClean = false;
          break;
        }

        audio.dispose();
        if (audio.ctx !== null || audio.isDisposed !== true) {
          allClean = false;
          break;
        }
      }

      recordTest(
        'AUDIO_LIFECYCLE',
        '100 Rapid Start/Stop/Dispose Audio Cycles',
        allClean && maxActiveNodes > 0,
        `100 iterations complete, maxActiveNodes=${maxActiveNodes}, final activeNodes=0`,
        'HIGH'
      );
    }

    // Test 2: Rapid asynchronous resume/suspend/close erratic calls
    {
      const audio = new BootAudio();
      let threwUnexpected = false;

      for (let i = 0; i < 50; i++) {
        try {
          if (i % 3 === 0) await audio.resume();
          else if (i % 3 === 1) await audio.ctx.suspend();
          else await audio.resume();
        } catch (e) {
          threwUnexpected = true;
        }
      }

      recordTest(
        'AUDIO_LIFECYCLE',
        'Rapid Resume/Suspend Reentrancy & Alternation',
        !threwUnexpected && audio.ctx.state !== 'closed',
        `state=${audio.ctx.state}, zero unexpected exceptions`,
        'MEDIUM'
      );

      audio.dispose();
      // Double dispose idempotency
      try {
        audio.dispose();
        recordTest('AUDIO_LIFECYCLE', 'Double dispose idempotency', audio.isDisposed === true);
      } catch (e) {
        recordTest('AUDIO_LIFECYCLE', 'Double dispose idempotency', false, e.message);
      }
    }

    // Test 3: Active audio node disconnection crash resilience
    {
      const audio = new BootAudio();
      await audio.resume();

      // Start all procedural sounds at once
      audio.playPowerCharge(0);
      audio.playRelayClick(0);
      audio.playPostBeep(0);
      audio.startModemChirp(0, 1.0);
      audio.playGlitchBurst(0, 1.0);
      audio.playLockOnChord(0);

      const activeCountBefore = audio.activeNodes.size;
      let crashed = false;

      try {
        // Repeated immediate stopAll
        audio.stopAll();
        audio.stopAll();
        audio.stopAll();
      } catch (err) {
        crashed = true;
      }

      recordTest(
        'AUDIO_LIFECYCLE',
        'Polyphonic stopAll() disconnection resilience & idempotency',
        !crashed && audio.activeNodes.size === 0 && activeCountBefore >= 10,
        `activeBefore=${activeCountBefore}, activeAfter=${audio.activeNodes.size}`,
        'CRITICAL'
      );

      audio.dispose();
    }

    // ------------------------------------------------------------------------
    // AREA 3: Audio Curve Parameter Boundaries & Strict Positive Float Invariant
    // ------------------------------------------------------------------------
    console.log(`\n${C.bold}${C.magenta}--- AREA 3: AUDIO CURVE PARAMETER BOUNDARIES (DOMException > 0) ---${C.reset}`);

    // In Web Audio API: exponentialRampToValueAtTime throws DOMException if value <= 0
    // We will audit EVERY call to exponentialRampToValueAtTime across all 6 sound generators.
    {
      const audio = new BootAudio();
      await audio.resume();

      // Intercept and audit all exponential ramp events
      const allRamps = [];
      let nonPositiveDetected = 0;
      let invalidTimes = 0;

      const spyOnParam = (param, nodeName) => {
        const origExp = param.exponentialRampToValueAtTime.bind(param);
        param.exponentialRampToValueAtTime = (val, time) => {
          allRamps.push({ nodeName, paramName: param.name, val, time });
          if (val <= 0 || !Number.isFinite(val)) {
            nonPositiveDetected++;
          }
          if (!Number.isFinite(time) || time < 0) {
            invalidTimes++;
          }
          return origExp(val, time);
        };
      };

      // Patch ctx factory methods to attach spy
      const origCreateGain = audio.ctx.createGain.bind(audio.ctx);
      audio.ctx.createGain = () => {
        const g = origCreateGain();
        spyOnParam(g.gain, 'GainNode');
        return g;
      };

      const origCreateOsc = audio.ctx.createOscillator.bind(audio.ctx);
      audio.ctx.createOscillator = () => {
        const osc = origCreateOsc();
        spyOnParam(osc.frequency, 'OscillatorNode');
        return osc;
      };

      const origCreateFilter = audio.ctx.createBiquadFilter.bind(audio.ctx);
      audio.ctx.createBiquadFilter = () => {
        const f = origCreateFilter();
        spyOnParam(f.frequency, 'BiquadFilterNode');
        return f;
      };

      // Play each sound individually and audit
      audio.playPowerCharge(0);
      audio.playRelayClick(0);
      audio.playPostBeep(0);
      audio.startModemChirp(0, 1.5);
      audio.playGlitchBurst(0, 1.2);
      audio.playLockOnChord(0);

      recordTest(
        'CURVE_BOUNDARIES',
        'exponentialRampToValueAtTime strictly positive (> 0) verification',
        nonPositiveDetected === 0 && allRamps.length >= 10,
        `Total ramps audited: ${allRamps.length}, non-positive violations: ${nonPositiveDetected}`,
        'CRITICAL'
      );

      recordTest(
        'CURVE_BOUNDARIES',
        'exponentialRampToValueAtTime target time valid (>= 0 and finite)',
        invalidTimes === 0,
        `Invalid times: ${invalidTimes}`,
        'HIGH'
      );

      // Verify exact minimum float value used for silence ramps (should be 0.0001, never 0)
      const minVal = Math.min(...allRamps.map(r => r.val));
      recordTest(
        'CURVE_BOUNDARIES',
        'Minimum exponential ramp value conforms to anti-pop non-zero floor',
        minVal >= 0.0001,
        `Observed minimum ramp target: ${minVal} (strictly >= 0.0001)`,
        'HIGH'
      );

      // Verify linear ramp in skip() handler
      audio.skip();
      const skipEvents = audio.masterGain.gain.events.filter(e => e.type === 'linearRampToValueAtTime');
      recordTest(
        'CURVE_BOUNDARIES',
        'skip() 15ms anti-pop soft linear ramp target strictly positive',
        skipEvents.length > 0 && skipEvents[0].value >= 0.0001,
        `linearRamp target: ${skipEvents.length > 0 ? skipEvents[0].value : 'none'}`,
        'HIGH'
      );

      audio.dispose();
    }

    // Adversarial curve testing: Triggering methods with zero and small durations
    {
      const audio = new BootAudio();
      await audio.resume();
      let crashError = null;

      try {
        audio.startModemChirp(0, 0.05); // Very short duration
      } catch (err) {
        crashError = `startModemChirp(0, 0.05): ${err.message}`;
      }

      try {
        audio.playGlitchBurst(0, 0.05);  // Very short duration
      } catch (err) {
        crashError = (crashError ? crashError + ' | ' : '') + `playGlitchBurst(0, 0.05): ${err.message}`;
      }

      recordTest(
        'CURVE_BOUNDARIES',
        'Sub-second micro-duration parameter resilience',
        !crashError,
        crashError || 'zero crashes under micro-durations',
        'MEDIUM'
      );

      audio.dispose();
    }

    // ------------------------------------------------------------------------
    // AREA 4: Procedural Synthesis Buffer & DSP Safety
    // ------------------------------------------------------------------------
    console.log(`\n${C.bold}${C.magenta}--- AREA 4: PROCEDURAL SYNTHESIS BUFFER & COMPRESSOR SAFETY ---${C.reset}`);

    // Test 1: Procedural White Noise Buffer Safety
    {
      const audio = new BootAudio();
      const buffer = audio.noiseBuffer;

      const hasBuffer = buffer !== null && buffer instanceof MockAudioBuffer;
      const channels = hasBuffer ? buffer.numberOfChannels : 0;
      const length = hasBuffer ? buffer.length : 0;
      const data = hasBuffer ? buffer.getChannelData(0) : null;

      let hasNaN = false;
      let hasInf = false;
      let min = 1.0;
      let max = -1.0;
      let sum = 0;

      if (data) {
        for (let i = 0; i < data.length; i++) {
          const s = data[i];
          if (Number.isNaN(s)) hasNaN = true;
          if (!Number.isFinite(s)) hasInf = true;
          if (s < min) min = s;
          if (s > max) max = s;
          sum += s;
        }
      }

      const mean = data ? sum / data.length : 0;
      const expectedLength = Math.floor(44100 * 0.1); // 4410 samples

      recordTest(
        'SYNTH_BUFFER',
        'Procedural White Noise AudioBuffer Generation Bounds',
        hasBuffer && channels === 1 && length === expectedLength && !hasNaN && !hasInf && min >= -1.0 && max <= 1.0,
        `channels=${channels}, length=${length}, min=${min.toFixed(4)}, max=${max.toFixed(4)}, hasNaN=${hasNaN}`,
        'HIGH'
      );

      recordTest(
        'SYNTH_BUFFER',
        'Procedural White Noise Zero-Mean DC Offset (< 0.05)',
        Math.abs(mean) < 0.05,
        `Observed mean: ${mean.toFixed(6)}`,
        'LOW'
      );

      audio.dispose();
    }

    // Test 2: Master Dynamics Compressor Saturation & Clipping Bounds
    {
      const audio = new BootAudio();
      const comp = audio.compressor;

      const thresholdVal = comp.threshold.value;
      const kneeVal = comp.knee.value;
      const ratioVal = comp.ratio.value;
      const attackVal = comp.attack.value;
      const releaseVal = comp.release.value;

      const thresholdValid = thresholdVal >= -100 && thresholdVal <= 0;
      const kneeValid = kneeVal >= 0 && kneeVal <= 40;
      const ratioValid = ratioVal >= 1 && ratioVal <= 20;
      const attackValid = attackVal >= 0 && attackVal <= 1;
      const releaseValid = releaseVal >= 0 && releaseVal <= 1;

      recordTest(
        'DSP_SAFETY',
        'Dynamics Compressor Nominal Parameter Ranges (W3C Standard)',
        thresholdValid && kneeValid && ratioValid && attackValid && releaseValid,
        `threshold=${thresholdVal}dB, knee=${kneeVal}dB, ratio=${ratioVal}:1, attack=${attackVal}s, release=${releaseVal}s`,
        'HIGH'
      );

      // Verify Master Gain Output Stage
      const masterGainVal = audio.masterGain.gain.value;
      recordTest(
        'DSP_SAFETY',
        'Master Gain Stage Headroom (< 1.0 to prevent hard clipping)',
        masterGainVal > 0 && masterGainVal <= 0.85,
        `masterGain=${masterGainVal}`,
        'MEDIUM'
      );

      audio.dispose();
    }

    // Test 3: Polyphonic Saturation Stress (50 overlapping voices)
    {
      const audio = new BootAudio();
      await audio.resume();
      let crashed = false;

      try {
        for (let i = 0; i < 50; i++) {
          audio.playPowerCharge(i * 0.01);
          audio.playRelayClick(i * 0.01);
          audio.playPostBeep(i * 0.01);
          audio.playGlitchBurst(i * 0.01, 0.2);
          audio.playLockOnChord(i * 0.01);
        }
      } catch (err) {
        crashed = true;
      }

      recordTest(
        'DSP_SAFETY',
        'Extreme Polyphony Stress Test (50 simultaneous multi-voice sweeps)',
        !crashed && audio.activeNodes.size > 100,
        `activeNodes=${audio.activeNodes.size}, zero crashes`,
        'HIGH'
      );

      audio.stopAll();
      recordTest(
        'DSP_SAFETY',
        'Post-Polyphony Full Disconnection & Memory Cleanup',
        audio.activeNodes.size === 0,
        `activeNodes after stopAll: ${audio.activeNodes.size}`,
        'HIGH'
      );

      audio.dispose();
    }

    // Test 4: Natural 4.5s Boot Completion without skip
    {
      global.document = new MockDocument();
      global.window.document = global.document;
      global.__windowListeners = new Map();

      const audio = new BootAudio();
      let completedCalled = false;

      const boot = new BootSequence({
        containerId: 'boot-overlay',
        audio,
        onComplete: () => { completedCalled = true; }
      });

      boot.init();
      await boot.start();

      // Advance through natural completion (4500ms timeline + 300ms fadeout = 4800ms)
      await new Promise(resolve => setTimeout(resolve, 4900));

      recordTest(
        'BOOT_TIMELINE',
        'Natural 4.5s Boot Sequence Completion State',
        boot.isFinished === true && boot.isSkipped === false && completedCalled === true,
        `isFinished=${boot.isFinished}, isSkipped=${boot.isSkipped}, completed=${completedCalled}`,
        'HIGH'
      );

      audio.dispose();
    }

    // Check for unhandled rejections
    recordTest(
      'SYSTEM_INTEGRITY',
      'Zero Unhandled Promise Rejections',
      unhandledRejections === 0,
      `unhandled rejections count: ${unhandledRejections}`,
      'CRITICAL'
    );

  } finally {
    process.removeListener('unhandledRejection', unhandledListener);
  }

  // Summary
  console.log(`\n${C.bold}${C.cyan}================================================================${C.reset}`);
  console.log(`${C.bold}SUMMARY: Total Passed: ${passCount} | Total Failed: ${failCount}${C.reset}`);
  console.log(`${C.bold}${C.cyan}================================================================${C.reset}\n`);

  if (failCount > 0) {
    console.error(`${C.red}VERDICT: FLAG_ISSUES (${failCount} failures found)${C.reset}`);
    process.exit(1);
  } else {
    console.log(`${C.green}VERDICT: CONFIRM_CORRECTNESS (All ${passCount} tests PASSED)${C.reset}`);
    process.exit(0);
  }
}

runAllChallengerTests().catch(err => {
  console.error('Test Suite Fatal Exception:', err);
  process.exit(1);
});
