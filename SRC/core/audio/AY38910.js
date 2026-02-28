"use strict";

/**
 * @module PSG_Sound_AY38910
 * @description Pure silicon emulation of the General Instrument AY-3-8910
 * Programmable Sound Generator (PSG).
 *
 * No external dependencies (no jQuery, no DOM, no WebAudio).
 * Reusable in any project targeting the AY-3-8910 (Atari ST, MSX, ZX Spectrum…).
 *
 * Dependencies are injected via {@link PSG_Sound_AY38910.link} (wired in CPC_Bus.js):
 *   - `getPpiPortC`    {Function} → returns PPI_8255.portC (bits 7:6 = PSG mode)
 *   - `readKeyboardRow`{Function} → Keyboard_Manager.readMatrixRow()
 *
 * Output produced each {@link PSG_Sound_AY38910.Clock_Cycle}:
 *   - `Output_ChanA`, `Output_ChanB`, `Output_ChanC` — floats in [0..1]
 *   consumed by WebAudioHost.js.
 */
const PSG_Sound_AY38910 = {

    /** @type {null} Legacy bus reference kept for backward compatibility. */
    _bus: null,

    /** @type {Function|null} Returns the current value of PPI Port C. */
    _getPpiPortC    : null,
    /** @type {Function|null} Returns the currently scanned keyboard matrix row. */
    _readKeyboardRow: null,

    /**
     * Injects external dependencies from a bus object.
     * Falls back to `_bus` legacy properties if bus methods are absent.
     * @param {Object} bus - Dependency container from CPC_Bus.js.
     * @param {Function} [bus.getPpiPortC]     - Returns PPI Port C value.
     * @param {Function} [bus.readKeyboardRow] - Returns keyboard matrix row.
     */
    link(bus) {
        if (bus.getPpiPortC)     this._getPpiPortC     = bus.getPpiPortC;
        if (bus.readKeyboardRow) this._readKeyboardRow = bus.readKeyboardRow;
        if (!this._getPpiPortC && this._bus)     this._getPpiPortC     = () => this._bus.ppiPortC;
        if (!this._readKeyboardRow && this._bus) this._readKeyboardRow = () => this._readKeyboardRow();
    },

    /**
     * AY-3-8910 internal registers R0–R15.
     * @type {Uint8Array}
     */
    Regs_Main : new Uint8Array(16),

    /**
     * Valid bit masks for each register R0–R15.
     * Writes are AND-masked before storage to match hardware behaviour.
     * @type {Uint8Array}
     */
    Reg_Masks : new Uint8Array([255, 15, 255, 15, 255, 15, 31, 255, 31, 31, 31, 255, 255, 15, 255, 255]),

    /**
     * Current tone period for channels A (0), B (1), C (2).
     * Minimum value is 1 to avoid division-by-zero.
     * @type {Int32Array}
     */
    chanPeriods     : new Int32Array([1, 1, 1]),

    /**
     * Period counters for each tone channel.
     * Incremented each clock; reset to 0 when it reaches chanPeriods[ch].
     * @type {Int32Array}
     */
    chanCounters    : new Int32Array(3),

    /**
     * Square-wave toggle state for each channel (0 or 1).
     * XOR'd with 1 each time the counter wraps.
     * @type {Int32Array}
     */
    chanToggles     : new Int32Array(3),

    /**
     * Tone-enable flags per channel (1 = enabled, 0 = muted).
     * Derived from R7 bits 2:0 (inverted).
     * @type {Uint8Array}
     */
    chanToneEnable  : new Uint8Array(3),

    /**
     * Noise-enable flags per channel (1 = enabled, 0 = no noise).
     * Derived from R7 bits 5:3 (inverted).
     * @type {Uint8Array}
     */
    chanNoiseEnable : new Uint8Array(3),

    /**
     * Envelope-driven volume flags per channel (1 = volume from envelope).
     * Set by bit 4 of R8/R9/R10.
     * @type {Uint8Array}
     */
    chanMixerEnable : new Uint8Array(3),

    /**
     * Fixed linear volume for each channel [0..1] when not driven by envelope.
     * Mapped via Volume_Log_Table from R8/R9/R10 bits 3:0.
     * @type {Float32Array}
     */
    chanVolumes     : new Float32Array(3),

    /**
     * Official AY-3-8910 logarithmic volume table (16 levels, ≈+1.5 dB/step).
     * Maps a 4-bit volume register value to a linear amplitude in [0..1].
     * @type {Float32Array}
     */
    Volume_Log_Table: new Float32Array([
        0.0000, 0.0104, 0.0147, 0.0208, 0.0294, 0.0415, 0.0587, 0.0830,
        0.1173, 0.1658, 0.2344, 0.3312, 0.4681, 0.6617, 0.9352, 1.0000
    ]),

    /** Index of the currently selected register (0–15). @type {number} */
    Sel_Reg_Index: 0,

    /** Mixed output for channel A, range [0..1]. Consumed by WebAudioHost. @type {number} */
    Output_ChanA: 0,
    /** Mixed output for channel B, range [0..1]. @type {number} */
    Output_ChanB: 0,
    /** Mixed output for channel C, range [0..1]. @type {number} */
    Output_ChanC: 0,

    /**
     * Noise LFSR seed — 17-bit linear feedback shift register.
     * Polynomial x^17 + x^14 + 1 produces a pseudo-random bit stream.
     * @type {number}
     */
    Noise_Seed: 0x1FFFF,

    /**
     * Noise generator state.
     * @type {{Noise_Output_Bit: number, Counter_Val: number, Period: number}}
     */
    Noise_Gen : { Noise_Output_Bit: 0, Counter_Val: 0, Period: 1 },

    /**
     * Envelope generator state.
     * Implements the 4-bit CONT/ATT/ALT/HOLD shape control (R13).
     * @type {{Volume_Level:number, Counter_Val:number, Envelope_Period:number,
     *          Update_Cycles:number, Env_Shape_Continue:boolean,
     *          Env_Shape_Attack:boolean, Env_Shape_Alternate:boolean,
     *          Env_Shape_Hold:boolean}}
     */
    Envelope_Gen: {
        Volume_Level      : 0,
        Counter_Val       : 0,
        Envelope_Period   : 1,
        Update_Cycles     : 0,
        Env_Shape_Continue  : false,
        Env_Shape_Attack    : false,
        Env_Shape_Alternate : false,
        Env_Shape_Hold      : false
    },

    /** I/O Port A direction (0 = output, 1 = input). @type {number} */
    IO_Port_A_Dir: 0,
    /** I/O Port B direction (0 = output, 1 = input). @type {number} */
    IO_Port_B_Dir: 0,

    /**
     * Resets all PSG registers and generator states to power-on defaults.
     * Writes 0 to all registers through the normal write path
     * so all derived state is also cleared.
     */
    reset() {
        this.Sel_Reg_Index = 0;
        this.Noise_Seed    = 0x1FFFF;

        this.chanPeriods.fill(1);
        this.chanCounters.fill(0);
        this.chanToggles.fill(0);
        this.chanToneEnable.fill(0);
        this.chanNoiseEnable.fill(0);
        this.chanMixerEnable.fill(0);
        this.chanVolumes.fill(0);

        this.Output_ChanA = this.Output_ChanB = this.Output_ChanC = 0;
        this.Envelope_Gen.Counter_Val   = 0;
        this.Envelope_Gen.Update_Cycles = 0;

        for (let i = 0; i < 16; i++) { this.Select_Register(i); this.Write_Register(0); }
    },

    /**
     * Selects the active register for subsequent reads/writes.
     * Only the lower 4 bits are used (mirrors the AY-3-8910 hardware).
     * @param {number} idx - Register index (0–15).
     */
    Select_Register(idx) {
        this.Sel_Reg_Index = idx & 0x0F;
    },

    /**
     * Writes a value to the currently selected register and updates
     * all derived state (periods, mixer flags, envelope shape…).
     *
     * Register map summary:
     *   R0/R1  → Channel A period (12-bit, fine/coarse)
     *   R2/R3  → Channel B period
     *   R4/R5  → Channel C period
     *   R6     → Noise period (5-bit)
     *   R7     → Mixer control (tone/noise enable per channel, I/O directions)
     *   R8–R10 → Channel volumes (4-bit + envelope flag)
     *   R11/R12→ Envelope period (16-bit)
     *   R13    → Envelope shape (CONT/ATT/ALT/HOLD)
     *
     * @param {number} val - 8-bit value to write.
     */
    Write_Register(val) {
        const idx = this.Sel_Reg_Index;
        this.Regs_Main[idx] = val & this.Reg_Masks[idx];

        switch (idx) {
            case 0: case 1: case 2: case 3: case 4: case 5: {
                const ch  = idx >> 1;
                const per = (this.Regs_Main[ch * 2 + 1] << 8) | this.Regs_Main[ch * 2];
                this.chanPeriods[ch] = per || 1;
                break;
            }
            case 6: {
                const p = this.Regs_Main[6] & 31;
                this.Noise_Gen.Period = p ? p << 1 : 1;
                break;
            }
            case 7:
                this.chanToneEnable[0]  = (val & 0x01) ? 0 : 1;
                this.chanToneEnable[1]  = (val & 0x02) ? 0 : 1;
                this.chanToneEnable[2]  = (val & 0x04) ? 0 : 1;
                this.chanNoiseEnable[0] = (val & 0x08) ? 0 : 1;
                this.chanNoiseEnable[1] = (val & 0x10) ? 0 : 1;
                this.chanNoiseEnable[2] = (val & 0x20) ? 0 : 1;
                this.IO_Port_A_Dir = !!(val & 0x40);
                this.IO_Port_B_Dir = !!(val & 0x80);
                break;
            case 8: case 9: case 10: {
                const ch = idx - 8;
                this.chanMixerEnable[ch] = (val & 0x10) ? 1 : 0;
                this.chanVolumes[ch]     = this.Volume_Log_Table[val & 0x0F];
                break;
            }
            case 11: case 12:
                this.Envelope_Gen.Envelope_Period =
                    ((this.Regs_Main[12] << 8) | this.Regs_Main[11]) || 1;
                break;
            case 13: {
                const env             = this.Envelope_Gen;
                env.Counter_Val       = 0;
                env.Update_Cycles     = 0;
                env.Env_Shape_Continue  = !!(val & 0x08);
                env.Env_Shape_Attack    = !!(val & 0x04);
                env.Env_Shape_Alternate = !!(val & 0x02);
                env.Env_Shape_Hold      = !!(val & 0x01);
                env.Volume_Level        = env.Env_Shape_Attack ? 0 : 15;
                break;
            }
        }
    },

    /**
     * Reads the value exposed on the PSG data bus according to the current
     * PPI Port C mode bits (7:6).
     * Mode 01 (read): returns the selected register value.
     * Register 14 (Port A input) returns the keyboard matrix row.
     * Any other mode returns 0xFF (bus floating).
     * @returns {number} 8-bit value.
     */
    readPort() {
        if ((this._getPpiPortC() >>> 6) !== 1) return 0xFF;
        if (this.Sel_Reg_Index === 14) return this._readKeyboardRow();
        return this.Regs_Main[this.Sel_Reg_Index];
    },

    /**
     * Processes a write on the PSG data bus.
     * PPI Port C bits 7:6 determine the operation:
     *   10 → write to selected register
     *   11 → select a new register
     * @param {number} val - 8-bit value from Port A of the PPI.
     */
    writePort(val) {
        const mode = this._getPpiPortC() >>> 6;
        if      (mode === 2) this.Write_Register(val);
        else if (mode === 3) this.Select_Register(val);
    },

    /**
     * DMA write path used by the CPC+ ASIC DMA controller.
     * Saves the current register selection, writes the target register,
     * then restores the selection — invisible to the CPU.
     * @param {number} reg - Target register index (0–15).
     * @param {number} val - 8-bit value to write.
     */
    writeFromDMA(reg, val) {
        const saved = this.Sel_Reg_Index;
        this.Select_Register(reg);
        this.Write_Register(val);
        this.Sel_Reg_Index = saved;
    },

    /**
     * Compatibility alias for external parsers and debugger.
     * @param {number} val - Register index.
     */
    selectRegisterPSG(val) { this.Select_Register(val); },

    /**
     * Compatibility alias for external parsers and debugger.
     * @param {number} val - Value to write.
     */
    writeRegisterPSG(val)  { this.Write_Register(val);  },

    /**
     * Advances all PSG generators by one clock step (8 µs at 1 MHz AY clock,
     * i.e. called at 125 kHz from WebAudioHost.executeTicks()).
     *
     * Execution order each step:
     *   1. **Tone generators** — three independent square-wave dividers.
     *      Each counter is incremented; when it reaches its period the
     *      square-wave output bit is toggled.
     *   2. **Noise LFSR** — 17-bit Galois LFSR with polynomial x^17 + x^14 + 1.
     *      Each step XORs bit 0 with bit 3 and shifts right; the output bit
     *      is the value shifted out of bit 0.
     *   3. **Envelope generator** — 16-step ramp shaped by CONT/ATT/ALT/HOLD.
     *      The ramp advances by one level each Envelope_Period steps.
     *      Boundary behaviour is controlled by the four shape bits in R13.
     *   4. **Mixer** — for each channel the tone and noise signals are
     *      AND-combined according to their enable flags, then multiplied by
     *      either the envelope volume or the fixed channel volume.
     *      Results are written to Output_ChanA/B/C.
     *
     * Hot-path optimisations:
     *   - Typed-array (Int32Array) access for tone counters/periods/toggles
     *     is ~2× faster than plain object property access at 125 kHz.
     *   - Mixer is inlined three times (one per channel) to avoid closure
     *     allocation and three extra function calls per step.
     */
    Clock_Cycle() {
        const cntrs = this.chanCounters;
        const prds  = this.chanPeriods;
        const tgls  = this.chanToggles;

        if (++cntrs[0] >= prds[0]) { cntrs[0] = 0; tgls[0] ^= 1; }
        if (++cntrs[1] >= prds[1]) { cntrs[1] = 0; tgls[1] ^= 1; }
        if (++cntrs[2] >= prds[2]) { cntrs[2] = 0; tgls[2] ^= 1; }

        const ng = this.Noise_Gen;
        if (++ng.Counter_Val >= ng.Period) {
            ng.Counter_Val = 0;
            const bit0 = this.Noise_Seed & 1;
            const bit3 = (this.Noise_Seed >>> 3) & 1;
            ng.Noise_Output_Bit = bit0;
            this.Noise_Seed = (this.Noise_Seed >>> 1) | ((bit0 ^ bit3) << 16);
        }

        const env = this.Envelope_Gen;
        if (++env.Update_Cycles >= env.Envelope_Period) {
            env.Update_Cycles = 0;
            env.Counter_Val++;

            if (env.Counter_Val > 15) {
                if (!env.Env_Shape_Continue) {
                    env.Volume_Level = 0;
                    env.Counter_Val  = 16;
                } else if (env.Env_Shape_Hold) {
                    env.Volume_Level = env.Env_Shape_Alternate
                        ? (env.Env_Shape_Attack ? 0 : 15)
                        : (env.Env_Shape_Attack ? 15 : 0);
                    env.Counter_Val = 16;
                } else {
                    if (env.Env_Shape_Alternate) env.Env_Shape_Attack = !env.Env_Shape_Attack;
                    env.Counter_Val = 0;
                }
            }

            if (env.Counter_Val < 16) {
                env.Volume_Level = env.Env_Shape_Attack
                    ? env.Counter_Val
                    : 15 - env.Counter_Val;
            }
        }

        const envVol = this.Volume_Log_Table[env.Volume_Level];
        const noiseB = ng.Noise_Output_Bit;
        const tones  = this.chanToneEnable;
        const noises = this.chanNoiseEnable;
        const mixers = this.chanMixerEnable;
        const vols   = this.chanVolumes;

        const sigA = (tones[0] ? tgls[0] : 1) & (noises[0] ? noiseB : 1);
        this.Output_ChanA = sigA ? (mixers[0] ? envVol : vols[0]) : 0;

        const sigB = (tones[1] ? tgls[1] : 1) & (noises[1] ? noiseB : 1);
        this.Output_ChanB = sigB ? (mixers[1] ? envVol : vols[1]) : 0;

        const sigC = (tones[2] ? tgls[2] : 1) & (noises[2] ? noiseB : 1);
        this.Output_ChanC = sigC ? (mixers[2] ? envVol : vols[2]) : 0;
    }
};
