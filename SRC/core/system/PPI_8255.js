"use strict";

/**
 * @module PPI_8255
 * @description Emulation of the Intel 8255 Programmable Peripheral Interface.
 *
 * Handles the PSG data bus (Port A), CPC input signals (Port B: VSync, cassette,
 * joystick, brand ID), and PSG mode / cassette motor control (Port C).
 *
 * Standalone module — no direct references to other modules.
 * All dependencies are injected via {@link PPI_8255.link} (wired in CPC_Bus.js).
 *
 * CPC address decoding: (addr >>> 8) & 0x0B
 *   Port A (R/W) at 0x00 → PSG data bus (read = PSG read, write = PSG write)
 *   Port B (R)   at 0x01 → VSync, brand ID, cassette bit, joystick
 *   Port C (R/W) at 0x02 → PSG mode (bits 7:6) + cassette motor (bit 4) + keyboard row (bits 3:0)
 *   Control      (W)     at 0x03 → port direction and mode configuration
 *
 * Expected bus properties injected via link():
 * @property {number}   machineType    - Machine_Type
 * @property {Function} readPsg        - PSG_Sound_AY38910.readPort()
 * @property {Function} writePsg       - PSG_Sound_AY38910.writePort(val)
 * @property {Function} getTapeBitOut  - Returns TapeController.tapeBitOut
 * @property {Function} getVsyncActive - Returns CRTC_Manager.vsyncActive
 * @property {Function} getBrandId     - Returns Config_Manager.brandId
 * @property {Function} getJoystick1   - Returns InputExpansion.joystick1
 * @property {Function} getJoystick2   - Returns InputExpansion.joystick2
 * @property {Function} setMotorRelay  - TapeController.setMotorRelay(v)
 * @property {Function} throwError     - throwError(msg)
 *
 * JIT optimisation notes:
 *   All scalar properties are initialised to their final types (0 or false) so
 *   V8/SpiderMonkey can build a monomorphic hidden class at construction time.
 *   `_portBStatic` pre-computes the static bits of Port B (joystick + brand ID)
 *   once per reset; only the two dynamic bits (tapeBitOut, vsyncActive) are
 *   assembled on each read.
 */
