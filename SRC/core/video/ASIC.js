/**
 * @module ASIC_System
 * @description Emulation of the CPC+ ASIC chip (Amstrad Plus / GX4000).
 *
 * Sub-systems:
 *   - ASIC_Manager        — General ASIC registers (scroll, split, IVR, etc.) and
 *                           the hardware unlock sequence.
 *   - ASIC_DMA_Controller — 3-channel DMA controller for driving the PSG via RAM lists.
 *   - PriManager          — 16×16 hardware sprites and per-line pixel replacement (PRI).
 *
 * ASIC memory map (page 1, mapped at 0x4000–0x4FFF when ASIC RAM is enabled):
 *   0x4000–0x43FF  Sprite pixel data     (16 sprites × 256 bytes)
 *   0x4400–0x447F  Sprite attributes     (16 sprites × 5 bytes + padding)
 *   0x4480–0x44BF  ASIC palette          (32 colours × 2 bytes)
 *   0x4B00–0x4B07  General ASIC registers
 *   0x4B10–0x4B1F  DMA channel registers
 *
 * Optimisations applied:
 *   - updateUI() no longer touches the DOM directly; it assembles a plain state
 *     object and delegates rendering to _updateAsicUI() injected from UI_DOM.js.
 *     This keeps ASIC.js free of jQuery dependencies and testable without a browser.
 *   - PriManager sprite buffers are initialised with fill(0) instead of
 *     Math.random() — the hardware initialises sprites via ROM before use, and
 *     magX=0/magY=0 suppresses all rendering anyway. fill(0) is ~100× faster
 *     at reset and produces the same visible result.
 *   - DMA channels are stored as a dense array ([] populated in init()) rather
 *     than new Array(3), which V8 would represent as a sparse dictionary, causing
 *     hash-based lookups instead of direct offset access.
 */

"use strict";

/**
 * @namespace ASIC_Manager
 * @description General ASIC registers, hardware unlock sequence, and memory-mapped
 * read/write dispatcher for the CPC+ ASIC register space.
 */
