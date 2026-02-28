"use strict";

/**
 * @module Memory
 * @description RAM management, memory banking (64 KB + 512 KB expansion), and ROM switching.
 *
 * CPC memory architecture:
 *   - 4 pages of 16 KB → Bank[0..3] (absolute offsets into ramData)
 *   - Lower ROM (page 0) / Upper ROM (page 3) switchable via the Gate Array
 *   - CPC 6128 / CPC+: extended banking up to 576 KB
 *   - CPC+: 4 KB ASIC RAM mapped at page 1 (0x4000–0x4FFF)
 *
 * Performance notes:
 *   - `ROM_Manager.readMemory`: Uint8Array access never returns `undefined`
 *     for in-bounds indices, so defensive checks were removed from the hot path.
 *   - `Memory_Manager.lowerRom` uses a Map instead of a sparse Array(256)
 *     because only 2–3 slots are ever populated (BASIC=0, AMSDOS=7).
 *   - `updateBanking`: bankBase is computed only inside the `case` branches
 *     that actually need it; case 0 (the default/most common path) is free.
 */

// =============================================================================
// Memory_Manager
// =============================================================================

/**
 * @namespace Memory_Manager
 * @description Manages the physical 576 KB RAM array and the 4-page banking
 * window that the Z80 sees as a flat 64 KB address space.
 */
const Memory_Manager = {

    /**
     * Active machine type (0=464, 1=664, 2=6128, 4=6128+, 5=464+).
     * Controls whether extended banking modes are available.
     * @type {number}
     */
    machineType : 2,

    /**
     * Whether the 512 KB RAM expansion is installed.
     * Enables banking modes that address up to 8 extra 64 KB banks.
     * @type {boolean}
     */
    ramExpansion: false,

    /**
     * Injects configuration from the host application.
     * @param {Object} bus
     * @param {number} [bus.machineType]
     * @param {boolean} [bus.ramExpansion]
     */
    link(bus) {
        if ('machineType'  in bus) this.machineType  = bus.machineType;
        if ('ramExpansion' in bus) this.ramExpansion = bus.ramExpansion;
    },

    /**
     * Full RAM buffer: 576 KB (589 824 bytes) to accommodate the base 64 KB
     * plus up to eight 64 KB expansion banks.
     * @type {Uint8Array}
     */
    ramData: new Uint8Array(589824),

    /**
     * Absolute byte offsets of the four 16 KB pages within `ramData`.
     * Bank[n] is OR-ed with the 14-bit page offset to produce the physical address.
     * @type {Int32Array}
     */
    Bank: new Int32Array(4),

    /**
     * Raw banking configuration (4 entries, mirroring the last OUT &7Fxx value).
     * @type {Int32Array}
     */
    memoryBanks: new Int32Array(4),

    /**
     * Resets RAM to all zeros and restores the default linear banking layout.
     */
    reset() {
        this.ramData.fill(0);
        this.Bank[0] = 0;
        this.Bank[1] = 16384;
        this.Bank[2] = 32768;
        this.Bank[3] = 49152;
        this.memoryBanks.fill(0);
    },

    /**
     * Processes a Z80 OUT to the memory mapper port.
     * The port is selected when A15=0; the value qualifies when bits 7:6 = 11.
     * @param {number} port  - 16-bit port address.
     * @param {number} value - 8-bit data byte from the Z80.
     */
    writePort(port, value) {
        if ((port & 0x8000) === 0 && (value >>> 6) === 3) {
            this.updateBanking(value);
        }
    },

    /**
     * Reconfigures the four Bank[] offsets according to a Gate Array banking byte.
     *
     * Modes (value & 7):
     *   0 — Standard linear: pages 0–3 map to the base 64 KB.
     *   1 — Page 3 mapped to an expansion bank; pages 0–2 stay linear.
     *   2 — All four pages mapped to a single expansion bank (64 KB block).
     *   3 — Pages 0 and 1 normal; page 1 mapped to base+48 KB, page 3 to expansion.
     *   4–7 — Page 1 mapped to a specific 16 KB slot within an expansion bank;
     *          all other pages stay at their linear positions.
     *
     * When ramExpansion is true, bits 5:3 of `value` select one of eight 64 KB
     * expansion banks (bankBase = bank * 65536 + 65536).
     *
     * @param {number} value - Banking command byte (bits 7:6 = 11 already verified).
     */
    updateBanking(value) {
        if (this.machineType !== 2 && this.machineType !== 4 && !this.ramExpansion) return;

        switch (value & 7) {
            case 0:
                this.Bank[0] = 0;      this.Bank[1] = 16384;
                this.Bank[2] = 32768;  this.Bank[3] = 49152;
                break;
            case 1: {
                const bankBase = (this.ramExpansion ? (value >>> 3) & 7 : 0) * 65536 + 65536;
                this.Bank[0] = 0;      this.Bank[1] = 16384;
                this.Bank[2] = 32768;  this.Bank[3] = bankBase | 49152;
                break;
            }
            case 2: {
                const bankBase = (this.ramExpansion ? (value >>> 3) & 7 : 0) * 65536 + 65536;
                this.Bank[0] = bankBase;           this.Bank[1] = bankBase | 16384;
                this.Bank[2] = bankBase | 32768;   this.Bank[3] = bankBase | 49152;
                break;
            }
            case 3: {
                const bankBase = (this.ramExpansion ? (value >>> 3) & 7 : 0) * 65536 + 65536;
                this.Bank[0] = 0;      this.Bank[1] = 49152;
                this.Bank[2] = 32768;  this.Bank[3] = bankBase | 49152;
                break;
            }
            default: {
                const bankBase = (this.ramExpansion ? (value >>> 3) & 7 : 0) * 65536 + 65536;
                this.Bank[0] = 0;
                this.Bank[1] = bankBase | ((value & 3) << 14);
                this.Bank[2] = 32768;
                this.Bank[3] = 49152;
            }
        }
    },

    /**
     * Reads one byte from RAM at the given page and 14-bit offset.
     * @param {number} page   - Page index (0–3).
     * @param {number} offset - 14-bit offset within the page (0–16383).
     * @returns {number} 8-bit value.
     */
    readRam(page, offset) {
        return this.ramData[this.Bank[page] | offset];
    },

    /**
     * Writes one byte to RAM at the given page and 14-bit offset.
     * @param {number} page   - Page index (0–3).
     * @param {number} offset - 14-bit offset within the page (0–16383).
     * @param {number} value  - 8-bit value to write.
     */
    writeRam(page, offset, value) {
        this.ramData[this.Bank[page] | offset] = value;
    },
};


