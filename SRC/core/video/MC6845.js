/**
 * @module CRTC_Controller
 * @description Emulation of the Motorola MC6845 Cathode Ray Tube Controller and compatible variants.
 *
 * Architecture:
 *  - CRTC_Manager   — polymorphic dispatcher; routes all calls to the active CRTC type
 *  - CRTC_Type0     — Hitachi HD6845S  (CPC 464/664, some 6128 units)
 *  - CRTC_Type1     — UM6845R          (most CPC 6128, GX4000)
 *  - CRTC_Type2     — MC6845           (CPC+ internal ASIC)
 *  - CRTC_Type3     — CPC+ advanced ASIC (split screen, HScroll)
 *
 * The active type is selected by CRTC_Manager.P(CRTCTypeX), which copies all
 * type-varying methods into CRTC_Manager for direct dispatch with no virtual call overhead.
 *
 * CRTC Registers R0–R17:
 *  R0  Horizontal Total           — total line width in characters
 *  R1  Horizontal Displayed       — visible character columns
 *  R2  HSync Position             — column at which HSync pulse begins
 *  R3  HSync + VSync Width        — high nibble = VSync width (lines), low nibble = HSync width (chars)
 *  R4  Vertical Total             — total frame height in character rows
 *  R5  Vertical Total Adjust      — extra raster lines appended after the last full character row
 *  R6  Vertical Displayed         — visible character rows
 *  R7  VSync Position             — character row at which VSync fires
 *  R8  Interlace & Skew           — bits 1-0 = interlace mode, bits 5-4 = border skew delay (Type0/3)
 *  R9  Max Raster Address         — raster lines per character row minus one
 *  R10/R11 Cursor Start/End       — not used on CPC
 *  R12/R13 Display Start Address  — high/low bytes of the frame base address in VRAM
 *  R14/R15 Cursor Address         — read-only cursor position
 *  R16/R17 Light Pen Address      — read-only light pen latch
 *
 * JIT monomorphism optimisation:
 *  All scalar properties are initialised to their final runtime types (0 for integers,
 *  false for booleans) rather than null. This allows V8/SpiderMonkey to assign a stable
 *  hidden class to CRTC_Manager at construction time. The CRTC tick runs ~4 million
 *  times per second, so eliminating hidden-class transitions from null→number significantly
 *  reduces deoptimisation overhead on the hot path.
 *  Polymorphic function slots (tick, write, etc.) remain null because their type
 *  (Function) does not change — only their value changes — so the engine can optimise
 *  them via a separate "callable" inline cache.
 */

"use strict";

/**
 * Default CRTC type for each machine model.
 * Values correspond to the radio-button identifiers in the settings modal.
 * 464/664 use the HD6845S (Type1); 6128 uses UM6845R (Type2); CPC+ uses the ASIC (Type3).
 * @type {Object.<string, string>}
 */
const DEFAULT_CRTC = {
    boot_cpc464:   'type1',
    boot_cpc664:   'type1',
    boot_cpc6128:  'type2',
    boot_464plus:  'type3',
    boot_6128plus: 'type3',
};


// ===============================================================================
// CRTC_Manager — Polymorphic dispatcher
// ===============================================================================

/**
 * @namespace CRTC_Manager
 * @description Central CRTC object that acts as a polymorphic dispatcher.
 * The active type's methods are copied in wholesale via {@link CRTC_Manager.P},
 * so every call (tick, write, read, etc.) dispatches at the cost of a single
 * property lookup with no intermediate virtual table.
 */