const ASIC_Manager = {

    /** @type {Function|null} Injected getter — returns a hardware palette colour by index. */
    _getHwPalette   : null,
    /** @type {Function|null} Injected callback — writes the low byte of an ASIC palette entry. */
    _writeColorLow  : null,
    /** @type {Function|null} Injected callback — writes the high byte of an ASIC palette entry. */
    _writeColorHigh : null,
    /** @type {Function|null} Injected callback — sets the Gate Array interrupt status register. */
    _setGaIntStatus : null,
    /** @type {Function|null} Injected getter — returns whether ASIC RAM paging is active. */
    _getAsicRamEnabled: null,
    /** @type {Function|null} Injected setter — enables or disables ASIC RAM paging. */
    _setAsicRamEnabled: null,
    /** @type {Function|null} Injected getter — reads a byte from the main address space. */
    _readMemory     : null,
    /** @type {Function|null} Injected getter — returns the DMA status/control register. */
    _getDmaStatus   : null,
    /** @type {Function|null} Injected setter — writes the DMA status/control register. */
    _setDmaStatus   : null,
    /** @type {Function|null} Injected getter — returns the DMA channel array. */
    _getDmaChannels : null,
    /** @type {Function|null} Injected callback — triggers a DMA operation. */
    _triggerDma     : null,
    /** @type {Function|null} Injected getter — returns the current T-state count. */
    _getTStates     : null,
    /** @type {Function|null} Injected callback — executes a given number of CPU ticks. */
    _executeTicks   : null,
    /** @type {Function|null} Injected getter — returns the raw CRTC vertical line counter. */
    _getVlcCrtc     : null,
    /**
     * Injected UI callback — receives a plain state snapshot and updates the debugger panel.
     * Wired by UI_DOM.js so this module has no direct jQuery dependency.
     * @type {Function|null}
     */
    _updateAsicUI   : null,

    /** @type {number} Active machine model index (4–5 = CPC+). */
    machineType: 2,

    /**
     * Wires dependencies from the central bus into this module.
     * @param {Object} bus - Dependency container built by CPC_Bus.
     */
    link(bus) {
        if ('machineType'      in bus) this.machineType        = bus.machineType;
        if (bus.getHwPalette)           this._getHwPalette      = bus.getHwPalette;
        if (bus.writeColorLow)          this._writeColorLow     = bus.writeColorLow;
        if (bus.writeColorHigh)         this._writeColorHigh    = bus.writeColorHigh;
        if (bus.setGaIntStatus)         this._setGaIntStatus    = bus.setGaIntStatus;
        if (bus.getAsicRamEnabled)      this._getAsicRamEnabled = bus.getAsicRamEnabled;
        if (bus.setAsicRamEnabled)      this._setAsicRamEnabled = bus.setAsicRamEnabled;
        if (bus.readMemory)             this._readMemory        = bus.readMemory;
        if (bus.getDmaStatus)           this._getDmaStatus      = bus.getDmaStatus;
        if (bus.setDmaStatus)           this._setDmaStatus      = bus.setDmaStatus;
        if (bus.getDmaChannels)         this._getDmaChannels    = bus.getDmaChannels;
        if (bus.triggerDma)             this._triggerDma        = bus.triggerDma;
        if (bus.getTStates)             this._getTStates        = bus.getTStates;
        if (bus.executeTicks)           this._executeTicks      = bus.executeTicks;
        if (bus.getVlcCrtc)             this._getVlcCrtc        = bus.getVlcCrtc;
        if (bus.updateAsicUI)           this._updateAsicUI      = bus.updateAsicUI;
    },

    /**
     * The 15-byte magic byte sequence that must be written to the CRTC address port
     * in order to unlock the ASIC register space. Until the sequence is completed,
     * writes to 0x4000–0x4FFF are ignored and reads return 0xFF.
     * @type {number[]}
     */
    asicUnlockSequence: [
        0xFF, 0x77, 0xB3, 0x51, 0xA8, 0xD4,
        0x62, 0x39, 0x9C, 0x46, 0x2B, 0x15,
        0x8A, 0xCD, 0xEE
    ],

    /**
     * Index of the next expected byte in the unlock sequence (0–14).
     * Resets to 0 on any mismatch.
     * @type {number}
     */
    asicUnlockState: 0,

    /**
     * True while the ASIC is locked (unlock sequence not yet completed).
     * Cleared after the 15th correct byte is received; set again on machine reset.
     * @type {boolean}
     */
    asicLocked: true,

    /**
     * PRI (Pixel Replacement Image) control register.
     * Bit 0: enables sprite overlay over the display.
     * @type {number}
     */
    asicPri: 0,

    /**
     * Interrupt Vector Register — high byte of the Z80 IM2 interrupt vector supplied
     * by the ASIC. Default value 0x51 on power-on.
     * @type {number}
     */
    asicIvr: 0x51,

    /**
     * Split-screen start address high byte (bits 13–8 of the VRAM base address
     * for the lower display segment).
     * @type {number}
     */
    asicSsaHigh: 0,

    /**
     * Split-screen start address low byte.
     * @type {number}
     */
    asicSsaLow: 0,

    /**
     * Split-screen trigger line — the CRTC combined counter value (vcc<<3 | vlc_crtc)
     * at which the display switches to the split-screen start address.
     * @type {number}
     */
    asicSplitLine: 0,

    /**
     * Soft-scroll control register bit — when 1, resets the horizontal scroll offset
     * at the start of each display line (CRTC_Type3 renderBorder).
     * @type {number}
     */
    asicSscr: 0,

    /**
     * Horizontal soft-scroll offset (0–7 character clocks).
     * Applied by CRTC_Type3 as vlc = (vlc_crtc + asicHScroll) & 31.
     * @type {number}
     */
    asicHScroll: 0,

    /**
     * Vertical soft-scroll offset (0–15 raster lines).
     * @type {number}
     */
    asicVScroll: 0,

    /**
     * Pushes a plain state snapshot to the injected UI callback.
     * Has no effect if _updateAsicUI is not connected (headless / test environments).
     */
    updateUI() {
        if (!this._updateAsicUI) return;
        const { statusControl, channels } = ASIC_DMA_Controller;
        this._updateAsicUI({
            asicLocked      : this.asicLocked,
            asicRamEnabled  : this._getAsicRamEnabled(),
            statusControl,
            asicIvr         : this.asicIvr,
            asicPri         : this.asicPri,
            asicSplitLine   : this.asicSplitLine,
            asicSsaHigh     : this.asicSsaHigh,
            asicSsaLow      : this.asicSsaLow,
            asicSscr        : this.asicSscr,
            asicHScroll     : this.asicHScroll,
            asicVScroll     : this.asicVScroll,
            channels,
        });
    },

    /** No-op placeholder called during the standard module initialisation pass. */
    init() {},

    /**
     * Resets all ASIC registers to power-on defaults and re-locks the ASIC.
     */
    reset() {
        this.asicUnlockState = 0;
        this.asicLocked      = true;
        this.asicPri         = 0;
        this.asicIvr         = 0x51;
        this.asicSsaHigh     = 0;
        this.asicSsaLow      = 0;
        this.asicSplitLine   = 0;
        this.asicSscr        = 0;
        this.asicHScroll     = 0;
        this.asicVScroll     = 0;
    },

    /**
     * Advances the hardware unlock state machine by one byte.
     * Called from CRTC_Type0/1/2/3.select() on every CRTC address-port write.
     * When the full 15-byte sequence is matched, clears `asicLocked`.
     * Any mismatch resets the state machine to position 0.
     * @param {number} byte - The byte just written to the CRTC address port.
     */
    feedAsicUnlock(byte) {
        if (byte === this.asicUnlockSequence[this.asicUnlockState]) {
            if (this.asicUnlockState === 14) {
                this.asicLocked = false;
                this.asicUnlockState = 0;
            } else {
                this.asicUnlockState++;
            }
        } else {
            this.asicUnlockState = 0;
        }
    },

    /**
     * Reads a byte from the ASIC memory-mapped register space.
     * The `offset` is the address within the ASIC page (0x0000–0x2FFF):
     *   0x0000–0x0FFF  Sprite pixel data: id[offset>>8].priBuffer[offset & 0xFF]
     *   0x2000–0x23FF  Sprite attributes: x, y, magX/magY fields
     *   0x2400–0x243F  ASIC palette: 32 × 12-bit colours stored as 2 bytes each
     *   0x2800–0x2807  General registers: PRI, split, SSA, SSCR/HScroll/VScroll, IVR
     *   0x2C00–0x2C0F  DMA channel registers + status byte
     * @param {number} offset - Address offset within the ASIC page.
     * @returns {number} 8-bit value read, or 0xFF for unmapped addresses.
     */
    read(offset) {
        if (offset < 0x1000) {
            return PriManager.id[offset >>> 8].priBuffer[offset & 0xFF];
        }

        if (offset >= 0x2000 && offset <= 0x23FF) {
            const sprite = PriManager.id[(offset >>> 3) & 0x0F];
            switch (offset & 7) {
                case 0: return sprite.x & 0xFF;
                case 1: return sprite.x >>> 8;
                case 2: return sprite.y & 0xFF;
                case 3: return sprite.y >>> 8;
                case 4: return (sprite.magX << 2) | sprite.magY;
                default: return 0;
            }
        }

        if (offset >= 0x2400 && offset <= 0x243F) {
            const colorIdx = (offset >>> 1) & 0x1F;
            const c = this._getHwPalette(colorIdx);
            if ((offset & 1) === 0) {
                return ((c & 0x0F00) >>> 4) | (c & 0x000F);
            } else {
                return (c & 0x00F0) >>> 4;
            }
        }

        if (offset >= 0x2800 && offset <= 0x2807) {
            switch (offset & 7) {
                case 0: return this.asicPri;
                case 1: return this.asicSplitLine;
                case 2: return this.asicSsaHigh;
                case 3: return this.asicSsaLow;
                case 4: return (this.asicSscr << 7) | (this.asicHScroll << 4) | this.asicVScroll;
                case 5: return this.asicIvr;
                default: return 0xFF;
            }
        }

        if (offset >= 0x2C00 && offset <= 0x2C0F) {
            if ((offset & 0x0F) === 15) return this._getDmaStatus();
            const chId = (offset >>> 2) & 3;
            const ch = this._getDmaChannels()[chId];
            switch (offset & 3) {
                case 0: return ch.pointer & 0xFF;
                case 1: return (ch.pointer >>> 8) & 0xFF;
                case 2: return ch.prescalerBase;
            }
        }

        return 0xFF;
    },

    /**
     * Writes a byte to the ASIC memory-mapped register space.
     * Address regions and fields mirror the read() map.
     * Palette writes are split between writeColorLow (even offset) and
     * writeColorHigh (odd offset) to allow Gate Array to update its colour LUT.
     * @param {number} offset - Address offset within the ASIC page.
     * @param {number} value  - 8-bit value to write.
     */
    write(offset, value) {
        if (offset < 0x1000) {
            PriManager.id[offset >>> 8].priBuffer[offset & 0xFF] = value & 0x0F;
            return;
        }

        if (offset >= 0x2000 && offset <= 0x23FF) {
            const sprite = PriManager.id[(offset >>> 3) & 0x0F];
            switch (offset & 7) {
                case 0: sprite.x = (sprite.x & 0xFF00) | value; break;
                case 1: sprite.x = ((value & 3) << 8) | (sprite.x & 0xFF); break;
                case 2: sprite.y = (sprite.y & 0xFF00) | value; break;
                case 3: sprite.y = ((value & 3) << 8) | (sprite.y & 0xFF); break;
                case 4:
                    sprite.magX = (value >>> 2) & 3;
                    sprite.magY = value & 3;
                    break;
            }
            return;
        }

        if (offset >= 0x2400 && offset <= 0x243F) {
            const colorIdx = (offset >>> 1) & 0x1F;
            (offset & 1) === 0
                ? this._writeColorLow(colorIdx, value)
                : this._writeColorHigh(colorIdx, value);
            return;
        }

        if (offset >= 0x2800 && offset <= 0x2807) {
            switch (offset & 7) {
                case 0: this.asicPri = value; break;
                case 1: this.asicSplitLine = value; break;
                case 2: this.asicSsaHigh = value; break;
                case 3: this.asicSsaLow = value; break;
                case 4:
                    this.asicSscr    = value >>> 7;
                    this.asicHScroll = (value >>> 4) & 7;
                    this.asicVScroll = value & 0x0F;
                    break;
                case 5: this.asicIvr = value; break;
            }
            return;
        }

        if (offset >= 0x2C00 && offset <= 0x2C0F) {
            const chId = (offset >>> 2) & 3;
            const ch = this._getDmaChannels()[chId];
            switch (offset & 0x0F) {
                case 0: case 4: case 8: ch.pointer = (ch.pointer & 0xFF00) | (value & 0xFE); break;
                case 1: case 5: case 9: ch.pointer = (value << 8) | (ch.pointer & 0xFF); break;
                case 2: case 6: case 10: ch.prescalerBase = value; break;
                case 15:
                    this._getDmaStatus() = (this._getDmaStatus() & 0x80) | (value & 0x7F);
                    break;
            }
        }
    },
};


