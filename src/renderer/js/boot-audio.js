/**
 * XYRON CENTER - Web Audio API Procedural DSP Synthesizer
 * File: src/renderer/js/boot-audio.js
 * 
 * 100% Procedural Web Audio API sound generator with ZERO external media files (.mp3/.wav).
 * Synthesizes all sci-fi sound effects mathematically via:
 * - Sub-bass power charge (30Hz -> 80Hz resonant frequency sweep)
 * - Micro-relay clicks (highpass filtered procedural noise impulses)
 * - Cold POST beep (1200Hz sine burst)
 * - High-speed modem/telemetry chirps (FM frequency modulation)
 * - Glitch noise burst (bandpass filtered noise + detuned electromagnetic hum)
 * - Harmonic lock-on chord (C-E-G-D major triad chord / C-Major Add9)
 * - Master DynamicsCompressorNode to prevent clipping
 * - 15ms anti-pop soft ramp skip handler (strictly non-zero exponential targets)
 */

class BootAudio {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.compressor = null;
    this.noiseBuffer = null;
    this.activeNodes = new Set();
    this.isMuted = false;
    this.isDisposed = false;

    this._initContext();
  }

  /**
   * Initializes AudioContext, master compressor, and master gain stage.
   * @private
   */
  _initContext() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        console.warn('[BootAudio] Web Audio API is not supported in this environment.');
        return;
      }

      this.ctx = new AudioCtx();

      // 1. Master Dynamics Compressor (prevents clipping when multiple voices overlap)
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.setValueAtTime(-6.0, this.ctx.currentTime);
      this.compressor.knee.setValueAtTime(12.0, this.ctx.currentTime);
      this.compressor.ratio.setValueAtTime(8.0, this.ctx.currentTime);
      this.compressor.attack.setValueAtTime(0.003, this.ctx.currentTime);
      this.compressor.release.setValueAtTime(0.200, this.ctx.currentTime);

      // 2. Master Gain Stage
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(0.85, this.ctx.currentTime);

      // Connect graph: Compressor -> Master Gain -> Audio Destination
      this.compressor.connect(this.masterGain);
      this.masterGain.connect(this.ctx.destination);

      // 3. Pre-generate reusable procedural white noise buffer (100ms)
      this._generateNoiseBuffer();
    } catch (err) {
      console.warn('[BootAudio] Failed to initialize AudioContext:', err);
    }
  }

  /**
   * Generates a 100ms white noise AudioBuffer for instantaneous relay and glitch playback.
   * @private
   */
  _generateNoiseBuffer() {
    if (!this.ctx) return;
    const sampleRate = this.ctx.sampleRate || 44100;
    const bufferSize = Math.floor(sampleRate * 0.1); // 100ms
    this.noiseBuffer = this.ctx.createBuffer(1, bufferSize, sampleRate);
    const output = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }
  }

  /**
   * Ensures AudioContext is resumed (satisfies Chromium autoplay policies).
   */
  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch (e) {}
    }
  }

  /**
   * Registers an active audio node for lifecycle tracking and instant skip cleanup.
   * @private
   */
  _trackNode(node) {
    this.activeNodes.add(node);
    if (typeof node.onended !== 'undefined') {
      const prevOnEnded = node.onended;
      node.onended = (e) => {
        this.activeNodes.delete(node);
        if (typeof prevOnEnded === 'function') prevOnEnded(e);
      };
    }
  }

  // =========================================================================
  // PROCEDURAL SOUND EFFECT GENERATORS
  // =========================================================================

  /**
   * 1. Sub-Bass Power Charge (0.0s -> 1.2s)
   * Sweeps resonant sawtooth and sub-sine from 30Hz to 80Hz simulating capacitor charge.
   * @param {number} [delay=0] - Offset in seconds from current time
   */
  playPowerCharge(delay = 0) {
    if (!this.ctx || this.isMuted) return;
    const t0 = this.ctx.currentTime + delay;

    // Voice A: Resonant Sawtooth Sweep (30Hz -> 80Hz)
    const oscSaw = this.ctx.createOscillator();
    oscSaw.type = 'sawtooth';
    oscSaw.frequency.setValueAtTime(30.0, t0);
    oscSaw.frequency.exponentialRampToValueAtTime(80.0, t0 + 1.15);

    // Voice B: Deep Sub-Sine (32Hz -> 55Hz)
    const oscSine = this.ctx.createOscillator();
    oscSine.type = 'sine';
    oscSine.frequency.setValueAtTime(32.0, t0);
    oscSine.frequency.exponentialRampToValueAtTime(55.0, t0 + 1.15);

    // Resonant Lowpass Filter (sweeps 50Hz -> 220Hz with Q = 3.2)
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.setValueAtTime(3.2, t0);
    filter.frequency.setValueAtTime(50.0, t0);
    filter.frequency.exponentialRampToValueAtTime(220.0, t0 + 1.0);

    // ADSR Gain Envelope
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(0.35, t0 + 0.25);
    gain.gain.setValueAtTime(0.35, t0 + 0.90);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.20);

    // Connect voice graph
    oscSaw.connect(filter);
    oscSine.connect(filter);
    filter.connect(gain);
    gain.connect(this.compressor);

    this._trackNode(oscSaw);
    this._trackNode(oscSine);

    oscSaw.start(t0);
    oscSine.start(t0);
    oscSaw.stop(t0 + 1.22);
    oscSine.stop(t0 + 1.22);
  }

  /**
   * 2. Micro-Relay Click (Mechanical impulse)
   * Highpass filtered procedural noise burst simulating switching relay contact.
   * @param {number} [delay=0] - Offset in seconds from current time
   */
  playRelayClick(delay = 0) {
    if (!this.ctx || !this.noiseBuffer || this.isMuted) return;
    const t0 = this.ctx.currentTime + delay;

    const noiseSource = this.ctx.createBufferSource();
    noiseSource.buffer = this.noiseBuffer;

    // Highpass Filter at 2800Hz with high Q for sharp tactile click
    const hpFilter = this.ctx.createBiquadFilter();
    hpFilter.type = 'highpass';
    hpFilter.frequency.setValueAtTime(2800, t0);
    hpFilter.Q.setValueAtTime(3.0, t0);

    // Fast 18ms impulse gain envelope
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.22, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.018);

    noiseSource.connect(hpFilter);
    hpFilter.connect(gain);
    gain.connect(this.compressor);

    this._trackNode(noiseSource);

    noiseSource.start(t0);
    noiseSource.stop(t0 + 0.020);
  }

  /**
   * 3. Cold POST Beep (1200Hz BIOS diagnostic sine burst)
   * Authentic motherboard diagnostic pass confirmation tone.
   * @param {number} [delay=0] - Offset in seconds from current time
   */
  playPostBeep(delay = 0) {
    if (!this.ctx || this.isMuted) return;
    const t0 = this.ctx.currentTime + delay;

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200.0, t0);

    // Subtle diagnostic overtone at 1800Hz (-14dB)
    const oscOvertone = this.ctx.createOscillator();
    oscOvertone.type = 'sine';
    oscOvertone.frequency.setValueAtTime(1800.0, t0);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(0.22, t0 + 0.004);
    gain.gain.setValueAtTime(0.22, t0 + 0.045);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.070);

    const gainOvertone = this.ctx.createGain();
    gainOvertone.gain.setValueAtTime(0.05, t0);
    gainOvertone.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.070);

    osc.connect(gain);
    oscOvertone.connect(gainOvertone);
    gain.connect(this.compressor);
    gainOvertone.connect(this.compressor);

    this._trackNode(osc);
    this._trackNode(oscOvertone);

    osc.start(t0);
    oscOvertone.start(t0);
    osc.stop(t0 + 0.075);
    oscOvertone.stop(t0 + 0.075);
  }

  /**
   * 4. High-Speed Modem / Telemetry Chirps (FM Frequency Modulation)
   * Modulated FSK sequence simulating high-speed internal telemetry bus stream.
   * @param {number} [delay=0] - Offset in seconds from current time
   * @param {number} [duration=1.5] - Total duration of chirp chatter
   */
  startModemChirp(delay = 0, duration = 1.5) {
    if (!this.ctx || this.isMuted) return;
    const t0 = this.ctx.currentTime + delay;

    // Carrier Oscillator
    const carrier = this.ctx.createOscillator();
    carrier.type = 'triangle';
    carrier.frequency.setValueAtTime(1800, t0);

    // Modulator Oscillator (FM modulation for data bus texture)
    const modulator = this.ctx.createOscillator();
    modulator.type = 'sawtooth';
    modulator.frequency.setValueAtTime(160, t0);

    // Modulation Gain (Deviation depth: 450Hz)
    const modGain = this.ctx.createGain();
    modGain.gain.setValueAtTime(450, t0);

    modulator.connect(modGain);
    modGain.connect(carrier.frequency);

    // Step carrier frequency across telemetry frequencies
    const freqSteps = [1200, 1800, 2400, 1500, 2100, 2700, 1350, 2250, 1650, 2850];
    const stepDuration = 0.040; // 40ms per packet step
    const stepsCount = Math.floor(duration / stepDuration);
    for (let i = 0; i < stepsCount; i++) {
      const stepTime = t0 + (i * stepDuration);
      const targetFreq = freqSteps[i % freqSteps.length];
      carrier.frequency.setValueAtTime(targetFreq, stepTime);
    }

    // Bandpass Filter (1400Hz to 4000Hz)
    const bpFilter = this.ctx.createBiquadFilter();
    bpFilter.type = 'bandpass';
    bpFilter.frequency.setValueAtTime(2400, t0);
    bpFilter.Q.setValueAtTime(1.8, t0);

    // Master Envelope for telemetry phase
    const envGain = this.ctx.createGain();
    envGain.gain.setValueAtTime(0.0001, t0);
    envGain.gain.linearRampToValueAtTime(0.09, t0 + 0.06);
    const safeDuration = Math.max(0.15, duration);
    const holdTime = Math.max(t0 + 0.06, t0 + safeDuration - 0.08);
    envGain.gain.setValueAtTime(0.09, holdTime);
    envGain.gain.exponentialRampToValueAtTime(0.0001, t0 + safeDuration);

    carrier.connect(bpFilter);
    bpFilter.connect(envGain);
    envGain.connect(this.compressor);

    this._trackNode(carrier);
    this._trackNode(modulator);

    carrier.start(t0);
    modulator.start(t0);
    carrier.stop(t0 + duration + 0.02);
    modulator.stop(t0 + duration + 0.02);
  }

  /**
   * 5. Glitch Noise Burst (White noise + bandpass + detuned electromagnetic hum)
   * Accompanies the central logo reveal and RGB chromatic aberration slices.
   * @param {number} [delay=0] - Offset in seconds from current time
   * @param {number} [duration=1.2] - Duration of glitch phase
   */
  playGlitchBurst(delay = 0, duration = 1.2) {
    if (!this.ctx || !this.noiseBuffer || this.isMuted) return;
    const t0 = this.ctx.currentTime + delay;

    // Sub-voice A: Gated Noise Pulses
    const noiseSource = this.ctx.createBufferSource();
    noiseSource.buffer = this.noiseBuffer;
    noiseSource.loop = true;

    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.setValueAtTime(1600, t0);
    noiseFilter.Q.setValueAtTime(2.8, t0);
    noiseFilter.frequency.exponentialRampToValueAtTime(3400, t0 + duration);

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.0001, t0);

    // Pulse noise gain synchronously with visual glitch slices
    const glitchPulses = [0.05, 0.25, 0.55, 0.85];
    glitchPulses.forEach(offset => {
      const pt = t0 + offset;
      if (pt < t0 + duration) {
        noiseGain.gain.setValueAtTime(0.20, pt);
        noiseGain.gain.exponentialRampToValueAtTime(0.0001, pt + 0.06);
      }
    });

    noiseSource.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(this.compressor);

    // Sub-voice B: Detuned Sawtooth Pair (110Hz & 113.5Hz -> 3.5Hz electromagnetic beat hum)
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc2.type = 'sawtooth';
    osc1.frequency.setValueAtTime(110.0, t0);
    osc2.frequency.setValueAtTime(113.5, t0);

    const humFilter = this.ctx.createBiquadFilter();
    humFilter.type = 'lowpass';
    humFilter.frequency.setValueAtTime(400, t0);
    humFilter.frequency.exponentialRampToValueAtTime(1800, t0 + duration * 0.8);

    const humGain = this.ctx.createGain();
    humGain.gain.setValueAtTime(0.0001, t0);
    humGain.gain.linearRampToValueAtTime(0.18, t0 + 0.15);
    const safeDuration = Math.max(0.30, duration);
    const holdTime = Math.max(t0 + 0.15, t0 + safeDuration - 0.20);
    humGain.gain.setValueAtTime(0.18, holdTime);
    humGain.gain.exponentialRampToValueAtTime(0.0001, t0 + safeDuration);

    osc1.connect(humFilter);
    osc2.connect(humFilter);
    humFilter.connect(humGain);
    humGain.connect(this.compressor);

    this._trackNode(noiseSource);
    this._trackNode(osc1);
    this._trackNode(osc2);

    noiseSource.start(t0);
    osc1.start(t0);
    osc2.start(t0);
    noiseSource.stop(t0 + duration + 0.02);
    osc1.stop(t0 + duration + 0.02);
    osc2.stop(t0 + duration + 0.02);
  }

  /**
   * 6. Harmonic Lock-On Chord (C-E-G-D major triad chord / C-Major Add9)
   * Four-voice affirmation chime signaling boot sequence completion and active HUD transition.
   * C5 = 523.25 Hz, E5 = 659.25 Hz, G5 = 783.99 Hz, D6 = 1174.66 Hz
   * @param {number} [delay=0] - Offset in seconds from current time
   */
  playLockOnChord(delay = 0) {
    if (!this.ctx || this.isMuted) return;
    const t0 = this.ctx.currentTime + delay;

    const frequencies = [
      { f: 523.25, type: 'sine', weight: 0.28 },     // C5
      { f: 659.25, type: 'sine', weight: 0.24 },     // E5
      { f: 783.99, type: 'sine', weight: 0.22 },     // G5
      { f: 1174.66, type: 'triangle', weight: 0.18 } // D6 (crystalline shimmer)
    ];

    const chordFilter = this.ctx.createBiquadFilter();
    chordFilter.type = 'lowpass';
    chordFilter.frequency.setValueAtTime(5500, t0);

    const masterChordGain = this.ctx.createGain();
    masterChordGain.gain.setValueAtTime(0.0001, t0);
    masterChordGain.gain.linearRampToValueAtTime(0.32, t0 + 0.018);
    masterChordGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.350);

    frequencies.forEach(voice => {
      const osc = this.ctx.createOscillator();
      osc.type = voice.type;
      osc.frequency.setValueAtTime(voice.f, t0);

      const voiceGain = this.ctx.createGain();
      voiceGain.gain.setValueAtTime(voice.weight, t0);

      osc.connect(voiceGain);
      voiceGain.connect(chordFilter);

      this._trackNode(osc);
      osc.start(t0);
      osc.stop(t0 + 0.360);
    });

    chordFilter.connect(masterChordGain);
    masterChordGain.connect(this.compressor);
  }

  // =========================================================================
  // SKIP & DISPOSAL MECHANICS
  // =========================================================================

  /**
   * Instant Skip Handler: Ramps master gain to 0 in 15ms anti-pop ramp and mutes audio.
   */
  skip() {
    this.isMuted = true;
    if (!this.ctx || !this.masterGain) return;

    try {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
      // Strictly non-zero target (0.0001) avoids DOMException
      this.masterGain.gain.linearRampToValueAtTime(0.0001, now + 0.015);

      setTimeout(() => {
        this.stopAll();
      }, 20);
    } catch (e) {
      this.stopAll();
    }
  }

  /**
   * Stops and disconnects all actively tracked audio nodes.
   */
  stopAll() {
    this.activeNodes.forEach(node => {
      try {
        if (typeof node.stop === 'function') node.stop();
        if (typeof node.disconnect === 'function') node.disconnect();
      } catch (e) {}
    });
    this.activeNodes.clear();
  }

  /**
   * Fully disposes the synthesizer and closes the underlying AudioContext.
   */
  dispose() {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.stopAll();
    if (this.ctx && this.ctx.state !== 'closed') {
      try {
        this.ctx.close();
      } catch (e) {}
    }
    this.ctx = null;
  }
}

// Attach to window for standard script tag usage or export as CommonJS module
if (typeof window !== 'undefined') {
  window.BootAudio = BootAudio;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BootAudio;
}