const CRTC_Manager = {

    /** @type {Function|null} Injected callback — feeds a byte to the ASIC unlock sequence. */
    _feedUnlock     : null,
    /** @type {Function|null} Injected getter — returns ASIC horizontal scroll offset (0–7). */
    _getAsicHScroll : null,
    /** @type {Function|null} Injected getter — returns ASIC split-screen trigger line. */
    _getAsicSplitLine: null,
    /** @type {Function|null} Injected getter — returns ASIC split-screen start address high byte. */
    _getAsicSsaHigh : null,
    /** @type {Function|null} Injected getter — returns ASIC split-screen start address low byte. */
    _getAsicSsaLow  : null,
    /** @type {Function|null} Injected getter — returns ASIC soft-scroll control register. */
    _getAsicSscr    : null,
    /** @type {Function|null} Injected callback — renders the ASIC split-screen segment. */
    _renderAsicSplit: null,

    /** @type {number} Active machine model index (2 = CPC 6128, 4–5 = CPC+). */
    machineType: 2,

    /**
     * Wires dependencies from the central bus into this module.
     * @param {Object} bus - Dependency container built by CPC_Bus.
     * @param {number}   [bus.machineType]       - Active machine model index.
     * @param {Function} [bus.feedUnlock]        - ASIC unlock-sequence feeder.
     * @param {Function} [bus.getAsicHScroll]    - ASIC HScroll getter.
     * @param {Function} [bus.getAsicSplitLine]  - ASIC split-screen line getter.
     * @param {Function} [bus.getAsicSsaHigh]    - ASIC split-screen address high getter.
     * @param {Function} [bus.getAsicSsaLow]     - ASIC split-screen address low getter.
     * @param {Function} [bus.getAsicSscr]       - ASIC soft-scroll control getter.
     * @param {Function} [bus.renderAsicSplit]   - ASIC split-screen renderer.
     */
    link(bus) {
        if ('machineType'    in bus) this.machineType      = bus.machineType;
        if (bus.feedUnlock)           this._feedUnlock      = bus.feedUnlock;
        if (bus.getAsicHScroll)       this._getAsicHScroll  = bus.getAsicHScroll;
        if (bus.getAsicSplitLine)     this._getAsicSplitLine = bus.getAsicSplitLine;
        if (bus.getAsicSsaHigh)       this._getAsicSsaHigh  = bus.getAsicSsaHigh;
        if (bus.getAsicSsaLow)        this._getAsicSsaLow   = bus.getAsicSsaLow;
        if (bus.getAsicSscr)          this._getAsicSscr     = bus.getAsicSscr;
        if (bus.renderAsicSplit)      this._renderAsicSplit  = bus.renderAsicSplit;
    },

    /**
     * CRTC register file R0–R17.
     * Each type defines a `crtcMasks` array that is AND-ed with written values
     * to discard unimplemented bits per the hardware spec.
     * @type {Uint8Array}
     */
    registers        : new Uint8Array(18),

    /** @type {number} Index of the currently selected CRTC register (0–31). */
    selectedRegister : 0,

    /**
     * Latched copy of R4 (Vertical Total) captured at the start of each character row.
     * Types 0/2/3 snapshot R4/R5/R9 at row start so mid-frame writes take effect next frame.
     * @type {number}
     */
    r4_vt  : 0,
    /**
     * Latched copy of R5 (Vertical Total Adjust) — extra raster lines after the last full row.
     * @type {number}
     */
    r5_vta : 0,
    /**
     * Latched copy of R9 (Max Raster Address) — raster lines per character row minus one.
     * @type {number}
     */
    r9_mra : 0,

    /**
     * Vertical Character Counter — counts complete character rows (0 → R4).
     * Triggers VSync when it matches R7.
     * @type {number}
     */
    vcc         : 0,
    /**
     * Raw Vertical Line Counter as maintained by the CRTC hardware (0 → R9).
     * @type {number}
     */
    vlc_crtc    : 0,
    /**
     * Adjusted VLC used by the display pipeline.
     * On Type3, this is (vlc_crtc + asicHScroll) & 31 to implement vertical soft-scroll.
     * @type {number}
     */
    vlc         : 0,
    /**
     * Vertical Total Adjust Counter — counts the extra raster lines defined by R5.
     * @type {number}
     */
    vtac_counter: 0,
    /**
     * VSync duration counter — counts raster lines inside the vertical sync pulse.
     * Reset when it matches the VSync width field of R3.
     * @type {number}
     */
    vsc_counter : 0,
    /**
     * Horizontal Character Counter — counts character clocks per line (0 → R0).
     * @type {number}
     */
    hcc_counter : 0,
    /**
     * HSync pulse width counter — counts character clocks inside the horizontal sync pulse.
     * @type {number}
     */
    hsyncCounter: 0,

    /** @type {boolean} True while the beam is in the vertical blanking interval (VTA phase). */
    vblankActive : false,
    /** @type {boolean} True while the vertical sync pulse is asserted. */
    vsyncActive  : false,
    /** @type {boolean} True while the horizontal sync pulse is asserted. */
    hsyncActive  : false,
    /**
     * Interlace mode selection from R8 bits 1–0.
     * 0 = no interlace, 1 = interlace sync only, 3 = interlace sync+video.
     * @type {number}
     */
    interlaceMode: 0,

    /**
     * Computed border flag — true when the beam is in the border (non-display) region.
     * Supplied to the Gate Array to determine pixel vs. border colour output.
     * @type {boolean}
     */
    border : false,
    /** @type {boolean} True when the beam is within the vertical display window (vcc < R6). */
    vdisp  : false,
    /** @type {boolean} True when the beam is within the horizontal display window (hcc < R1). */
    hdisp  : false,
    /** @type {boolean} Border pipeline delay register — 1-clock-delayed border signal (Type0/3 skew). */
    border1: false,
    /** @type {boolean} Border pipeline delay register — 2-clock-delayed border signal. */
    border2: false,
    /** @type {boolean} Border pipeline delay register — 3-clock-delayed border signal. */
    border3: false,

    /**
     * Frame base address latched at the start of each frame (R12<<8 | R13).
     * Used to reset `maRow` at the beginning of every new display frame.
     * @type {number}
     */
    startAddress: 0,
    /**
     * Current VRAM address of the character being rendered in this clock cycle.
     * Increments each character clock; used by GateArray to fetch pixel data.
     * @type {number}
     */
    maRow       : 0,
    /**
     * Half the horizontal total (R0 >> 1) — pre-computed to avoid a shift on every tick.
     * Used as a fast midpoint reference for split-screen address comparisons.
     * @type {number}
     */
    charWidth   : 0,

    /**
     * Type-specific internal state variable 1 (integer).
     * Semantics differ per CRTC type; kept in CRTC_Manager for the monomorphic shape.
     * @type {number}
     */
    internalState1: 0,
    /**
     * Type-specific internal state variable 2 (boolean).
     * @type {boolean}
     */
    internalState2: false,
    /**
     * Type-specific internal state variable 3 (integer).
     * @type {number}
     */
    internalState3: 0,

    /**
     * Per-register write-mask array injected by the active CRTC type.
     * Bits set to 0 are read-only or unimplemented on that hardware variant.
     * @type {Uint8Array|null}
     */
    crtcMasks     : null,
    /** @type {Function|null} Active type's register-select handler. */
    select        : null,
    /** @type {Function|null} Active type's register-write handler. */
    write         : null,
    /** @type {Function|null} Active type's register-read handler. */
    read          : null,
    /** @type {Function|null} Active type's status-port read handler. */
    status        : null,
    /** @type {Function|null} Active type's vertical-counter advancement routine. */
    updateVertical: null,
    /** @type {Function|null} Active type's custom read handler (Type3 extended reads). */
    customReadHandler   : null,
    /** @type {Function|null} Active type's per-character-clock tick routine. */
    tick          : null,
    /** @type {Function|null} Active type's HSync width update routine. */
    updateHsync   : null,
    /** @type {Function|null} Active type's HSync trigger check routine. */
    checkHsync    : null,
    /** @type {Function|null} Active type's border/skew computation routine. */
    renderBorder  : null,

    /**
     * Refreshes the debugger UI panel with current register and counter values.
     * Highlights the selected register and active sync/border flags.
     */
    updateUI() {
        for (let i = 0; i <= 17; i++) {
            $(`#crtc_r${i}`).text(toHex8(this.registers[i])).removeClass("dasm-selected");
        }
        $(`#crtc_r${this.selectedRegister}`).addClass("dasm-selected");
        $("#crtc_vcc").text(toHex8(this.vcc));
        $("#crtc_vlc").text(toHex8(this.vlc_crtc));
        $("#crtc_vsc").text(toHex8(this.vsc_counter));
        $("#crtc_vtac").text(toHex8(this.vtac_counter));
        $("#crtc_hcc").text(toHex8(this.hcc_counter));
        $("#crtc_hsc").text(toHex8(this.hsyncCounter));

        this.hsyncActive  ? $("#crtc_hsc").addClass("dasm-selected")  : $("#crtc_hsc").removeClass("dasm-selected");
        this.vsyncActive  ? $("#crtc_vsc").addClass("dasm-selected")  : $("#crtc_vsc").removeClass("dasm-selected");
        this.vblankActive ? $("#crtc_vtac").addClass("dasm-selected") : $("#crtc_vtac").removeClass("dasm-selected");
        this.border ? $("#border").attr("checked", "checked") : $("#border").removeAttr("checked");
    },

    /**
     * Resets all CRTC registers and internal counters to power-on state.
     * Called on machine reset and when loading a snapshot.
     */
    reset() {
        this.registers.fill(0);
        this.selectedRegister = 0;
        this.vlc = this.vlc_crtc = this.vcc = 0;
        this.r9_mra = this.r5_vta = this.r4_vt = 0;
        this.vblankActive = false;
        this.vtac_counter = 0;
        this.vsyncActive  = false;
        this.vsc_counter  = 0;
        this.hcc_counter  = 0;
        this.hsyncCounter = 0;
        this.hsyncActive  = false;
        this.interlaceMode = 0;
        this.border = this.border1 = this.border2 = this.border3 = false;
        this.vdisp = this.hdisp = false;
        this.maRow = this.internalState1 = this.startAddress = 0;
        this.internalState2 = false;
        this.internalState3 = 0;
    },

    /**
     * Handles Z80 IN instructions targeting the CRTC address range.
     * Address bits 9–8 select the operation:
     *   0x02 (bit 1 set) → status port read
     *   0x03 (bits 1–0 set) → data register read
     * @param {number} addr - 16-bit I/O address.
     * @returns {number|null} Register value or null if address not decoded.
     */
    readPort(addr) {
        switch ((addr >>> 8) & 0x43) {
            case 2: return this.status();
            case 3: return this.read();
        }
        return null;
    },

    /**
     * Handles Z80 OUT instructions targeting the CRTC address range.
     * Address bits 9–8 select the operation:
     *   0x00 → select register (address register write)
     *   0x01 → write data to selected register
     * @param {number} addr - 16-bit I/O address.
     * @param {number} data - 8-bit value to write.
     */
    writePort(addr, data) {
        switch ((addr >>> 8) & 0x43) {
            case 0: this.select(data); break;
            case 1: this.write(data);  break;
        }
    },

    /**
     * Activates a CRTC type by copying all of its variant methods into this object.
     * After this call, tick/write/read/etc. dispatch directly to the chosen implementation
     * with no extra indirection, keeping the call site monomorphic.
     * @param {Object} crtcType - One of CRTC_Type0, CRTC_Type1, CRTC_Type2, or CRTC_Type3.
     */
    P(crtcType) {
        this.crtcMasks     = crtcType.crtcMasks;
        this.select        = crtcType.select;
        this.write         = crtcType.write;
        this.read          = crtcType.read;
        this.status        = crtcType.status;
        this.updateVertical = crtcType.updateVertical;
        this.customReadHandler    = crtcType.customReadHandler;
        this.tick          = crtcType.tick;
        this.updateHsync   = crtcType.updateHsync;
        this.checkHsync    = crtcType.checkHsync;
        this.renderBorder  = crtcType.renderBorder;
    }
};


