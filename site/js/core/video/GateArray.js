"use strict";

/**
 * @module Palette_Colors
 * @description Emulation of the Amstrad Gate Array (PAL016 / 40010 chip).
 *
 * Responsibilities:
 *   - Hardware palette: 16 ink registers + border (CPC) / 32 colour registers (CPC+)
 *   - Z80 interrupt generation based on scanline count and VSync timing
 *   - ROM/RAM banking notifications to ROM_Manager
 *   - Video mode (0/1/2/3) switching and pixel LUT management
 *   - CPC+ ASIC unlock sequence detection, DMA update triggers, 12-bit colour
 *
 * All dependencies are injected via {@link Palette_Colors.link} (wired in CPC_Bus.js).
 *
 * JIT optimisation notes:
 *   - All scalar properties are initialised to their final types so V8/SpiderMonkey
 *     builds a monomorphic hidden class at construction time.
 *   - `colorUpdateFunc` (method reference) replaced by integer enum + switch:
 *     storing a function reference in a property forces a polymorphic shape;
 *     an integer is always a number → monomorphic, better branch prediction.
 */

/**
 * Colour update type — no pending update.
 * @type {number}
 */
const COLOR_UPDATE_NONE     = 0;
/**
 * Colour update type — standard CPC hardware colour (0–31).
 * @type {number}
 */
const COLOR_UPDATE_HW       = 1;
/**
 * Colour update type — CPC+ ASIC 12-bit colour, low byte (R + B nibbles).
 * @type {number}
 */
const COLOR_UPDATE_ASIC_LOW = 2;
/**
 * Colour update type — CPC+ ASIC 12-bit colour, high byte (G nibble).
 * @type {number}
 */
const COLOR_UPDATE_ASIC_HI  = 3;