// =============================================================================
// ASIC_DMA_Controller
// =============================================================================

/**
 * @namespace ASIC_DMA_Controller
 * @description 3-channel DMA controller for the CPC+ ASIC.
 * Each channel reads a list of 16-bit instructions from RAM and issues PSG
 * register writes without CPU involvement, enabling autonomous sound effects.
 *
 * DMA instruction set (opcode = bits 14–12):
 *   0 — Write PSG: reg = bits 11–8, value = bits 7–0
 *   1 — Pause: load pauseValue from bits 11–0; stall for that many prescaler cycles
 *   2 — Loop start: record current pointer and loop count from bits 11–0
 *   4 — Flow control: bit 0 = loop-back if loopCount > 0,
 *                     bit 4 = raise interrupt, bit 5 = stop channel
 *
 * Each DMA cycle spans 6 sub-steps: fetch channels 0–2, then execute channels 0–2.
 * updateStatus() is called once per CRTC line to advance pause counters and set
 * the canExecute flag for each active channel.
 */
const ASIC_DMA_Controller = {

    /** @type {Function|null} Injected getter — reads a byte from the main address space. */
    _readMemory     : null,
    /**
     * Injected callback — writes a PSG register from the DMA pipeline.
     * Bypasses the normal CPU-driven PSG path.
     * @type {Function|null}
     */
    _writePsgDma    : null,
    /** @type {Function|null} Injected callback — sets a Gate Array interrupt status bit. */
    _setGaIntStatus : null,
    /** @type {Function|null} Injected callback — executes a given number of CPU ticks. */
    _executeTicks   : null,
    /** @type {Function|null} Injected getter — returns the current T-state count. */
    _getTStates     : null,

    /** @type {number} Active machine model index. */
    machineType: 2,

    /**
     * Wires dependencies from the central bus into this module.
     * @param {Object} bus - Dependency container built by CPC_Bus.
     */
    link(bus) {
        if ('machineType'   in bus) this.machineType     = bus.machineType;
        if (bus.readMemory)          this._readMemory     = bus.readMemory;
        if (bus.writePsgDma)         this._writePsgDma    = bus.writePsgDma;
        if (bus.setGaIntStatus)      this._setGaIntStatus = bus.setGaIntStatus;
        if (bus.executeTicks)        this._executeTicks   = bus.executeTicks;
        if (bus.getTStates)          this._getTStates     = bus.getTStates;
    },

    /**
     * The three DMA channels (populated in init()).
     * Stored as a dense array rather than new Array(3) so V8 uses contiguous
     * memory with direct-offset access rather than a hash-based dictionary.
     * @type {Array<{instruction:number, pointer:number, loopStart:number,
     *               loopCount:number, prescalerBase:number, prescalerCurrent:number,
     *               pauseValue:number, canExecute:boolean}>}
     */
    channels: [],

    /**
     * DMA Control and Status Register (8 bits).
     * Bits 2–0: channel enable flags (1 = active).
     * Bits 6–3: interrupt pending flags (set when a channel raises an interrupt).
     * Bit  7:   read-only internal state.
     * @type {number}
     */
    statusControl: 0,

    /**
     * Current sub-step within the 6-step DMA micro-cycle (0–5).
     * Steps 0–2 perform fetch for channels 0–2; steps 3–5 execute channels 0–2.
     * @type {number}
     */
    subStep: 0,

    /**
     * Initialises the DMA channel array and resets all state.
     * Each channel object is created with all properties set to their final
     * scalar types so V8 assigns a stable monomorphic hidden class.
     */
    init() {
        this.subStep       = 0;
        this.statusControl = 0;

        this.channels = [];
        for (let i = 0; i <= 2; i++) {
            this.channels.push({
                instruction     : 0,
                pointer         : 0,
                loopStart       : 0,
                loopCount       : 0,
                prescalerBase   : 0,
                prescalerCurrent: 0,
                pauseValue      : 0,
                canExecute      : false,
            });
        }
    },

    /**
     * Updates the canExecute flag and pause counters for all active channels.
     * Called once per CRTC scanline. Also resets subStep to 0 for the next tick cycle.
     * A channel is executable if it is enabled (statusControl bit set) and its
     * pauseValue has counted down to zero.
     */
    updateStatus() {
        this.subStep = 0;

        for (let i = 0; i <= 2; i++) {
            const ch = this.channels[i];

            if ((this.statusControl & (1 << i)) !== 0) {
                if (ch.pauseValue !== 0) {
                    if (ch.prescalerCurrent === 0) {
                        ch.pauseValue--;
                        ch.prescalerCurrent = ch.prescalerBase;
                    } else {
                        ch.prescalerCurrent--;
                    }
                }
                ch.canExecute = (ch.pauseValue === 0);
            } else {
                ch.canExecute = false;
            }
        }
    },

    /**
     * Advances the DMA micro-cycle by one sub-step.
     * Sub-steps 0–2 fetch the next instruction word for channels 0–2 respectively.
     * Sub-steps 3–5 decode and execute the fetched instruction for each channel.
     * Only channels with canExecute == true participate.
     */
    tick() {
        const { subStep } = this;

        if      (subStep === 0 && this.channels[0].canExecute) this.fetch(0);
        else if (subStep === 1 && this.channels[1].canExecute) this.fetch(1);
        else if (subStep === 2 && this.channels[2].canExecute) this.fetch(2);
        else if (subStep === 3 && this.channels[0].canExecute) this.execute(0);
        else if (subStep === 4 && this.channels[1].canExecute) this.execute(1);
        else if (subStep === 5 && this.channels[2].canExecute) this.execute(2);

        this.subStep++;
    },

    /**
     * Reads a 16-bit instruction word from RAM at the channel's current pointer
     * and advances the pointer by 2. Little-endian byte order.
     * @param {number} chId - Channel index (0–2).
     */
    fetch(chId) {
        const ch = this.channels[chId];
        const lo = this._readMemory(ch.pointer);
        const hi = this._readMemory((ch.pointer + 1) & 0xFFFF);

        ch.instruction = (hi << 8) | lo;
        ch.pointer     = (ch.pointer + 2) & 0xFFFF;
    },

    /**
     * Decodes and executes the instruction stored in ch.instruction.
     * Opcode is bits 14–12 of the instruction word.
     * @param {number} chId - Channel index (0–2).
     */
    execute(chId) {
        const ch     = this.channels[chId];
        const opcode = (ch.instruction >>> 12) & 0x7;

        switch (opcode) {

            case 0:
                this._writePsgDma(
                    (ch.instruction >>> 8) & 0x0F,
                     ch.instruction        & 0xFF
                );
                break;

            case 1:
                ch.pauseValue       = ch.instruction & 0x0FFF;
                ch.prescalerCurrent = ch.prescalerBase;
                break;

            case 2:
                ch.loopStart = ch.pointer;
                ch.loopCount = ch.instruction & 0x0FFF;
                break;

            case 4: {
                const flags = ch.instruction & 0x31;
                if (flags === 0) break;

                if ((flags & 0x01) && ch.loopCount !== 0) {
                    ch.loopCount--;
                    ch.pointer = ch.loopStart;
                }

                if (flags & 0x10) {
                    const intBit = 1 << (6 - chId);
                    this.statusControl       |= intBit;
                    this._setGaIntStatus(intBit);
                }

                if (flags & 0x20) {
                    this.statusControl &= ~(1 << chId);
                }
                break;
            }

            default:
                console.log(
                    `[DMA${chId}] @T=${this._getTStates()} ` +
                    `Invalid opcode: 0x${toHex16(ch.instruction)}`
                );
        }
    },
};