// ===============================================================================
// CRTC_Type0 — Hitachi HD6845S
// ===============================================================================
//
// Found in CPC 464 and some CPC 664/6128 units.
// Key characteristics:
//   - R3 high nibble controls VSync width (programmable, unlike Type1/2).
//   - Border skew pipeline: R8 bits 5–4 delay the border flag by 0–2 character clocks,
//     or force the border permanently (value 3).
//   - Register mirrors r4_vt/r5_vta/r9_mra are snapshotted at the end of each frame
//     so that mid-frame writes to R4/R5/R9 take effect on the following frame.
//   - Readable registers: R12–R17 only.

/**
 * @namespace CRTC_Type0
 * @description Hitachi HD6845S CRTC variant — CPC 464/664.
 */
const CRTC_Type0 = {

    /**
     * Per-register write masks. Bits set to 0 are unimplemented on this hardware.
     * @type {Uint8Array}
     */
    crtcMasks: new Uint8Array([255, 255, 255, 255, 127, 31, 127, 127, 243, 31, 127, 31, 63, 255, 63, 255, 63, 255]),

    /**
     * Selects the active register and, on CPC+ machines, feeds the byte to the ASIC
     * unlock sequence (which monitors CRTC select writes for its magic pattern).
     * @param {number} val - Value written to the CRTC address port; bits 4–0 select R0–R17.
     */
    select(val) {
        this.selectedRegister = val & 31;
        if (this.machineType >= 4) this._feedUnlock(val);
    },

    /**
     * Writes a value to the currently selected register, masked by `crtcMasks`.
     * Side effects:
     *   - R0: updates `charWidth` pre-computation (R0 >> 1).
     *   - R6: immediately asserts `vdisp` if `vcc` already equals the new R6.
     *   - R7: immediately asserts `vsyncActive` if `vcc` matches the new R7.
     *   - R8: updates `interlaceMode` from bits 1–0.
     * @param {number} val - 8-bit value to write.
     */
    write(val) {
        if (this.selectedRegister < 18) {
            this.registers[this.selectedRegister] = val & this.crtcMasks[this.selectedRegister];
        }
        switch (this.selectedRegister) {
            case 0: this.charWidth = this.registers[0] >>> 1; break;
            case 6: if (this.vcc === this.registers[6]) this.vdisp = true;  break;
            case 7: if (this.vcc === this.registers[7]) this.vsyncActive = true; break;
            case 8: this.interlaceMode = val & 1; break;
        }
    },

    /**
     * Reads a register value. Type0 exposes only R12–R17.
     * All other register indices return 0.
     * @returns {number} Register value or 0 for write-only/unimplemented registers.
     */
    read() {
        switch (this.selectedRegister) {
            case 12: case 13: case 14: case 15: case 16: case 17:
                return this.registers[this.selectedRegister];
            default: return 0;
        }
    },

    /**
     * Status port read — Type0 does not implement a status port.
     * @returns {null}
     */
    status() { return null; },

    /**
     * Advances all vertical counters at the end of each horizontal line.
     * Sequence:
     *   1. Increment VSync counter; deassert VSync when it reaches R3[7:4].
     *   2. Detect VTA entry (vlc_crtc == r9_mra && vcc == r4_vt) and activate vblank.
     *   3. On VTA completion (vtac_counter == r5_vta): reset frame, reload startAddress.
     *   4. Otherwise, if vlc_crtc == R9: advance to the next character row (increment vcc).
     *   5. Snapshot R4/R5/R9 mirrors for use in the next row.
     */
    updateVertical() {
        if (this.vsyncActive) {
            this.vsc_counter = (this.vsc_counter + 1) & 15;
            if (this.vsc_counter === (this.registers[3] >>> 4)) {
                this.vsyncActive = false;
                this.vsc_counter = 0;
            }
        }
        if (this.vblankActive) {
            this.vtac_counter = (this.vtac_counter + 1) & 31;
        } else if (this.vlc_crtc === this.r9_mra && this.vcc === this.r4_vt) {
            this.vblankActive = true;
            this.vtac_counter = 0;
        }
        if (this.vblankActive && this.vtac_counter === this.r5_vta) {
            this.vblankActive = false;
            this.vlc_crtc     = 0;
            this.startAddress = (this.registers[12] << 8) | this.registers[13];
            this.vdisp        = (this.registers[6] === 0);
            if (this.vcc !== 0) {
                this.vcc = 0;
                if (this.vcc === this.registers[7] && this.vsc_counter === 0) this.vsyncActive = true;
            }
        } else if (this.vlc_crtc === this.registers[9]) {
            this.vlc_crtc = 0;
            this.vcc = (this.vcc + 1) & 127;
            if (this.vcc === this.registers[6]) this.vdisp = true;
            if (this.vcc === this.registers[7] && this.vsc_counter === 0) this.vsyncActive = true;
        } else {
            this.vlc_crtc = (this.vlc_crtc + 1) & 31;
        }

        this.maRow  = this.startAddress;
        this.r4_vt  = this.registers[4];
        this.r5_vta = this.registers[5];
        this.r9_mra = this.registers[9];
        this.vlc    = this.vlc_crtc;
    },

    /**
     * Advances the CRTC by one character clock.
     * At hcc == R0: calls updateVertical(), resets hcc to 0, clears hdisp.
     * In interlace sync+video mode (R8 bits 1-0 == 3): also fires VSync when vlc_crtc == 0.
     * Otherwise: increments hcc and advances the VRAM address (maRow).
     * At hcc == R1: asserts hdisp (beam enters the horizontal display window).
     */
    tick() {
        if (this.hcc_counter === this.registers[0]) {
            this.updateVertical();
            if ((this.registers[8] & 3) === 3 && this.vlc_crtc === 0
                && this.vcc === this.registers[7] && this.vsc_counter === 0) {
                this.vsyncActive = true;
            }
            this.hcc_counter = 0;
            this.hdisp = false;
        } else {
            this.hcc_counter = (this.hcc_counter + 1) & 255;
            this.maRow = (this.maRow + 1) & 0x3FFF;
        }
        if (this.hcc_counter === this.registers[1]) this.hdisp = true;
    },

    /**
     * Updates the row start address and propagates the border signal through
     * a 3-stage shift register to implement the R8 skew delay.
     * R8 bits 5–4:
     *   0x00 — border with no delay (border = border1)
     *   0x10 — 1-clock delay       (border = border2)
     *   0x20 — 2-clock delay       (border = border3)
     *   0x30 — force border always (border = true)
     */
    renderBorder() {
        if (this.hcc_counter === this.registers[1] && this.vlc_crtc === this.registers[9]) {
            this.startAddress = this.maRow;
        }
        this.border3 = this.border2;
        this.border2 = this.border1;
        this.border1 = this.hdisp || this.vdisp;

        switch (this.registers[8] & 0x30) {
            case 0x00: this.border = this.border1; break;
            case 0x10: this.border = this.border2; break;
            case 0x20: this.border = this.border3; break;
            case 0x30: this.border = true;          break;
        }
    },

    /**
     * Increments the HSync width counter and deasserts HSync when the pulse
     * duration (R3 bits 3–0) has elapsed.
     */
    updateHsync() {
        if (this.hsyncActive) {
            this.hsyncCounter = (this.hsyncCounter + 1) & 15;
            if (this.hsyncCounter === (this.registers[3] & 15)) this.hsyncActive = false;
        }
    },

    /**
     * Asserts HSync if hcc reaches R2, HSync is not already active, and the
     * programmed width (R3 bits 3–0) is non-zero (width 0 disables HSync).
     */
    checkHsync() {
        if (this.hcc_counter === this.registers[2] && !this.hsyncActive && (this.registers[3] & 15) !== 0) {
            this.hsyncActive  = true;
            this.hsyncCounter = 0;
        }
    }
};


