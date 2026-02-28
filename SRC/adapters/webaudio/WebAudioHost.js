/**
 * @file WebAudioHost.js
 * @module WebAudioHost
 *
 * Web Audio host for the AY-3-8910 PSG emulation.
 * Contains the AudioWorklet processor (`CPCAudioProcessor`) and the
 * `Audio_Output` driver object.
 *
 * Separating this file from `AY38910.js` lets the PSG chip be used without
 * any Web Audio dependency (unit tests, offline rendering, etc.).
 * No jQuery reference is required.
 *
 * External dependencies injected via `Audio_Output.link(bus)`:
 *   bus.getSoundEnabled()  {boolean}  — whether audio output is enabled
 *   bus.getVolume()        {number}   — master volume [0..1]
 *   bus.getAudioOutput()   {Function} — Mono or Stereo output function
 *   bus.getTapeBitOut()    {number}   — tape signal bit (TapeController)
 *   bus.getMotorRelay()    {boolean}  — tape motor relay state
 *   bus.psgClock()         {Function} — PSG_Sound_AY38910.Clock_Cycle()
 *   bus.getChanA/B/C()     {number}   — PSG channel output levels
 *
 * Performance notes:
 *
 *   Ring buffer — modulo replaced by bitmask:
 *     BUF_SIZE = 16 384 = 2^14. All `% BUF_SIZE` operations are replaced by
 *     `& BUF_MASK` (0x3FFF). Integer modulo on a non-constant value requires a
 *     hardware divide (2–20 cycles). Bitmask AND is a single-cycle atomic
 *     instruction. This matters in the hot path (`onmessage` write side and
 *     `process` read side), both called at ≈44 100 Hz in the Worklet thread.
 *
 *   Message type — string replaced by integer:
 *     `data.type === 'samples'` / `data.type === 'reset'` required a string
 *     hash + content comparison per message. Replaced by integer constants
 *     (MSG_SAMPLES = 1, MSG_RESET = 2). Integer equality is a single CPU
 *     instruction with no allocation. The same constants are defined in both
 *     the worklet code string and in `Audio_Output` so both sides of the
 *     MessagePort share the same binary protocol.
 */

"use strict";

// ---------------------------------------------------------------------------
// MessagePort protocol constants
// Shared between Audio_Output (sender) and CPCAudioProcessor (receiver).
// ---------------------------------------------------------------------------

/** @type {number} Message type: push a batch of interleaved L/R audio samples. */
const MSG_SAMPLES = 1;
/** @type {number} Message type: flush and reset the ring buffer. */
const MSG_RESET   = 2;


// ============================================================================
// CPCAudioProcessor — AudioWorklet (runs in the audio thread)
// ============================================================================

const WORKLET_CODE = `

const MSG_SAMPLES = 1;
const MSG_RESET   = 2;

class CPCAudioProcessor extends AudioWorkletProcessor {

    constructor() {
        super();

        // Ring buffer — 16 384 floats ≈ 185 ms @ 44.1 kHz stereo.
        // BUF_SIZE is a power of two so BUF_MASK can replace all modulo ops.
        this.BUF_SIZE  = 16384;
        this.BUF_MASK  = 16383;     // 0x3FFF = BUF_SIZE - 1
        this.ringBuf   = new Float32Array(this.BUF_SIZE);
        this.wIdx      = 0;         // write index
        this.rIdx      = 0;         // read index
        this.available = 0;         // number of floats currently in the buffer

        // Independent DC-blocker state per channel
        this.dcL = { x1: 0, y1: 0 };
        this.dcR = { x1: 0, y1: 0 };

        // Independent low-pass filter state per channel
        this.lpL = { x1: 0, x2: 0, y1: 0, y2: 0 };
        this.lpR = { x1: 0, x2: 0, y1: 0, y2: 0 };

        // 2nd-order Butterworth low-pass at 12 kHz / 44.1 kHz
        this.lp = { b0: 0.3303, b1: 0.6606, b2: 0.3303, a1: -0.1454, a2: 0.1753 };

        this.port.onmessage = ({ data }) => {
            if (data.type === ${MSG_SAMPLES}) {
                const d    = data.data;
                const mask = this.BUF_MASK;
                let   w    = this.wIdx;
                let   av   = this.available;
                const buf  = this.ringBuf;
                const size = this.BUF_SIZE;

                for (let i = 0; i < d.length; i++) {
                    if (av < size) {
                        buf[w] = d[i];
                        w = (w + 1) & mask;
                        av++;
                    }
                }
                this.wIdx      = w;
                this.available = av;

            } else if (data.type === ${MSG_RESET}) {
                this.wIdx = this.rIdx = this.available = 0;
            }
        };
    }

    /**
     * First-order DC-blocker (~3.5 Hz cutoff).
     * Removes any DC offset introduced by the PSG or tape signal.
     * Transfer function: H(z) = (1 - z^-1) / (1 - 0.995 z^-1)
     *
     * @param {number} v - Input sample.
     * @param {Object} s - Filter state { x1, y1 }.
     * @returns {number} Filtered sample.
     */
    _dc(v, s) {
        const o = v - s.x1 + 0.995 * s.y1;
        s.x1 = v; s.y1 = o;
        return o;
    }

    /**
     * Second-order Butterworth low-pass filter (Direct Form II Transposed).
     * Cutoff: 12 kHz at 44.1 kHz sample rate.
     * Attenuates high-frequency aliasing from the 4 MHz PSG clock stepping.
     * Coefficients stored in this.lp: { b0, b1, b2, a1, a2 }.
     *
     * @param {number} v - Input sample.
     * @param {Object} s - Filter state { x1, x2, y1, y2 }.
     * @returns {number} Filtered sample.
     */
    _lp(v, s) {
        const c = this.lp;
        const o = c.b0*v + c.b1*s.x1 + c.b2*s.x2 - c.a1*s.y1 - c.a2*s.y2;
        s.x2 = s.x1; s.x1 = v;
        s.y2 = s.y1; s.y1 = o;
        return o;
    }

    process(inputs, outputs) {
        const out = outputs[0];
        if (!out || !out[0]) return true;

        const mask = this.BUF_MASK;
        const buf  = this.ringBuf;
        let   r    = this.rIdx;
        let   av   = this.available;

        for (let i = 0; i < out[0].length; i++) {
            if (av >= 2) {
                let l  = buf[r]; r = (r + 1) & mask;
                let rr = buf[r]; r = (r + 1) & mask;
                av -= 2;
                out[0][i] = this._lp(this._dc(l,  this.dcL), this.lpL);
                out[1][i] = this._lp(this._dc(rr, this.dcR), this.lpR);
            } else {
                out[0][i] = out[1][i] = 0;
            }
        }

        this.rIdx      = r;
        this.available = av;
        return true;
    }
}
registerProcessor('cpc-audio-processor', CPCAudioProcessor);
`;