// =============================================================================
// PriManager
// =============================================================================

/**
 * @namespace PriManager
 * @description Hardware sprite engine for the CPC+ ASIC.
 * Manages 16 independent 16×16 pixel sprites (PRI = Pixel Replacement Image)
 * and composites them into a per-line scan buffer at the start of each character row.
 *
 * Each sprite carries:
 *   - priBuffer: 256-byte pixel array (16 rows × 16 columns, 4 bits per pixel)
 *   - x, y: screen position (9-bit values)
 *   - magX, magY: horizontal and vertical magnification (1×, 2×, or 4×)
 *
 * renderAsicSplit() is called by CRTC_Type3.updateVertical() on every character-row
 * boundary and rebuilds the 1024-byte scan buffer from the current sprite state.
 * Sprites are rendered back-to-front (sprite 15 first, sprite 0 last) so sprite 0
 * has the highest priority (drawn on top).
 */
const PriManager = {

    /** @type {Function|null} Injected getter — returns the current CRTC vertical character counter. */
    _getVcc    : null,
    /** @type {Function|null} Injected getter — returns the raw CRTC vertical line counter. */
    _getVlcCrtc: null,

    /**
     * Wires dependencies from the central bus into this module.
     * @param {Object} bus - Dependency container built by CPC_Bus.
     */
    link(bus) {
        if (bus.getVcc)     this._getVcc     = bus.getVcc;
        if (bus.getVlcCrtc) this._getVlcCrtc = bus.getVlcCrtc;
    },

    /**
     * Composited scan-line buffer — 1024 bytes representing one horizontal line of
     * sprite pixels. Non-zero entries override the corresponding display pixel.
     * Rebuilt every character row by renderAsicSplit().
     * @type {Uint8Array}
     */
    buffer: new Uint8Array(1024),

    /** @type {number} Index into the audio DMA output buffer (used by the PSG DMA path). */
    audioBufferIndex: 0,

    /**
     * Array of 16 sprite descriptor objects (initialised in init()).
     * @type {Array<{priBuffer:Uint8Array, x:number, y:number, magX:number, magY:number}>}
     */
    id: new Array(16),

    /**
     * Allocates all 16 sprite objects with their pixel buffers and attribute fields.
     * Called once at startup.
     */
    init() {
        for (let i = 0; i <= 15; i++) {
            this.id[i] = {
                priBuffer: new Uint8Array(256),
                x: 0,
                y: 0,
                magX: 0,
                magY: 0,
            };
        }
    },

    /**
     * Resets all sprite attributes to zero and clears the scan-line buffer.
     * Pixel data (priBuffer) is zeroed rather than randomised — the CPC+ ROMs
     * initialise sprites before any rendering, and magX=0/magY=0 suppresses
     * rendering regardless, making random initialisation unnecessary.
     */
    reset() {
        for (let i = 0; i <= 15; i++) {
            const sprite = this.id[i];
            sprite.x    = 0;
            sprite.y    = 0;
            sprite.magX = 0;
            sprite.magY = 0;
            sprite.priBuffer.fill(0);
        }
        this.clearAsicRam();
        this.audioBufferIndex = 0;
    },

    /**
     * Zeroes the composited scan-line buffer.
     */
    clearAsicRam() {
        this.buffer.fill(0);
    },

    /**
     * Rebuilds the scan-line sprite buffer for the current character row.
     * Clears the buffer, then renders all 16 sprites back-to-front so that
     * lower-indexed sprites appear on top of higher-indexed ones.
     */
    renderAsicSplit() {
        this.clearAsicRam();
        for (let i = 15; i >= 0; i--) {
            this.renderAsicLine(i);
        }
    },

    /**
     * Renders one sprite's contribution to the scan-line buffer.
     * Skips sprites with magX == 0 or magY == 0 (disabled).
     *
     * The sprite row to render is: lineInSprite = diff >> shiftY, where
     *   diff = (currentY - sprite.y) & 0x1FF  (wraps at 512 lines)
     *   shiftY: magY=1 → no shift (1×), magY=2 → shift 1 (2×), magY=3 → shift 2 (4×)
     *
     * Horizontal magnification:
     *   magX=1 → each pixel occupies 1 column
     *   magX=2 → each pixel occupies 2 columns (doubled)
     *   magX=3 → each pixel occupies 4 columns (quadrupled)
     *
     * Only non-zero (non-transparent) pixels are written to the buffer.
     * @param {number} spriteIdx - Sprite index (0–15).
     */
    renderAsicLine(spriteIdx) {
        const sprite = this.id[spriteIdx];
        if (sprite.magX === 0 || sprite.magY === 0) return;

        const currentY = (this._getVcc() << 3) | (this._getVlcCrtc() & 7);
        const diff = (currentY - sprite.y) & 0x1FF;

        const shiftY = sprite.magY === 3 ? 2 : sprite.magY - 1;
        const lineInSprite = diff >>> shiftY;

        if (lineInSprite > 15) return;

        const srcRow = lineInSprite << 4;
        const dst    = sprite.x;

        switch (sprite.magX) {
            case 1:
                for (let col = 0; col <= 15; col++) {
                    const pixel = sprite.priBuffer[srcRow + col];
                    if (pixel !== 0) this.buffer[(dst + col) & 0x3FF] = pixel;
                }
                break;

            case 2:
                for (let col = 0; col <= 15; col++) {
                    const pixel = sprite.priBuffer[srcRow + col];
                    if (pixel !== 0) {
                        const base = dst + (col << 1);
                        this.buffer[ base        & 0x3FF] = pixel;
                        this.buffer[(base + 1)   & 0x3FF] = pixel;
                    }
                }
                break;

            case 3:
                for (let col = 0; col <= 15; col++) {
                    const pixel = sprite.priBuffer[srcRow + col];
                    if (pixel !== 0) {
                        const base = dst + (col << 2);
                        this.buffer[ base        & 0x3FF] = pixel;
                        this.buffer[(base + 1)   & 0x3FF] = pixel;
                        this.buffer[(base + 2)   & 0x3FF] = pixel;
                        this.buffer[(base + 3)   & 0x3FF] = pixel;
                    }
                }
                break;
        }
    },
};