// ===============================================================================
// CRTC_Type1 — UM6845R
// ===============================================================================
//
// The most common CRTC found in CPC 6128 machines.
// Differences from Type0:
//   - R3 is masked to 4 bits; the VSync width is fixed at 16 lines (counter wraps at 0).
//   - Readable registers: R14–R17 only; R31 returns null (floating bus).
//   - status() returns vdisp in bit 5, used by some software for display timing.
//   - updateVertical: startAddress is NOT snapshotted; it is recalculated from R12/R13
//     whenever vcc == 0 (Type1 reloads the start address every new frame).
//   - tick: interlace mode calls updateVertical twice per line.

/**
 * @namespace CRTC_Type1
 * @description UM6845R CRTC variant — most CPC 6128 units and GX4000.
 */
const CRTC_Type1 = {

    /**
     * Per-register write masks. R3 is limited to 4 bits on this variant.
     * @type {Uint8Array}
     */
    crtcMasks: new Uint8Array([255, 255, 255, 15, 127, 31, 127, 127, 3, 31, 127, 31, 63, 255, 63, 255, 63, 255]),

    /**
     * Selects the active register and feeds ASIC unlock on CPC+ machines.
     * @param {number} val - Address port value; bits 4–0 index R0–R17.
     */
    select(val) {
        this.selectedRegister = val & 31;
        if (this.machineType >= 4) this._feedUnlock(val);
    },

    /**
     * Writes to the selected register with Type1 masks applied.
     * Side effects match Type0 (R0 charWidth, R6 vdisp, R7 vsync, R8 interlace).
     * @param {number} val - 8-bit data value.
     */
    write(val) {
        if (this.selectedRegister < 18) {
            this.registers[this.selectedRegister] = val & this.crtcMasks[this.selectedRegister];
        }
        switch (this.selectedRegister) {
            case 0: this.charWidth = this.registers[0] >>> 1; break;
            case 6: if (this.vcc === this.registers[6]) this.vdisp = true; break;
            case 7: if (this.vcc === this.registers[7]) this.vsyncActive = true; break;
            case 8: this.interlaceMode = val & 1; break;
        }
    },

    /**
     * Reads a register value. Type1 exposes R14–R17; R31 returns null (undriven bus).
     * @returns {number|null} Register value, 0 for write-only registers, or null for R31.
     */
    read() {
        switch (this.selectedRegister) {
            case 14: case 15: case 16: case 17: return this.registers[this.selectedRegister];
            case 31: return null;
            default: return 0;
        }
    },

    /**
     * Status port read — returns `vdisp` in bit 5.
     * Bit 5 is used by some games to detect the visible display area for timing purposes.
     * @returns {number} Status byte with bit 5 = vdisp.
     */
    status() { return this.vdisp << 5; },

    /**
     * Advances vertical counters at end of each horizontal line.
     * Type1 difference: VSync width counter wraps naturally at 0 (4-bit counter, no
     * comparison against R3 high nibble — VSync pulse is always 16 lines).
     * startAddress is recalculated from R12/R13 only when vcc transitions to 0,
     * rather than being snapshotted at frame end like Type0/2.
     */
    updateVertical() {
        if (this.vsyncActive) {
            this.vsc_counter = (this.vsc_counter + 1) & 15;
            if (this.vsc_counter === 0) { this.vsyncActive = false; this.vsc_counter = 0; }
        }
        if (this.vblankActive) {
            this.vtac_counter = (this.vtac_counter + 1) & 31;
        } else if (this.vlc_crtc === this.registers[9] && this.vcc === this.registers[4]) {
            this.vblankActive = true;
            this.vtac_counter = 0;
        }
        if (this.vblankActive && this.vtac_counter === this.registers[5]) {
            this.vblankActive = false;
            this.vlc_crtc     = 0;
            this.vdisp        = (this.registers[6] === 0);
            if (this.vcc !== 0) {
                this.vcc = 0;
                if (this.vcc === this.registers[7] && this.vsc_counter === 0) this.vsyncActive = true;
            }
        } else if (this.vlc_crtc === this.registers[9]) {
            this.vlc_crtc = 0;
            this.vcc = (this.vcc + 1) & 127;
            if (this.vcc === this.registers[6]) this.vdisp = true;
            if (this.vcc === this.registers[7] && this.vsc_counter === 0) this.vsyncActive = true;
        } else {
            this.vlc_crtc = (this.vlc_crtc + 1) & 31;
        }
        this.maRow = (this.vcc === 0)
            ? ((this.registers[12] << 8) | this.registers[13])
            : this.startAddress;
        this.vlc = this.vlc_crtc;
    },

    /**
     * Per-character-clock tick for Type1.
     * In interlace mode (R8 == 3), updateVertical is called twice per line to simulate
     * the doubled field rate, and an extra VSync check is performed.
     */
    tick() {
        if (this.hcc_counter === this.registers[0]) {
            this.updateVertical();
            if (this.registers[8] === 3) {
                this.updateVertical();
                if (this.vlc_crtc === 0 && this.vcc === this.registers[7] && this.vsc_counter === 0) {
                    this.vsyncActive = true;
                }
            }
            this.hcc_counter = 0;
            this.hdisp = false;
        } else {
            this.hcc_counter = (this.hcc_counter + 1) & 255;
            this.maRow = (this.maRow + 1) & 0x3FFF;
        }
        if (this.hcc_counter === this.registers[1]) this.hdisp = true;
    },

    /**
     * Updates row start address and border signal for Type1.
     * Type1 has no skew pipeline — the border signal is updated immediately:
     * border = hdisp OR vdisp OR (R6 == 0, meaning no vertical display area defined).
     */
    renderBorder() {
        if (this.hcc_counter === this.registers[1] && this.vlc_crtc === this.registers[9]) {
            this.startAddress = this.maRow;
        }
        this.border = this.hdisp || this.vdisp || (this.registers[6] === 0);
    },

    /**
     * Increments the HSync width counter; deasserts HSync when it reaches R3 (full 8 bits).
     */
    updateHsync() {
        if (this.hsyncActive) {
            this.hsyncCounter = (this.hsyncCounter + 1) & 15;
            if (this.hsyncCounter === this.registers[3]) this.hsyncActive = false;
        }
    },

    /**
     * Triggers HSync at hcc == R2 if not already active and R3 != 0.
     */
    checkHsync() {
        if (this.hcc_counter === this.registers[2] && !this.hsyncActive && this.registers[3] !== 0) {
            this.hsyncActive  = true;
            this.hsyncCounter = 0;
        }
    }
};


