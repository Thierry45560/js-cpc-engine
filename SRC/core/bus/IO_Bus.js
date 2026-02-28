"use strict";

/**
 * @module IO_Manager
 * @description Z80 I/O bus router for the Amstrad CPC.
 *
 * CPC hardware architecture:
 *   The Z80 decodes I/O ports via address bits (A15–A0) rather than a
 *   separate I/O address space. Each peripheral tests the bits relevant to it:
 *
 *   | A15 | A14 | Peripheral                          |
 *   |-----|-----|-------------------------------------|
 *   |  0  |  1  | Gate Array (Palette_Colors)         |
 *   |  x  |  x  | CRTC 6845    (A9=1, A8=0)           |
 *   |  x  |  x  | ROM Manager  (A13=0)                |
 *   |  x  |  x  | Memory Mapper(A15=0, A14=0)         |
 *   |  x  |  x  | PPI 8255     (A11=0, A10=0, A9=0)  |
 *   |  x  |  x  | FDC 765      (A10=1, A8=0)          |
 *
 * All dependencies are injected via {@link IO_Manager.link} (wired in CPC_Bus.js).
 *
 * Expected bus properties:
 * @property {Function} readPrinter       - VirtualPrinter.readPort(addr)
 * @property {Function} readCrtc          - CRTC_Manager.readPort(addr)
 * @property {Function} readPpi           - PPI_8255.readPort(addr)
 * @property {Function} readFdc           - Floppy_Controller_FDC.readPort(addr)
 * @property {Function} writePrinter      - VirtualPrinter.writePort(addr, data)
 * @property {Function} writeCrtc         - CRTC_Manager.writePort(addr, data)
 * @property {Function} writePalette      - Palette_Colors.writePort(addr, data)
 * @property {Function} writeRom          - ROM_Manager.writePort(addr, data)
 * @property {Function} writeMemory       - Memory_Manager.writePort(addr, data)
 * @property {Function} writePpi          - PPI_8255.writePort(addr, data)
 * @property {Function} writeFdc          - Floppy_Controller_FDC.writePort(addr, data)
 * @property {Function} writeInputExp     - InputExpansion.writePort(addr, data)
 * @property {Function} clearIoWriteState - () => { CPU_Z80.ioWriteState = 0; }
 */
const IO_Manager = {

    /** @type {Function|null} */
    _readPrinter      : null,
    /** @type {Function|null} */
    _readCrtc         : null,
    /** @type {Function|null} */
    _readPpi          : null,
    /** @type {Function|null} */
    _readFdc          : null,
    /** @type {Function|null} */
    _writePrinter     : null,
    /** @type {Function|null} */
    _writeCrtc        : null,
    /** @type {Function|null} */
    _writePalette     : null,
    /** @type {Function|null} */
    _writeRom         : null,
    /** @type {Function|null} */
    _writeMemory      : null,
    /** @type {Function|null} */
    _writePpi         : null,
    /** @type {Function|null} */
    _writeFdc         : null,
    /** @type {Function|null} */
    _writeInputExp    : null,
    /** @type {Function|null} */
    _clearIoWriteState: null,

    /**
     * Active machine type.
     * 0=CPC464, 1=CPC664, 2=CPC6128, 4=CPC6128+, 5=CPC464+.
     * Affects the floating-bus default value on reads.
     * @type {number}
     */
    machineType: 2,

    /**
     * Injects external peripheral references from a bus object.
     * @param {Object} bus - Dependency container from CPC_Bus.js.
     */
    link(bus) {
        if ('machineType'      in bus) this.machineType        = bus.machineType;
        if (bus.readPrinter)            this._readPrinter       = bus.readPrinter;
        if (bus.readCrtc)               this._readCrtc          = bus.readCrtc;
        if (bus.readPpi)                this._readPpi           = bus.readPpi;
        if (bus.readFdc)                this._readFdc           = bus.readFdc;
        if (bus.writePrinter)           this._writePrinter      = bus.writePrinter;
        if (bus.writeCrtc)              this._writeCrtc         = bus.writeCrtc;
        if (bus.writePalette)           this._writePalette      = bus.writePalette;
        if (bus.writeRom)               this._writeRom          = bus.writeRom;
        if (bus.writeMemory)            this._writeMemory       = bus.writeMemory;
        if (bus.writePpi)               this._writePpi          = bus.writePpi;
        if (bus.writeFdc)               this._writeFdc          = bus.writeFdc;
        if (bus.writeInputExp)          this._writeInputExp     = bus.writeInputExp;
        if (bus.clearIoWriteState)      this._clearIoWriteState = bus.clearIoWriteState;
    },

    /**
     * Handles a Z80 IN instruction.
     * Queries each peripheral in priority order; the first to return a non-null
     * value wins. If no peripheral responds, returns the floating-bus default:
     * 120 on CPC+ or 255 on standard CPC.
     * @param {number} addr - 16-bit port address.
     * @returns {number} 8-bit value read from the bus.
     */
    readIO(addr) {
        let val;

        if ((addr & 0xFF00) === 0xEF00) {
            return this._readPrinter(addr);
        }

        val = this._readCrtc(addr);
        if (val !== null) return val;

        val = this._readPpi(addr);
        if (val !== null) return val;

        val = this._readFdc(addr);
        if (val !== null) return val;

        return this.machineType >= 4 ? 120 : 255;
    },

    /**
     * Handles a Z80 OUT instruction.
     * Broadcasts the write to every peripheral; each one filters by address.
     * Clears `ioWriteState` on the CPU to signal completion.
     * @param {number} addr - 16-bit port address.
     * @param {number} data - 8-bit value to write.
     */
    triggerIO(addr, data) {
        this._clearIoWriteState();
        this._writePrinter(addr, data);
        this._writeCrtc(addr, data);
        this._writePalette(addr, data);
        this._writeRom(addr, data);
        this._writeMemory(addr, data);
        this._writePpi(addr, data);
        this._writeFdc(addr, data);
        this._writeInputExp(addr, data);
    }
};