// =============================================================================
// UI integration note (for CPC_Bus.js / UI_DOM.js)
// =============================================================================
//
// Implement the following function in UI_DOM.js and wire it into CPC_Bus.js
// as the updateAsicUI callback:
//
//   function updateAsicUIDom(state) {
//     const { statusControl, asicIvr, asicPri, asicSplitLine,
//             asicSsaHigh, asicSsaLow, asicSscr, asicHScroll, asicVScroll,
//             asicLocked, asicRamEnabled, channels } = state;
//
//     asicLocked
//       ? $("#asic_unlocked").removeAttr("checked")
//       : $("#asic_unlocked").attr("checked", "checked");
//     asicRamEnabled
//       ? $("#asic_ram").attr("checked", "checked")
//       : $("#asic_ram").removeAttr("checked");
//
//     $("#asic_dcsr").text(toHex8(statusControl));
//     $("#asic_ivr") .text(toHex8(asicIvr));
//     $("#asic_pri") .text(toHex8(asicPri));
//     $("#asic_splt").text(toHex8(asicSplitLine));
//     $("#asic_ssa") .text(toHex16((asicSsaHigh << 8) | asicSsaLow));
//     $("#asic_sscr").text(toHex8((asicSscr << 7) | (asicHScroll << 4) | asicVScroll));
//
//     for (let i = 0; i <= 2; i++) {
//       const ch = channels[i];
//       $(`#dma${i}_addr`).text(toHex16(ch.pointer));
//       $(`#dma${i}_loopAddr`).text(toHex16(ch.loopStart));
//       $(`#dma${i}_loopCounter`).text(toHex16(ch.loopCount));
//     }
//   }
//
// In CPC_Bus.js, add to the ASIC_Manager bus:
//   updateAsicUI: (state) => updateAsicUIDom(state),