// ===============================================================================
// CRTC_Type2 — MC6845 (CPC+ internal ASIC)
// ===============================================================================
//
// Used as the internal CRTC in CPC+ machines.
// Differences from Type0:
//   - Register masks match Type1 (R3 limited to 4 bits).
//   - Readable registers: R14–R17 only (no R12/R13 read access, no R31 null).
//   - VSync trigger requires !hsyncActive: VSync cannot start while HSync is active.
//   - tick: hdisp is initialised to hsyncActive at line start instead of false,
//     meaning a line beginning mid-HSync carries over the prior HSync state.
//   - R4/R5/R9 mirrors are snapshotted (like Type0, unlike Type1).

/**
 * @namespace CRTC_Type2
 * @description MC6845 CRTC variant — CPC+ internal ASIC.
 */
const CRTC_Type2 = {

    /**
     * Per-register write masks — same as Type1.
     * @type {Uint8Array}
     */
    crtcMasks: new Uint8Array([255, 255, 255, 15, 127, 31, 127, 127, 3, 31, 127, 31, 63, 255, 63, 255, 63, 255]),

    /**
     * Selects the active register and feeds ASIC unlock on CPC+ machines.
     * @param {number} val - Address port value; bits 4–0 index R0–R17.
     */
    select(val) {
        this.selectedRegister = val & 31;
        if (this.machineType >= 4) this._feedUnlock(val);
    },

    /**
     * Writes to the selected register.
     * @param {number} val - 8-bit data value.
     */
    write(val) {
        if (this.selectedRegister < 18) {
            this.registers[this.selectedRegister] = val & this.crtcMasks[this.selectedRegister];
        }
        switch (this.selectedRegister) {
            case 0: this.charWidth = this.registers[0] >>> 1; break;
            case 6: if (this.vcc === this.registers[6]) this.vdisp = true; break;
            case 7: if (this.vcc === this.registers[7]) this.vsyncActive = true; break;
            case 8: this.interlaceMode = val & 1; break;
        }
    },

    /**
     * Reads a register value. Type2 exposes only R14–R17.
     * @returns {number} Register value or 0 for unreadable registers.
     */
    read() {
        switch (this.selectedRegister) {
            case 14: case 15: case 16: case 17: return this.registers[this.selectedRegister];
            default: return 0;
        }
    },

    /**
     * Status port read — Type2 does not implement a status port.
     * @returns {null}
     */
    status() { return null; },

    /**
     * Advances vertical counters at end of each horizontal line.
     * Type2 difference: VSync is only triggered when !hsyncActive, preventing
     * a race condition that occurs when HSync and the VSync trigger position coincide.
     * R4/R5/R9 mirrors are snapshotted at frame end (same as Type0).
     */
    updateVertical() {
        if (this.vsyncActive) {
            this.vsc_counter = (this.vsc_counter + 1) & 15;
            if (this.vsc_counter === (this.registers[3] >>> 4)) {
                this.vsyncActive = false;
                this.vsc_counter = 0;
            }
        }
        if (this.vblankActive) {
            this.vtac_counter = (this.vtac_counter + 1) & 31;
        } else if (this.vlc_crtc === this.r9_mra && this.vcc === this.r4_vt) {
            this.vblankActive = true;
            this.vtac_counter = 0;
        }
        if (this.vblankActive && this.vtac_counter === this.r5_vta) {
            this.vblankActive = false;
            this.vlc_crtc     = 0;
            this.startAddress = (this.registers[12] << 8) | this.registers[13];
            this.vdisp        = (this.registers[6] === 0);
            if (this.vcc !== 0) {
                this.vcc = 0;
                if (this.vcc === this.registers[7] && this.vsc_counter === 0 && !this.hsyncActive) {
                    this.vsyncActive = true;
                }
            }
        } else if (this.vlc_crtc === this.registers[9]) {
            this.vlc_crtc = 0;
            this.vcc = (this.vcc + 1) & 127;
            if (this.vcc === this.registers[6]) this.vdisp = true;
            if (this.vcc === this.registers[7] && this.vsc_counter === 0 && !this.hsyncActive) {
                this.vsyncActive = true;
            }
        } else {
            this.vlc_crtc = (this.vlc_crtc + 1) & 31;
        }
        this.maRow  = this.startAddress;
        this.r4_vt  = this.registers[4];
        this.r5_vta = this.registers[5];
        this.r9_mra = this.registers[9];
        this.vlc    = this.vlc_crtc;
    },

    /**
     * Per-character-clock tick for Type2.
     * Type2 difference: at line start, hdisp is initialised to the current hsyncActive
     * state rather than false. This reflects the MC6845's behaviour when a line boundary
     * coincides with an active HSync pulse.
     */
    tick() {
        if (this.hcc_counter === this.registers[0]) {
            this.updateVertical();
            if (this.registers[8] === 3) {
                this.updateVertical();
                if (this.vlc_crtc === 0 && this.vcc === this.registers[7]
                    && this.vsc_counter === 0 && !this.hsyncActive) {
                    this.vsyncActive = true;
                }
            }
            this.hcc_counter = 0;
            this.hdisp = this.hsyncActive;
        } else {
            this.hcc_counter = (this.hcc_counter + 1) & 255;
            this.maRow = (this.maRow + 1) & 0x3FFF;
        }
        if (this.hcc_counter === this.registers[1]) this.hdisp = true;
    },

    /**
     * Updates row start address and border signal for Type2.
     * No skew pipeline — border = hdisp OR vdisp, identical to Type1 but without
     * the R6==0 special case.
     */
    renderBorder() {
        if (this.hcc_counter === this.registers[1] && this.vlc_crtc === this.registers[9]) {
            this.startAddress = this.maRow;
        }
        this.border = this.hdisp || this.vdisp;
    },

    /**
     * Increments HSync counter; deasserts HSync when it equals R3 (full 8 bits on Type2).
     */
    updateHsync() {
        if (this.hsyncActive) {
            this.hsyncCounter = (this.hsyncCounter + 1) & 15;
            if (this.hsyncCounter === this.registers[3]) this.hsyncActive = false;
        }
    },

    /**
     * Triggers HSync at hcc == R2 if not already active and R3 != 0.
     */
    checkHsync() {
        if (this.hcc_counter === this.registers[2] && !this.hsyncActive && this.registers[3] !== 0) {
            this.hsyncActive  = true;
            this.hsyncCounter = 0;
        }
    }
};