const Palette_Colors = {

    /** @type {Function|null} */ _setHwPalette         : null,
    /** @type {Function|null} */ _setRenderMode        : null,
    /** @type {Function|null} */ _renderBlank          : null,
    /** @type {Function|null} */ _renderBorder         : null,
    /** @type {Function|null} */ _renderPixelFunc      : null,
    /** @type {Function|null} */ _skipRender           : null,
    /** @type {Function|null} */ _advancePixel         : null,
    /** @type {Function|null} */ _syncPhase            : null,
    /** @type {Function|null} */ _triggerVBlank        : null,
    /** @type {Function|null} */ _adjustPLL            : null,
    /** @type {Function|null} */ _selectAsicRom        : null,
    /** @type {Function|null} */ _updateRomConfig      : null,
    /** @type {Function|null} */ _triggerAsicDmaUpdate : null,
    /** @type {Function|null} */ _setDmaStatusControl  : null,
    /** @type {Function|null} */ _getHsyncActive       : null,
    /** @type {Function|null} */ _getVsyncActive       : null,
    /** @type {Function|null} */ _getVcc               : null,
    /** @type {Function|null} */ _getVlcCrtc           : null,
    /** @type {Function|null} */ _getAsicLocked        : null,
    /** @type {Function|null} */ _getAsicPri           : null,
    /** @type {Function|null} */ _getAsicIvr           : null,
    /** @type {Function|null} */ _getDmaStatusControl  : null,
    /** @type {Function|null} */ _getVblankCounter     : null,
    /** @type {Function|null} */ _getLineBufferOffset  : null,
    /** @type {Function|null} */ _getLineBufferLimit   : null,
    /** @type {Function|null} */ _getPixelIndex        : null,
    /** @type {Function|null} */ _getRamData           : null,
    /**
     * Direct reference to the video RAM Uint8Array.
     * Assigned in link() for zero-overhead access in the pixel render hot path.
     * @type {Uint8Array|null}
     */
    ramArray              : null,
    /** @type {Function|null} */ _getBorder            : null,
    /** @type {Function|null} */ _getMaRow             : null,
    /** @type {Function|null} */ _getVlc               : null,
    /** @type {Function|null} */ _getMonitorPalette    : null,

    /** @type {number} Active machine type (0=464 … 5=464+). */
    machineType   : 2,

    /**
     * Injects all external dependencies from CPC_Bus.js.
     * @param {Object} bus - Dependency container.
     */
    link(bus) {
        if ('machineType'        in bus) this.machineType          = bus.machineType;
        if (bus.getMonitorPalette)        this._getMonitorPalette   = bus.getMonitorPalette;
        if (bus.setHwPalette)             this._setHwPalette        = bus.setHwPalette;
        if (bus.setRenderMode)            this._setRenderMode       = bus.setRenderMode;
        if (bus.renderBlank)              this._renderBlank         = bus.renderBlank;
        if (bus.renderBorder)             this._renderBorder        = bus.renderBorder;
        if (bus.renderPixelFunc)          this._renderPixelFunc     = bus.renderPixelFunc;
        if (bus.skipRender)               this._skipRender          = bus.skipRender;
        if (bus.advancePixel)             this._advancePixel        = bus.advancePixel;
        if (bus.syncPhase)                this._syncPhase           = bus.syncPhase;
        if (bus.triggerVBlank)            this._triggerVBlank       = bus.triggerVBlank;
        if (bus.adjustPLL)                this._adjustPLL           = bus.adjustPLL;
        if (bus.selectAsicRom)            this._selectAsicRom       = bus.selectAsicRom;
        if (bus.updateRomConfig)          this._updateRomConfig     = bus.updateRomConfig;
        if (bus.triggerAsicDmaUpdate)     this._triggerAsicDmaUpdate = bus.triggerAsicDmaUpdate;
        if (bus.setDmaStatusControl)      this._setDmaStatusControl  = bus.setDmaStatusControl;
        if (bus.getHsyncActive)           this._getHsyncActive       = bus.getHsyncActive;
        if (bus.getVsyncActive)           this._getVsyncActive       = bus.getVsyncActive;
        if (bus.getVcc)                   this._getVcc               = bus.getVcc;
        if (bus.getVlcCrtc)               this._getVlcCrtc           = bus.getVlcCrtc;
        if (bus.getAsicLocked)            this._getAsicLocked        = bus.getAsicLocked;
        if (bus.getAsicPri)               this._getAsicPri           = bus.getAsicPri;
        if (bus.getAsicIvr)               this._getAsicIvr           = bus.getAsicIvr;
        if (bus.getDmaStatusControl)      this._getDmaStatusControl   = bus.getDmaStatusControl;
        if (bus.getVblankCounter)         this._getVblankCounter      = bus.getVblankCounter;
        if (bus.getLineBufferOffset)      this._getLineBufferOffset   = bus.getLineBufferOffset;
        if (bus.getLineBufferLimit)       this._getLineBufferLimit    = bus.getLineBufferLimit;
        if (bus.getPixelIndex)            this._getPixelIndex         = bus.getPixelIndex;
        if (bus.getRamData)               this._getRamData            = bus.getRamData;
        if (bus.getRamArrayRef)           this.ramArray               = bus.getRamArrayRef();
        if (bus.getBorder)                this._getBorder             = bus.getBorder;
        if (bus.getMaRow)                 this._getMaRow              = bus.getMaRow;
        if (bus.getVlc)                   this._getVlc                = bus.getVlc;
    },

    /**
     * Hardware colour values per pen (0–31).
     * Stores the raw Gate Array colour index (0–31), or -1 for 12-bit ASIC colours.
     * Int16Array supports -1 unambiguously.
     * @type {Int16Array}
     */
    hwColorValues   : new Int16Array(32),

    /**
     * Monitor palette indices per pen (0–4095).
     * Used as an index into the active monitor palette array
     * (paletteColor / paletteGreen / paletteGray in Video_Hardware).
     * @type {Uint16Array}
     */
    hwColorIndex    : new Uint16Array(32),

    /**
     * Look-up table: hardware colour index (0–31) → monitor palette index (0–4095).
     * Pre-computed from the official Amstrad colour table.
     * @type {Uint16Array}
     */
    hwColorToPalette: new Uint16Array(32),

    /**
     * Pixel look-up table for Mode 0 (4 bits per pixel, 16 colours, 2 pixels per byte).
     * Converts a raw byte from video RAM into a pair of 4-bit pen indices.
     * Algorithm: bit-interleaving — the 8 bits of a byte encode two 4-bit pixels
     * with bits interleaved as: p1[3] p0[3] p1[2] p0[2] p1[1] p0[1] p1[0] p0[0].
     * @type {Uint8Array}
     */
    lutMode0: new Uint8Array(256),

    /**
     * Pixel LUT for Mode 1 (2 bits per pixel, 4 colours, 4 pixels per byte).
     * Bits interleaved as: p3[1] p2[1] p1[1] p0[1] p3[0] p2[0] p1[0] p0[0].
     * @type {Uint8Array}
     */
    lutMode1: new Uint8Array(256),

    /**
     * Pixel LUT for Mode 2 (1 bit per pixel, 2 colours, 8 pixels per byte).
     * Standard MSB-first bit ordering.
     * @type {Uint8Array}
     */
    lutMode2: new Uint8Array(256),

    /**
     * Pixel LUT for Mode 3 (same 4-colour as Mode 1 but with different palette mapping).
     * Used internally by the Gate Array; not normally accessible from BASIC.
     * @type {Uint8Array}
     */
    lutMode3: new Uint8Array(256),

    /** Accumulated Gate Array interrupt status flags. @type {number} */
    gaIntStatus    : 0,
    /** Scanline counter — triggers a Z80 interrupt every 52 scanlines. @type {number} */
    scanlineCounter: 0,
    /** Countdown after VSync before the interrupt is generated (2 lines). @type {number} */
    interruptDelay : 0,
    /** Currently selected pen register (0–16; 16 = border). @type {number} */
    selectedPen    : 0,
    /** Cached HSync active state (mirrors CRTC). @type {boolean} */
    hsyncActive    : false,
    /** Cached VSync active state (mirrors CRTC). @type {boolean} */
    vsyncActive    : false,
    /** Number of Gate Array clock cycles since HSync started. @type {number} */
    hsyncCounter   : 0,
    /** Whether a colour update is queued for the next tick. @type {boolean} */
    colorQueued     : false,
    /**
     * Type of queued colour update (one of COLOR_UPDATE_* constants).
     * Integer enum for monomorphic JIT shape.
     * @type {number}
     */
    colorUpdateType : COLOR_UPDATE_NONE,
    /** Target pen index for the queued colour update. @type {number} */
    colorUpdatePen  : 0,
    /** Colour value for the queued update. @type {number} */
    colorUpdateValue: 0,
    /** Current video mode (0–3), set from Gate Array ROM config bits. @type {number} */
    romConfig      : 0,
    /**
     * Active pixel LUT (one of lutMode0–lutMode3).
     * Null only before init(); always assigned in init().
     * @type {Uint8Array|null}
     */
    currentLut     : null,
    /** Whether an ASIC split-screen is currently active. @type {number} */
    asicSplitActive: 0,
    /** Whether the current CRTC position is in the border area. @type {boolean} */
    border         : false,
    /** Current video RAM byte address being rendered. @type {number} */
    videoAddress   : 0,
    /** Whether a VSync-triggered interrupt is pending for this frame. @type {boolean} */
    vsyncTriggered : false,

    /**
     * Initialises palette tables and pixel LUTs.
     *
     * Hardware colour table (`hwColorToPalette`):
     *   Maps the 32 Gate Array colour indices to 12-bit palette indices (0–4095)
     *   derived from the official Amstrad colour specification.
     *   Each 12-bit value encodes R/G/B as three 4-bit nibbles (0x0RGB).
     *
     * Pixel LUT construction (Mode 0 example — bit-interleaving):
     *   CPC Mode 0 stores two 4-bit pen indices per byte with bits interleaved.
     *   For input byte `a`, the LUT entry places the 8 input bits into two
     *   4-bit output nibbles using the formula:
     *     hi = ((a&2)<<2)|((a&32)>>>3)|((a&8)>>>2)|((a&128)>>>7)
     *     lo = ((a&1)<<7)|((a&16)<<2)|((a&4)<<3)|((a&64)>>>2)
     *   Modes 1, 2, and 3 apply analogous (but distinct) de-interleaving patterns.
     *   All four LUTs are pre-computed once here for O(1) per-pixel lookup.
     */
    init() {
        this.hwColorValues.fill(20, 0, 17);
        this.hwColorValues.fill(-1, 17, 32);
        this.hwColorIndex.fill(0);

        const hwToP = this.hwColorToPalette;
        hwToP[ 0]=1638; hwToP[ 1]=1638; hwToP[ 2]= 246; hwToP[ 3]=4086;
        hwToP[ 4]=   6; hwToP[ 5]=3846; hwToP[ 6]= 102; hwToP[ 7]=3942;
        hwToP[ 8]=3846; hwToP[ 9]=4086; hwToP[10]=4080; hwToP[11]=4095;
        hwToP[12]=3840; hwToP[13]=3855; hwToP[14]=3936; hwToP[15]=3951;
        hwToP[16]=   6; hwToP[17]= 246; hwToP[18]= 240; hwToP[19]= 255;
        hwToP[20]=   0; hwToP[21]=  15; hwToP[22]=  96; hwToP[23]= 111;
        hwToP[24]=1542; hwToP[25]=1782; hwToP[26]=1776; hwToP[27]=1791;
        hwToP[28]=1536; hwToP[29]=1551; hwToP[30]=1632; hwToP[31]=1647;

        for (let a = 0; a <= 255; a++) {
            this.lutMode0[a] =  ((a &   2) << 2) | ((a &  32) >>> 3) | ((a &  8) >>> 2) | ((a & 128) >>> 7)
                              | ((a &   1) << 7) | ((a &  16) <<  2) | ((a &  4) <<  3) | ((a &  64) >>> 2);
            this.lutMode1[a] =  ((a &   8) >>> 2) | ((a & 128) >>> 7)
                              | ((a &   4) <<  1) | ((a &  64) >>> 4)
                              | ((a &   2) <<  4) | ((a &  32) >>> 1)
                              | ((a &   1) <<  7) | ((a &  16) <<  2);
            this.lutMode2[a] =  ((a &   1) << 7) | ((a &   2) << 5) | ((a &  4) << 3) | ((a &   8) << 1)
                              | ((a &  16) >>> 1) | ((a &  32) >>> 3) | ((a & 64) >>> 5) | ((a & 128) >>> 7);
            this.lutMode3[a] =  ((a &   8) >>> 2) | ((a & 128) >>> 7)
                              | ((a &   4) <<  3) | ((a &  64) >>> 2);
        }

        this.currentLut = this.lutMode0;
    },

    /**
     * Resets Gate Array state to power-on defaults.
     * Re-randomises ASIC colour slots 17–31 to simulate uninitialised DRAM.
     */
    reset() {
        this.selectedPen     = 0;
        this.interruptDelay  = 0;
        this.scanlineCounter = 0;
        this.gaIntStatus     = 0;
        this.vsyncActive     = false;
        this.hsyncActive     = false;
        this.hsyncCounter    = 0;
        this.colorQueued     = false;
        this.vsyncTriggered  = false;
        this.colorUpdateType  = COLOR_UPDATE_NONE;
        this.colorUpdatePen   = 0;
        this.colorUpdateValue = 0;
        this.romConfig       = 0;
        this.asicSplitActive = 0;
        this.videoAddress    = 0;
        this.border          = false;

        for (let i = 0; i <= 16; i++) this.setHardwareColor(i, 20);
        for (let i = 17; i <= 31; i++) {
            this.setAsicColorLow (i, Math.floor(256 * Math.random()));
            this.setAsicColorHigh(i, Math.floor(256 * Math.random()));
        }

        this._setRenderMode(0);
        this.currentLut = this.lutMode0;
    },

    /**
     * Handles a Z80 OUT to the Gate Array port (A15:A14 = 01).
     * Command is decoded from bits 7:5 of the data byte:
     *   00x → select pen (bit 4=1 selects border pen 16)
     *   01x → queue colour update for selected pen
     *   10x → ROM config / ASIC select (CPC+)
     * @param {number} addr - 16-bit port address.
     * @param {number} data - 8-bit command byte.
     */
    writePort(addr, data) {
        if ((addr >>> 14) !== 1) return;

        switch (data >>> 5) {
            case 0: case 1:
                this.selectedPen = (data & 0x10) ? 16 : (data & 0x0F);
                break;
            case 2: case 3:
                this.queueColorUpdate(this.selectedPen, data & 31);
                break;
            case 4: case 5:
                if (!this._getAsicLocked() && (data >>> 5) === 5) {
                    this._selectAsicRom(data);
                } else {
                    if (data & 0x10) { this.gaIntStatus &= 0x7F; this.scanlineCounter = 0; }
                    this._updateRomConfig(data);
                }
                break;
        }
    },

    /**
     * Called every T-state to check for HSync/VSync transitions and
     * fire Z80 interrupts at the correct scanline counts.
     *
     * Interrupt logic:
     *   - A Z80 interrupt is generated every 52 scanlines (normal mode)
     *     or at a CRTC position matching asicPri (CPC+ mode).
     *   - VSync delays the interrupt counter by 2 scanlines.
     *   - HSync counter is used to time PLL phase adjustment.
     */
    checkInterrupts() {
        if (this.hsyncActive) {
            this.hsyncCounter++;

            if (!this.vsyncTriggered && this._getAsicPri() !== 0) {
                if ((this._getVcc() << 3 | this._getVlcCrtc()) === this._getAsicPri()) {
                    this.triggerInterrupt();
                    this.vsyncTriggered = true;
                }
            }
            if (this.hsyncCounter === 2 && this.machineType >= 4) this._triggerAsicDmaUpdate();
            if (this.hsyncCounter === 6) this.updatePll();
        }

        if (this._getHsyncActive() !== this.hsyncActive) {
            this.hsyncActive = this._getHsyncActive();
            if (this.hsyncActive) {
                this._syncPhase();
                this.hsyncCounter = 0;
            } else {
                this.tickScanline();
                if (this.hsyncCounter < 6) this.updatePll();
            }
        }

        if (this._getVsyncActive() !== this.vsyncActive) {
            this.vsyncActive = this._getVsyncActive();
            if (this.vsyncActive) {
                this.interruptDelay = 2;
                this._triggerVBlank();
            }
        }
    },

    /**
     * Advances the scanline interrupt counter and handles VSync delay.
     * Triggers an interrupt when the counter reaches 52 (or after the VSync delay expires).
     */
    tickScanline() {
        this.scanlineCounter++;
        if (this.interruptDelay > 0) {
            this.interruptDelay--;
            if (this.interruptDelay === 0) {
                if (this.scanlineCounter > 31 && this._getAsicPri() === 0) {
                    this.triggerInterrupt();
                }
                this.scanlineCounter = 0;
            }
        }
        if (this.scanlineCounter > 51) {
            this.scanlineCounter = 0;
            if (this._getAsicPri() === 0) this.triggerInterrupt();
        }
        this.vsyncTriggered = false;
    },

    /**
     * Applies the current video mode LUT and adjusts the PLL.
     */
    updatePll() {
        this.applyPaletteMode();
        this._adjustPLL();
    },

    /**
     * Sets the Gate Array interrupt-pending flag (bit 7 of gaIntStatus).
     */
    triggerInterrupt() {
        this.gaIntStatus |= 0x80;
    },

    /**
     * Acknowledges the pending Z80 interrupt and returns the interrupt vector offset.
     * Resets the scanline counter modulo 32 and clears the appropriate interrupt bit.
     * On CPC+ (machineType ≥ 4), returns the ASIC IVR value with the offset applied.
     * @returns {number} Interrupt vector offset (0, 2, 4, or 6) or 0xFF (standard CPC).
     */
    acknowledgeInterrupt() {
        this.scanlineCounter &= 31;
        let ivOffset;
        if (this.gaIntStatus & 0x80) {
            ivOffset = 6; this.gaIntStatus &= 0x7F;
            this._setDmaStatusControl(this._getDmaStatusControl() | 0x80);
        } else if (this.gaIntStatus & 0x40) {
            ivOffset = 4; this.gaIntStatus &= 0xBF;
            this._setDmaStatusControl(this._getDmaStatusControl() & 0xBF);
        } else if (this.gaIntStatus & 0x20) {
            ivOffset = 2; this.gaIntStatus &= 0xDF;
            this._setDmaStatusControl(this._getDmaStatusControl() & 0xDF);
        } else if (this.gaIntStatus & 0x10) {
            ivOffset = 0; this.gaIntStatus &= 0xEF;
            this._setDmaStatusControl(this._getDmaStatusControl() & 0xEF);
        }
        return (this.machineType >= 4) ? ((this._getAsicIvr() & 0xF8) | ivOffset) : 0xFF;
    },

    /**
     * Applies a queued colour update (if any) to the hardware palette.
     * The update type dispatches to the appropriate setter via an integer enum
     * switch, which the JIT can predict reliably (monomorphic shape).
     */
    applyQueuedColor() {
        if (this.colorQueued) {
            this.colorQueued = false;
            switch (this.colorUpdateType) {
                case COLOR_UPDATE_HW:
                    this.setHardwareColor(this.colorUpdatePen, this.colorUpdateValue);
                    break;
                case COLOR_UPDATE_ASIC_LOW:
                    this.setAsicColorLow(this.colorUpdatePen, this.colorUpdateValue);
                    break;
                case COLOR_UPDATE_ASIC_HI:
                    this.setAsicColorHigh(this.colorUpdatePen, this.colorUpdateValue);
                    break;
            }
        }
    },

    /**
     * Queues a standard hardware colour update for the next tick boundary.
     * @param {number} pen   - Pen index (0–16).
     * @param {number} value - Hardware colour index (0–31).
     */
    queueColorUpdate(pen, value) {
        this.colorQueued     = true;
        this.colorUpdateType  = COLOR_UPDATE_HW;
        this.colorUpdatePen   = pen;
        this.colorUpdateValue = value;
    },

    /**
     * Queues a CPC+ ASIC low-byte colour write for the next tick boundary.
     * @param {number} pen   - Pen index (0–31).
     * @param {number} value - Low byte: bits 7:4 = Red, bits 3:0 = Blue.
     */
    writeAsicColorLow(pen, value) {
        this.colorQueued     = true;
        this.colorUpdateType  = COLOR_UPDATE_ASIC_LOW;
        this.colorUpdatePen   = pen;
        this.colorUpdateValue = value;
    },

    /**
     * Queues a CPC+ ASIC high-byte colour write for the next tick boundary.
     * @param {number} pen   - Pen index (0–31).
     * @param {number} value - High byte: bits 3:0 = Green.
     */
    writeAsicColorHigh(pen, value) {
        this.colorQueued     = true;
        this.colorUpdateType  = COLOR_UPDATE_ASIC_HI;
        this.colorUpdatePen   = pen;
        this.colorUpdateValue = value;
    },

    /**
     * Sets a standard hardware colour for a pen using the official Amstrad palette table.
     * Updates hwColorValues, hwColorIndex, and the rendered Video_Hardware palette entry.
     * @param {number} pen     - Pen index (0–16).
     * @param {number} hwColor - Hardware colour index (0–31).
     */
    setHardwareColor(pen, hwColor) {
        this.hwColorValues[pen] = hwColor;
        const palVal = this.hwColorToPalette[hwColor];
        this.hwColorIndex[pen] = palVal;
        this._setHwPalette(pen, this._getMonitorPalette()[palVal]);
    },

    /**
     * Sets the low byte of a CPC+ ASIC 12-bit colour.
     * Encodes Red (bits 7:4 → bits 11:8) and Blue (bits 3:0 → bits 3:0)
     * while preserving the existing Green component (bits 7:4).
     * @param {number} pen   - Pen index (0–31).
     * @param {number} value - Low byte value.
     */
    setAsicColorLow(pen, value) {
        this.hwColorValues[pen] = -1;
        const oldGreen = this.hwColorIndex[pen] & 0x00F0;
        const newRed   = (value & 0xF0) << 4;
        const newBlue  = value & 0x0F;
        const c = newRed | oldGreen | newBlue;
        this.hwColorIndex[pen] = c;
        this._setHwPalette(pen, this._getMonitorPalette()[c]);
    },

    /**
     * Sets the high byte of a CPC+ ASIC 12-bit colour.
     * Encodes Green (bits 3:0 → bits 7:4) while preserving Red and Blue.
     * @param {number} pen   - Pen index (0–31).
     * @param {number} value - High byte value (bits 3:0 = Green).
     */
    setAsicColorHigh(pen, value) {
        this.hwColorValues[pen] = -1;
        const oldRedBlue = this.hwColorIndex[pen] & 0x0F0F;
        const newGreen   = (value & 0x0F) << 4;
        const c = oldRedBlue | newGreen;
        this.hwColorIndex[pen] = c;
        this._setHwPalette(pen, this._getMonitorPalette()[c]);
    },

    /**
     * Master video tick — called once per Gate Array clock cycle (1 µs / 4 MHz).
     *
     * Each tick:
     *   1. Determines whether the current pixel position is inside the visible
     *      line buffer. Outside: calls skipRender() and advances.
     *   2. Inside: renders blank (HSync/VBlank), border, or active video.
     *      Active video: reads two consecutive bytes from video RAM at
     *      `videoAddress`, passes them through the current pixel LUT, and
     *      calls `renderPixelFunc` with the resulting 16-bit word.
     *   3. Advances pixelIndex and spriteX by 16.
     *   4. Recomputes `videoAddress` from the CRTC MA row and VLC counter:
     *      addr = (maRow & 0x3000) << 2 | (vlc & 7) << 11 | (maRow & 0x3FF) << 1
     */
    tick() {
        const px = this._getPixelIndex();
        const lo = this._getLineBufferOffset();
        const hi = this._getLineBufferLimit();

        if (px >= lo && px < hi) {
            if (this._getVblankCounter() > 0 || this._getHsyncActive()) {
                this._renderBlank();
            } else if (this.border) {
                this._renderBorder();
            } else {
                const word = (this.currentLut[this.ramArray[this.videoAddress + 1]] << 8)
                           |  this.currentLut[this.ramArray[this.videoAddress]];
                this._renderPixelFunc(word);
            }
        } else {
            this._skipRender();
        }

        this._advancePixel();
        this.border       = this._getBorder();
        this.videoAddress = (this._getMaRow() & 0x3000) << 2
                          | (this._getVlc()   & 7)      << 11
                          | (this._getMaRow() & 0x3FF)  << 1;
    },

    /**
     * Applies the video mode corresponding to the current `romConfig` bits.
     * Switches both the pixel LUT and the render function in Video_Hardware.
     * Mode 3 reuses the Mode 0 render function with the Mode 3 LUT.
     */
    applyPaletteMode() {
        switch (this.romConfig) {
            case 0: this.currentLut = this.lutMode0; this._setRenderMode(0); break;
            case 1: this.currentLut = this.lutMode1; this._setRenderMode(1); break;
            case 2: this.currentLut = this.lutMode2; this._setRenderMode(2); break;
            case 3: this.currentLut = this.lutMode3; this._setRenderMode(0); break;
        }
    }
};