// =============================================================================
// ROM_Manager
// =============================================================================

/**
 * @namespace ROM_Manager
 * @description Manages lower ROM (OS), upper ROM (BASIC/AMSDOS/expansions),
 * CPC+ cartridge ROM slots, and the Gate Array ROM enable flags.
 *
 * ROM data is injected via {@link ROM_Manager.loadLowerRom} and
 * {@link ROM_Manager.loadUpperRom} — this module has no knowledge of
 * the network or filesystem.
 */
const ROM_Manager = {

    /** @type {Function|null} Notifies the Gate Array of a ROM config change. */
    _updatePaletteRom: null,
    /** @type {Function|null} Reads a byte from the ASIC RAM region. */
    _readAsic        : null,
    /** @type {Function|null} Writes a byte to the ASIC RAM region. */
    _writeAsic       : null,

    /** @type {number} */
    machineType : 2,
    /** @type {boolean} */
    ramExpansion: false,

    /**
     * Injects external dependencies.
     * @param {Object} bus
     * @param {number}   [bus.machineType]
     * @param {boolean}  [bus.ramExpansion]
     * @param {Function} [bus.updatePaletteRom]
     * @param {Function} [bus.readAsic]
     * @param {Function} [bus.writeAsic]
     */
    link(bus) {
        if ('machineType'      in bus) this.machineType        = bus.machineType;
        if ('ramExpansion'     in bus) this.ramExpansion       = bus.ramExpansion;
        if (bus.updatePaletteRom)      this._updatePaletteRom  = bus.updatePaletteRom;
        if (bus.readAsic)              this._readAsic           = bus.readAsic;
        if (bus.writeAsic)             this._writeAsic          = bus.writeAsic;
    },

    /**
     * Upper-ROM data indexed by slot number.
     * A Map is used because only 2–3 slots are populated (0=BASIC, 7=AMSDOS),
     * avoiding 256 wasted `undefined` entries from a sparse Array.
     * @type {Map<number, Uint8Array>}
     */
    lowerRom: new Map(),

    /**
     * Array of 32 upper ROM slots for CPC+ cartridges.
     * Indexed by ROM number (0–31); null = slot empty.
     * @type {(Uint8Array|null)[]}
     */
    upperRoms: new Array(32),

    /** Currently selected upper ROM slot index (0–31). @type {number} */
    selectedUpperRom: 0,
    /** Whether the upper ROM (page 3) is visible to the Z80. @type {boolean} */
    upperRomEnabled : true,
    /** Whether the lower ROM (page 0) is visible to the Z80. @type {boolean} */
    lowerRomEnabled : true,
    /** Page mapping for the lower ROM (0 = page 0, 1 = page 1, etc.). @type {number} */
    romMapping      : 0,
    /** Whether the CPC+ ASIC RAM is mapped over page 1. @type {boolean} */
    asicRamEnabled  : false,
    /** Binary data of the currently active lower ROM. @type {Uint8Array|null} */
    currentLowerRom : null,
    /** Binary data of the currently active upper ROM. @type {Uint8Array|null} */
    currentUpperRom : null,

    /**
     * Loads the lower (OS) ROM image.
     * @param {Uint8Array} data - ROM binary contents.
     */
    loadLowerRom(data) {
        this.currentLowerRom = data;
    },

    /**
     * Loads an upper ROM image into the given slot.
     * @param {number}    slot - Slot number (0 = BASIC, 7 = AMSDOS, …).
     * @param {Uint8Array} data - ROM binary contents.
     */
    loadUpperRom(slot, data) {
        this.lowerRom.set(slot, data);
    },

    /**
     * Activates the ROMs that were previously loaded.
     * Calls {@link ROM_Manager.selectRom} with the currently selected slot.
     */
    loadROMs() {
        this.selectRom(this.selectedUpperRom);
    },

    /**
     * Resets ROM manager state to power-on defaults.
     * Does not clear the loaded ROM data.
     */
    reset() {
        this.selectedUpperRom   = 0;
        this.upperRomEnabled    = true;
        this.lowerRomEnabled    = true;
        this.romMapping         = 0;
        this.asicRamEnabled     = false;
    },

    /**
     * Processes a Z80 OUT to the ROM select port (A13=0).
     * @param {number} port  - 16-bit port address.
     * @param {number} value - Upper ROM slot index (0–31).
     */
    writePort(port, value) {
        if ((port & 0x2000) === 0) {
            this.selectRom(value);
        }
    },

    /**
     * Selects the lower ROM slot for a CPC+ cartridge (CPR format).
     * Bits 2:0 of `slot` index the cartridge ROM bank.
     * Bits 4:3 of `slot` control the page mapping mode;
     * mapping 3 enables ASIC RAM in place of the lower ROM.
     * @param {number} slot - Cartridge slot identifier byte.
     */
    selectAsicRom(slot) {
        this.currentLowerRom = this.upperRoms[slot & 7];
        this.romMapping      = (slot >>> 3) & 3;

        if (this.romMapping === 3) {
            this.romMapping     = 0;
            this.asicRamEnabled = true;
        } else {
            this.asicRamEnabled = false;
        }
    },

    /**
     * Updates ROM enable flags from a Gate Array control byte.
     * Bits 3:2 of `value` disable upper/lower ROM respectively when set.
     * @param {number} value - Gate Array ROM config byte.
     */
    updateRomConfig(value) {
        this._updatePaletteRom(value & 3);
        this.upperRomEnabled = (value & 0x08) === 0;
        this.lowerRomEnabled = (value & 0x04) === 0;
    },

    /**
     * Selects the active upper ROM.
     * On classic CPC: slot 7 = AMSDOS, any other slot = BASIC (slot 0).
     * On CPC+ (machineType ≥ 4): slot indexes directly into the 32-entry upperRoms array.
     * @param {number} slot - ROM slot index (0–31).
     */
    selectRom(slot) {
        this.selectedUpperRom = slot;

        if (this.machineType >= 4) {
            this.currentUpperRom = this.upperRoms[slot & 31] || null;
        } else {
            this.currentUpperRom = this.lowerRom.get(slot === 7 ? 7 : 0) || null;
        }
    },

    /**
     * Reads one byte from the Z80 address space, applying ROM overlays.
     *
     * Priority (highest to lowest):
     *   1. Upper ROM (page 3) when `upperRomEnabled`.
     *   2. Lower ROM (page `romMapping`) when `lowerRomEnabled`.
     *   3. ASIC RAM (page 1) when `asicRamEnabled`.
     *   4. Physical RAM via Memory_Manager.
     *
     * Returns 0xFF when a ROM slot is enabled but contains no data,
     * matching real hardware floating-bus behaviour.
     *
     * @param {number} addr - 16-bit Z80 address.
     * @returns {number} 8-bit value.
     */
    readMemory(addr) {
        const offset = addr & 0x3FFF;
        const page   = (addr >>> 14) & 3;

        if (this.upperRomEnabled && page === 3) {
            return this.currentUpperRom ? this.currentUpperRom[offset] : 0xFF;
        }

        if (this.lowerRomEnabled && page === this.romMapping) {
            return this.currentLowerRom ? this.currentLowerRom[offset] : 0xFF;
        }

        if (this.asicRamEnabled && page === 1) {
            return this._readAsic(offset);
        }

        return Memory_Manager.readRam(page, offset);
    },

    /**
     * Writes one byte to the Z80 address space.
     * When ASIC RAM is mapped over page 1, writes are redirected there;
     * otherwise the write goes to physical RAM.
     * ROMs are read-only and silently ignore writes.
     * @param {number} addr  - 16-bit Z80 address.
     * @param {number} value - 8-bit value to write.
     */
    writeMemory(addr, value) {
        const offset = addr & 0x3FFF;
        const page   = (addr >>> 14) & 3;

        if (this.asicRamEnabled && page === 1) {
            this._writeAsic(offset, value);
        } else {
            Memory_Manager.writeRam(page, offset, value);
        }
    },
};