// ===============================================================================
// CRTC_Type3 — CPC+ advanced ASIC (split screen, HScroll)
// ===============================================================================
//
// Used in CPC 464+ and GX4000.
// Extended features beyond Type0/2:
//   - read(): exposes hardware beam-position status bits (not just register values).
//     The lower 3 bits of the selected register index are used as an operation selector,
//     returning horizontal/vertical counters and sync status flags.
//   - HScroll: vlc = (vlc_crtc + asicHScroll) & 31. The ASIC soft-scroll register shifts
//     the effective raster line, implementing smooth vertical scrolling.
//   - Split screen: when vcc<<3 | vlc_crtc matches the ASIC split-line register, maRow and
//     startAddress are redirected to the ASIC split-screen start address (SSA).
//   - renderBorder: adds the Type0 3-stage skew pipeline, plus resets HScroll at hcc==0
//     when the ASIC soft-scroll control register (SSCR) is set.
//   - updateVertical: calls _renderAsicSplit() at each character-row boundary.

/**
 * @namespace CRTC_Type3
 * @description CPC+ advanced ASIC CRTC variant — split screen and horizontal soft-scroll.
 */
const CRTC_Type3 = {

    /**
     * Per-register write masks — same as Type0 (R3 high nibble is used for VSync width).
     * @type {Uint8Array}
     */
    crtcMasks: new Uint8Array([255, 255, 255, 255, 127, 31, 127, 127, 243, 31, 127, 31, 63, 255, 63, 255, 63, 255]),

    /**
     * Selects the active register and feeds ASIC unlock on CPC+ machines.
     * @param {number} val - Address port value; bits 4–0 index R0–R17.
     */
    select(val) {
        this.selectedRegister = val & 31;
        if (this.machineType >= 4) this._feedUnlock(val);
    },

    /**
     * Writes to the selected register.
     * Note: R7 has no write side-effect in Type3; VSync is triggered via updateVertical only.
     * @param {number} val - 8-bit data value.
     */
    write(val) {
        if (this.selectedRegister < 18) {
            this.registers[this.selectedRegister] = val & this.crtcMasks[this.selectedRegister];
        }
        switch (this.selectedRegister) {
            case 0: this.charWidth = this.registers[0] >>> 1; break;
            case 6: if (this.vcc === this.registers[6]) this.vdisp = true; break;
            case 8: this.interlaceMode = val & 1; break;
        }
    },

    /**
     * Extended read — returns beam-position status, indexed by (selectedRegister & 7):
     *   0 → R16 high byte (light pen address)
     *   1 → R17 low byte  (light pen address)
     *   2 → Horizontal status byte:
     *         bit 5 = VSync not at end of pulse
     *         bit 4 = HSync not at end of pulse
     *         bit 3 = hcc != R2 (not at HSync position)
     *         bit 2 = hcc != R1 (not at display end)
     *         bit 1 = hcc != R0/2 (not at half-total)
     *         bit 0 = hcc == R0 (at total)
     *   3 → Vertical status byte:
     *         bit 7 = vlc_crtc == 0 (top of character row)
     *         bit 5 = vlc_crtc != R9 (not at bottom of character row)
     *   4-7 → R12, R13, R14, R15
     * @returns {number} Status or register value.
     */
    read() {
        switch (this.selectedRegister & 7) {
            case 0: return this.registers[16];
            case 1: return this.registers[17];
            case 2: {
                const vsOk = (!this.vsyncActive || this.vsc_counter !== (this.registers[3] >>> 4));
                const hsOk = (!this.hsyncActive || this.hsyncCounter !== (this.registers[3] & 15));
                return (vsOk << 5) | (hsOk << 4)
                     | ((this.hcc_counter !== this.registers[2]) << 3)
                     | ((this.hcc_counter !== this.registers[1]) << 2)
                     | ((this.hcc_counter !== (this.registers[0] >>> 1)) << 1)
                     | (this.hcc_counter === this.registers[0] ? 1 : 0);
            }
            case 3: return ((this.vlc_crtc === 0) << 7) | ((this.vlc_crtc !== this.registers[9]) << 5);
            case 4: return this.registers[12];
            case 5: return this.registers[13];
            case 6: return this.registers[14];
            case 7: return this.registers[15];
        }
    },

    /**
     * Status port read — aliases the extended read() for Type3.
     * @returns {number} Same as read().
     */
    status() { return this.read(); },

    /**
     * Advances vertical counters at end of each horizontal line.
     * Type3 calls _renderAsicSplit() at every character-row boundary to allow
     * the ASIC split-screen manager to redirect the video address when the
     * configured split line is reached.
     * R4/R5/R9 mirrors are snapshotted (same as Type0/2).
     */
    updateVertical() {
        if (this.vsyncActive) {
            this.vsc_counter = (this.vsc_counter + 1) & 15;
            if (this.vsc_counter === (this.registers[3] >>> 4)) {
                this.vsyncActive = false;
                this.vsc_counter = 0;
            }
        }
        if (this.vblankActive) {
            this.vtac_counter = (this.vtac_counter + 1) & 31;
        } else if (this.vlc_crtc === this.r9_mra && this.vcc === this.r4_vt) {
            this.vblankActive = true;
            this.vtac_counter = 0;
        }
        if (this.vblankActive && this.vtac_counter === this.r5_vta) {
            this.vblankActive = false;
            this.vlc_crtc     = 0;
            this.startAddress = (this.registers[12] << 8) | this.registers[13];
            this.vdisp        = (this.registers[6] === 0);
            if (this.vcc !== 0) {
                this.vcc = 0;
                if (this.vcc === this.registers[7] && this.vsc_counter === 0) this.vsyncActive = true;
            }
        } else if (this.vlc_crtc === this.registers[9]) {
            this.vlc_crtc = 0;
            this.vcc = (this.vcc + 1) & 127;
            if (this.vcc === this.registers[6]) this.vdisp = true;
            if (this.vcc === this.registers[7] && this.vsc_counter === 0) this.vsyncActive = true;
        } else {
            this.vlc_crtc = (this.vlc_crtc + 1) & 31;
        }
        this.maRow  = this.startAddress;
        this.r4_vt  = this.registers[4];
        this.r5_vta = this.registers[5];
        this.r9_mra = this.registers[9];
        this._renderAsicSplit();
    },

    /**
     * Per-character-clock tick for Type3.
     * After the standard hcc/vcc update:
     *   - Applies ASIC HScroll: vlc = (vlc_crtc + asicHScroll) & 31.
     *   - Checks for split-screen trigger: if (vcc<<3 | vlc_crtc) == asicSplitLine,
     *     redirects maRow and startAddress to the ASIC split-screen start address.
     */
    tick() {
        if (this.hcc_counter === this.registers[0]) {
            this.updateVertical();
            if ((this.registers[8] & 3) === 3) {
                this.updateVertical();
                if (this.vlc_crtc === 0 && this.vcc === this.registers[7] && this.vsc_counter === 0) {
                    this.vsyncActive = true;
                }
            }
            this.hcc_counter = 0;
            this.hdisp = false;
        } else {
            this.hcc_counter = (this.hcc_counter + 1) & 255;
            this.maRow = (this.maRow + 1) & 0x3FFF;
        }

        this.vlc = (this.vlc_crtc + this._getAsicHScroll()) & 31;

        if (this.hcc_counter === this.registers[1]) {
            this.hdisp = true;
            if (this._getAsicSplitLine() !== 0) {
                if ((this.vcc << 3 | this.vlc_crtc) === this._getAsicSplitLine()) {
                    this.maRow = this.startAddress = (this._getAsicSsaHigh() << 8) | this._getAsicSsaLow();
                }
            }
        }
    },

    /**
     * Updates row start address, 3-stage skew pipeline, and ASIC HScroll reset for Type3.
     * At hcc == 0: if the ASIC soft-scroll control register (SSCR) is set, returns true
     * to signal the display pipeline to reset the horizontal scroll offset.
     * R8 bits 5–4 control the skew delay (same as Type0).
     * @returns {boolean|undefined} True if ASIC HScroll should be reset this clock; undefined otherwise.
     */
    renderBorder() {
        if (this.hcc_counter === this.registers[1] && this.vlc === this.registers[9]) {
            this.startAddress = this.maRow;
        }
        this.border3 = this.border2;
        this.border2 = this.border1;
        this.border1 = this.hdisp || this.vdisp;

        if (this.hcc_counter === 0 && this._getAsicSscr() === 1) return true;

        switch (this.registers[8] & 0x30) {
            case 0x00: this.border = this.border1; break;
            case 0x10: this.border = this.border2; break;
            case 0x20: this.border = this.border3; break;
            case 0x30: this.border = true;          break;
        }
    },

    /**
     * Increments HSync counter; deasserts HSync when it reaches R3 bits 3–0.
     */
    updateHsync() {
        if (this.hsyncActive) {
            this.hsyncCounter = (this.hsyncCounter + 1) & 15;
            if (this.hsyncCounter === (this.registers[3] & 15)) this.hsyncActive = false;
        }
    },

    /**
     * Triggers HSync at hcc == R2 if not already active and R3 bits 3–0 != 0.
     */
    checkHsync() {
        if (this.hcc_counter === this.registers[2] && !this.hsyncActive && (this.registers[3] & 15) !== 0) {
            this.hsyncActive  = true;
            this.hsyncCounter = 0;
        }
    }
};