const PPI_8255 = {

    /** @type {Function|null} */ _readPsg      : null,
    /** @type {Function|null} */ _writePsg     : null,
    /** @type {Function|null} */ _getTapeBitOut: null,
    /** @type {Function|null} */ _getVsyncActive: null,
    /** @type {Function|null} */ _getBrandId   : null,
    /** @type {Function|null} */ _getJoystick1 : null,
    /** @type {Function|null} */ _getJoystick2 : null,
    /** @type {Function|null} */ _setMotorRelay: null,
    /** @type {Function|null} */ _throwError   : null,

    /**
     * Active machine type (0=464, 1=664, 2=6128, 4=6128+, 5=464+).
     * @type {number}
     */
    machineType: 2,

    /**
     * Injects external dependencies from CPC_Bus.js.
     * @param {Object} bus - Dependency container.
     */
    link(bus) {
        if ('machineType'   in bus) this.machineType      = bus.machineType;
        if (bus.readPsg)             this._readPsg         = bus.readPsg;
        if (bus.writePsg)            this._writePsg        = bus.writePsg;
        if (bus.getTapeBitOut)       this._getTapeBitOut   = bus.getTapeBitOut;
        if (bus.getVsyncActive)      this._getVsyncActive  = bus.getVsyncActive;
        if (bus.getBrandId)          this._getBrandId      = bus.getBrandId;
        if (bus.getJoystick1)        this._getJoystick1    = bus.getJoystick1;
        if (bus.getJoystick2)        this._getJoystick2    = bus.getJoystick2;
        if (bus.setMotorRelay)       this._setMotorRelay   = bus.setMotorRelay;
        if (bus.throwError)          this._throwError      = bus.throwError;
    },

    /** Joystick port 1 fire-button state (1 = not pressed). @type {number} */
    joystick1: 1,
    /** Joystick port 2 fire-button state (0 = not connected). @type {number} */
    joystick2: 0,

    /**
     * Port group A mode (0 = basic I/O). Modes 1 and 2 are not implemented on CPC.
     * @type {number}
     */
    modeA: 0,
    /** Port group B mode (0 = basic I/O). @type {number} */
    modeB: 0,

    /** Direction of Port A (0 = output, 1 = input). @type {number} */
    dirA: 0,
    /** Direction of Port B (0 = output, 1 = input). @type {number} */
    dirB: 0,
    /** Direction of Port C lower nibble (0 = output, 1 = input). @type {number} */
    dirCLower: 0,
    /** Direction of Port C upper nibble (0 = output, 1 = input). @type {number} */
    dirCUpper: 0,

    /** Latched Port A value. @type {number} */
    portA: 0,
    /** Latched Port B value (used when dirB=0). @type {number} */
    portB: 0,
    /**
     * Port C value — upper nibble contains PSG mode and cassette motor bit;
     * lower nibble contains the currently selected keyboard matrix row.
     * @type {number}
     */
    portC: 0,

    /**
     * Pre-computed static bits of Port B: bits 5:4 (joystick2/1) + bits 3:1 (brandId).
     * Only bits 7 (tapeBitOut) and 0 (vsyncActive) are computed dynamically on each read.
     * Updated once at reset and after any configuration change.
     * @type {number}
     */
    _portBStatic: 0,

    /**
     * Resets all ports and direction registers to the CPC power-on state:
     * Port A = output, Port B = input, Port C = output.
     */
    reset() {
        this.modeA = this.modeB = 0;
        this.dirCUpper = this.dirCLower = this.dirB = this.dirA = 1;
        this.portC = this.portB = this.portA = 0;
        this._updatePortBStatic();
    },

    /**
     * Pre-computes the bits of Port B that remain constant between resets:
     * joystick fire buttons (bits 5:4) and manufacturer brand ID (bits 3:1).
     * Must be called after any configuration change that affects these values.
     * @private
     */
    _updatePortBStatic() {
        this._portBStatic = (this._getJoystick2() << 5)
                          | (this._getJoystick1() << 4)
                          | (this._getBrandId()   << 1);
    },

    /**
     * Dispatches a Z80 IN instruction to the correct port handler.
     * Address decoding: (addr >>> 8) & 0x0B selects ports 0–2.
     * @param {number} addr - 16-bit port address.
     * @returns {number|null} 8-bit value, or null if address does not match.
     */
    readPort(addr) {
        switch ((addr >>> 8) & 0x0B) {
            case 0: return this.readPortA();
            case 1: return this.readPortB();
            case 2: return this.readPortC();
        }
        return null;
    },

    /**
     * Dispatches a Z80 OUT instruction to the correct port handler.
     * @param {number} addr - 16-bit port address.
     * @param {number} data - 8-bit value.
     */
    writePort(addr, data) {
        switch ((addr >>> 8) & 0x0B) {
            case 0: this.writePortA(data);       break;
            case 1: this.writePortB(data);       break;
            case 2: this.writePortC(data);       break;
            case 3: this.writeControlPPI(data);  break;
        }
    },

    /**
     * Reads Port A.
     * In input mode (dirA=1): returns the value currently on the PSG data bus
     * (e.g. keyboard matrix row from register 14).
     * In output mode (dirA=0): returns the last latched value.
     * @returns {number} 8-bit value.
     */
    readPortA() {
        return this.dirA ? this._readPsg() : this.portA;
    },

    /**
     * Writes to Port A.
     * Only effective in output mode (dirA=0).
     * Forwards the value to the PSG data bus.
     * @param {number} data - 8-bit value.
     */
    writePortA(data) {
        if (this.dirA === 0) {
            this.portA = data;
            this._writePsg(data);
        }
    },

    /**
     * Reads Port B (hardware input signals).
     * In input mode (dirB=1) the byte is assembled from live signals:
     *   Bit 7: cassette input bit (tapeBitOut)          — dynamic
     *   Bit 6: printer Busy (0 = ready)                 — constant 0
     *   Bit 5: joystick 2 fire button                   — static (_portBStatic)
     *   Bit 4: joystick 1 fire button                   — static (_portBStatic)
     *   Bits 3:1: manufacturer brand ID                 — static (_portBStatic)
     *   Bit 0: CRTC VSync active                        — dynamic
     * In output mode (dirB=0): returns the last latched portB value.
     * @returns {number} 8-bit value.
     */
    readPortB() {
        if (this.dirB) {
            return (this._getTapeBitOut() << 7)
                 | this._portBStatic
                 | (this._getVsyncActive() ? 1 : 0);
        }
        return this.portB;
    },

    /**
     * Writes to Port B (only effective when dirB=0).
     * @param {number} data - 8-bit value.
     */
    writePortB(data) {
        if (this.dirB === 0) this.portB = data;
    },

    /**
     * Reads Port C.
     * The upper nibble is 0xF0 when in input mode (dirCUpper=1) or the latched
     * value otherwise. The lower nibble follows dirCLower in the same way.
     * @returns {number} 8-bit value.
     */
    readPortC() {
        const hi = this.dirCUpper ? 0xF0 : (this.portC & 0xF0);
        const lo = this.dirCLower ? 0x0F : (this.portC & 0x0F);
        return hi | lo;
    },

    /**
     * Writes to Port C.
     * Upper nibble write (dirCLower=0): updates PSG mode bits and cassette motor relay.
     * Lower nibble write (dirCUpper=0): updates the selected keyboard row (bits 3:0).
     * @param {number} data - 8-bit value.
     */
    writePortC(data) {
        if (this.dirCLower === 0) {
            this.portC = (data & 0xF0) | (this.portC & 0x0F);
            this._writePsg(this.portA);
            this._setMotorRelay((data >>> 4) & 1);
        }
        if (this.dirCUpper === 0) {
            this.portC = (this.portC & 0xF0) | (data & 0x0F);
        }
    },

    /**
     * Processes a write to the 8255 control register.
     *
     * Two modes depending on bit 7:
     *   Bit 7 = 1 (Mode Control Word): configures port directions and operating modes.
     *     Bit 4   → dirA (Port A direction)
     *     Bit 3   → dirCLower (Port C lower nibble direction)
     *     Bit 1   → dirB (Port B direction)
     *     Bit 0   → dirCUpper (Port C upper nibble direction)
     *     Bits 6:5→ Group A mode (0 = basic, 1–2 = not implemented on CPC)
     *     Bit 2   → Group B mode (0 = basic, 1 = not implemented on CPC)
     *
     *   Bit 7 = 0 (Bit Set/Reset): sets or clears a single bit of Port C.
     *     Bits 3:1 → bit number to modify (0–7)
     *     Bit 0    → new value (1 = set, 0 = clear)
     *
     * @param {number} data - 8-bit control byte.
     */
    writeControlPPI(data) {
        if (data >>> 7) {
            this.dirA      = (data >>> 4) & 1;
            this.dirB      = (data >>> 1) & 1;
            this.dirCLower = (data >>> 3) & 1;
            this.dirCUpper =  data        & 1;

            if (this.machineType < 4) {
                this.modeA = (data >>> 5) & 3;
                if (this.modeA !== 0) this._throwError(`[Error] PPI group A mode ${this.modeA} not implemented`);
                this.modeB = (data >>> 2) & 1;
                if (this.modeB !== 0) this._throwError("[Error] PPI group B mode 1 not implemented");

                this.portC = this.portB = this.portA = 0;
                this._writePsg(this.portA);
            }

            this._updatePortBStatic();
        } else {
            const bitNum = (data >>> 1) & 7;
            const newVal = (data & 1)
                ? (this.portC |  (1 << bitNum))
                : (this.portC & ~(1 << bitNum) & 0xFF);
            this.writePortC(newVal);
        }
    }
};