// ============================================================================
// Audio_Output — timing and PSG → AudioWorklet routing (main thread)
// ============================================================================

const Audio_Output = {

    _bus: null,  /** @type {Object|null} Retained for backwards compatibility. */

    // Accessor functions injected via link() — avoid direct property reads
    // to support future hot-swappable bus implementations.
    _getSoundEnabled: null,
    _getVolume      : null,
    _getAudioOutput : null,
    _getTapeBitOut  : null,
    _getMotorRelay  : null,
    _getChanA       : null,
    _getChanB       : null,
    _getChanC       : null,
    _psgClock       : null,

    /**
     * Injects accessor functions from the emulator bus object.
     * Any accessor not present in `bus` is silently skipped.
     *
     * @param {Object} bus - Bus object exposing getters for each emulator subsystem.
     * @returns {void}
     */
    link(bus) {
        if (bus.getSoundEnabled) this._getSoundEnabled = bus.getSoundEnabled;
        if (bus.getVolume)       this._getVolume       = bus.getVolume;
        if (bus.getAudioOutput)  this._getAudioOutput  = bus.getAudioOutput;
        if (bus.getTapeBitOut)   this._getTapeBitOut   = bus.getTapeBitOut;
        if (bus.getMotorRelay)   this._getMotorRelay   = bus.getMotorRelay;
        if (bus.getChanA)        this._getChanA        = bus.getChanA;
        if (bus.getChanB)        this._getChanB        = bus.getChanB;
        if (bus.getChanC)        this._getChanC        = bus.getChanC;
        if (bus.psgClock)        this._psgClock        = bus.psgClock;
    },

    /** @type {AudioContext|null} Active Web Audio context. */
    audioContext    : null,
    /** @type {AudioWorkletNode|null} Node running CPCAudioProcessor. */
    audioWorkletNode: null,
    /** @type {boolean} True after a successful `init()` call. */
    isInitialized   : false,

    /** @type {number} Master gain [0..1], updated by Config_Manager.setVolume(). */
    k: 0.75,

    /** @type {number} Sample accumulator for clock-to-sample-rate conversion. */
    _smpAcc: 0,
    /** @type {number} Sample threshold = 1 000 000 / sampleRate (µs per sample). */
    _smpThr: 0,

    /** @type {number} Number of interleaved L+R floats per flush to the Worklet. */
    _FLUSH_SIZE: 512,
    /** @type {Float32Array|null} Pre-allocated output queue buffer. */
    _queue: null,
    /** @type {number} Current write position inside _queue. */
    _qIdx : 0,

    /** @type {Promise|null} Concurrency lock preventing double AudioContext creation. */
    _initPromise: null,

    // -------------------------------------------------------------------------
    // Initialisation
    // -------------------------------------------------------------------------

    /**
     * Creates the AudioContext, registers the CPCAudioProcessor worklet via a
     * Blob URL, and connects the AudioWorkletNode to the audio destination.
     *
     * The method is idempotent: a second call while initialisation is in progress
     * returns the same Promise rather than creating a second AudioContext.
     *
     * @returns {Promise<boolean>} `true` on success, `false` on error.
     */
    init: async function () {
        if (this.isInitialized) return true;
        if (this._initPromise) return this._initPromise;
        this._initPromise = (async () => {
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new AC();

            this._smpThr = 1_000_000 / this.audioContext.sampleRate;
            this._queue  = new Float32Array(this._FLUSH_SIZE);
            this._qIdx   = 0;

            // Load worklet via Blob URL — works without an HTTP server.
            const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
            const url  = URL.createObjectURL(blob);
            await this.audioContext.audioWorklet.addModule(url);
            URL.revokeObjectURL(url);

            this.audioWorkletNode = new AudioWorkletNode(
                this.audioContext,
                'cpc-audio-processor',
                { numberOfOutputs: 1, outputChannelCount: [2] }
            );
            this.audioWorkletNode.connect(this.audioContext.destination);

            if (this._bus?.volume != null) {
                this.k = this._getVolume();
            }

            this.isInitialized = true;
            return true;
        } catch (e) {
            console.error('[Audio_Output.init]', e);
            return false;
        } finally {
            this._initPromise = null;
        }
        })();
        return this._initPromise;
    },

    /**
     * Ensures the AudioContext is initialised and resumes it if suspended.
     * Must be called from a user-gesture handler to satisfy browser autoplay policy.
     *
     * @returns {Promise<void>}
     */
    Resume: async function () {
        if (!this.isInitialized) await this.init();
        if (this.audioContext?.state === 'suspended') await this.audioContext.resume();
    },

    /**
     * Resets the sample accumulator, flushes the output queue, and instructs
     * the AudioWorklet to clear its ring buffer.
     *
     * @returns {void}
     */
    reset() {
        this._smpAcc = 0;
        this._qIdx   = 0;
        if (this.audioWorkletNode) {
            this.audioWorkletNode.port.postMessage({ type: MSG_RESET });
        }
    },

    // -------------------------------------------------------------------------
    // Audio tick — hot path, called 125 000 times/second
    // -------------------------------------------------------------------------

    /**
     * Advances the PSG clock by one machine cycle (8 µs at 4 MHz) and pushes
     * a stereo sample to the Worklet queue whenever the sample accumulator
     * crosses the sample period threshold.
     *
     * This method is called from the main emulation loop; keep it allocation-free.
     *
     * @returns {void}
     */
    executeTicks() {
        if (!this._getSoundEnabled() || !this.isInitialized) return;

        this._psgClock();

        this._smpAcc += 8;
        if (this._smpAcc >= this._smpThr) {
            this._smpAcc -= this._smpThr;
            this._getAudioOutput()?.call(this);
        }
    },

    // -------------------------------------------------------------------------
    // Audio output mix modes
    // -------------------------------------------------------------------------

    /**
     * Mono mix: averages PSG channels A, B, C and optionally adds the tape
     * signal, then applies the master gain before pushing an identical L+R pair.
     *
     * @returns {void}
     */
    Mono() {
        let s = (this._getChanA() + this._getChanB() + this._getChanC()) / 3;
        if (this._getMotorRelay()) {
            s += this._getTapeBitOut() === 1 ? 0.15 : -0.15;
        }
        s *= this.k;
        this._push(s, s);
    },

    /**
     * Stereo mix using the standard CPC ABC panorama:
     *   Left  = (A + B × 0.5) / 1.5
     *   Right = (C + B × 0.5) / 1.5
     *   Channel B is centred; A is hard-left, C is hard-right.
     *
     * The tape motor signal is added equally to both channels when active.
     * Master gain is applied before the push.
     *
     * @returns {void}
     */
    Stereo() {
        let l = (this._getChanA() + this._getChanB() * 0.5) / 1.5;
        let r = (this._getChanC() + this._getChanB() * 0.5) / 1.5;
        if (this._getMotorRelay()) {
            const tw = this._getTapeBitOut() === 1 ? 0.15 : -0.15;
            l += tw; r += tw;
        }
        l *= this.k;
        r *= this.k;
        this._push(l, r);
    },

    // -------------------------------------------------------------------------
    // Internal: batched flush to the AudioWorklet
    // -------------------------------------------------------------------------

    /**
     * Appends an interleaved L/R sample pair to the output queue.
     * When the queue is full, sends the entire batch to the AudioWorklet
     * via the MessagePort and resets the write index.
     *
     * @param {number} l - Left channel sample [-1..1].
     * @param {number} r - Right channel sample [-1..1].
     * @returns {void}
     */
    _push(l, r) {
        this._queue[this._qIdx++] = l;
        this._queue[this._qIdx++] = r;
        if (this._qIdx >= this._FLUSH_SIZE) {
            this.audioWorkletNode.port.postMessage({
                type: MSG_SAMPLES,
                data: this._queue.slice(0, this._qIdx)
            });
            this._qIdx = 0;
        }
    }
};
