"use strict";

/**
 * @module Display
 * @description Pixel-level canvas rendering and frame synchronisation for the CPC display.
 *
 * Contains two independent singletons:
 *   - {@link Video_Hardware}       — canvas initialisation, gamma-corrected palettes,
 *                                    per-mode pixel renderers, sprite overlay (CPC+)
 *   - {@link Display_Sync_Manager} — software PLL that locks the emulated CRT scan
 *                                    to the host display VSync
 *
 * Design principles:
 *   - `init(canvasElement)` receives the canvas element rather than querying the DOM.
 *   - `frameCounter` is an instance property, not a global.
 *   - No jQuery or direct DOM references inside the emulation modules.
 *   - Canvas resize logic lives in UI_DOM.js, not here.
 */

// =============================================================================
// Video_Hardware — HTML5 Canvas rendering
// =============================================================================

/**
 * @namespace Video_Hardware
 * @description Manages the HTML5 Canvas, gamma-corrected monitor palettes,
 * per-mode pixel renderers, and CPC+ hardware sprite overlay.
 */
const Video_Hardware = {

    /** @type {Function|null} Applies the next queued palette colour change. */
    _applyQueuedColor: null,

    /** @type {number} Active machine type. */
    machineType   : 2,
    /** @type {Array|null} Active monitor palette (paletteColor / paletteGreen / paletteGray). */
    monitorPalette: null,
    /** @type {number} Current horizontal character counter from CRTC (for sprite X alignment). */
    hccCounter    : 0,
    /** @type {Uint8Array|null} CPC+ hardware sprite pixel-replacement buffer (1024 bytes). */
    asicPriBuffer : null,

    /** @type {Function|null} */ _getLineBufferOffset: null,
    /** @type {Function|null} */ _setLineBufferOffset: null,
    /** @type {Function|null} */ _getCurrentLineY    : null,
    /** @type {Function|null} */ _getTopBorderLine   : null,
    /** @type {Function|null} */ _getAsicPriBuffer   : null,
    /** @type {Function|null} */ _getHccCounter      : null,

    /**
     * Injects external dependencies from CPC_Bus.js.
     * @param {Object} bus - Dependency container.
     */
    link(bus) {
        if ('machineType'    in bus) this.machineType    = bus.machineType;
        if (bus.monitorPalette)      this.monitorPalette = bus.monitorPalette;
        if (bus.applyQueuedColor)    this._applyQueuedColor = bus.applyQueuedColor;
        if (bus.getLineBufferOffset) this._getLineBufferOffset = bus.getLineBufferOffset;
        if (bus.setLineBufferOffset) this._setLineBufferOffset = bus.setLineBufferOffset;
        if (bus.getCurrentLineY)     this._getCurrentLineY     = bus.getCurrentLineY;
        if (bus.getTopBorderLine)    this._getTopBorderLine    = bus.getTopBorderLine;
        if (bus.getAsicPriBuffer)    this._getAsicPriBuffer    = bus.getAsicPriBuffer;
        if (bus.getHccCounter)       this._getHccCounter       = bus.getHccCounter;
    },

    /** Pixel width of the internal render buffer. @type {number} */
    width : 783,
    /** Pixel height of the internal render buffer. @type {number} */
    height: 272,

    /**
     * 12-bit colour → 32-bit RGBA table for colour monitor.
     * Each entry is a gamma-corrected RGBA Uint32 (endian-aware).
     * @type {number[]}
     */
    paletteColor: new Array(4096),
    /**
     * 12-bit luminance → 32-bit RGBA table for green-phosphor monitor.
     * Uses a perceptual luminance weighted sum (3R + 9G + B) with γ=1.9.
     * @type {number[]}
     */
    paletteGreen: new Array(4096),
    /**
     * 12-bit luminance → 32-bit RGBA table for grey-scale monitor.
     * Uses the same luminance formula as paletteGreen with γ=1.7.
     * @type {number[]}
     */
    paletteGray : new Array(4096),

    /**
     * Rendered colour values for pens 0–31, indexed by pen number.
     * Each entry is a 32-bit RGBA Uint32 ready to be written to pixelBuffer32.
     * @type {number[]}
     */
    hwPalette: new Array(32),

    /** @type {CanvasRenderingContext2D|null} */ canvasCtx    : null,
    /** @type {ImageData|null} */               imageData    : null,
    /** @type {Uint32Array|null} */             pixelBuffer32: null,
    /** @type {number|null} Opaque alpha mask — 0xFF000000 (LE) or 0x000000FF (BE). */
    opaqueAlpha  : null,
    /** @type {number|null} Current write position in pixelBuffer32. */
    pixelIndex   : null,
    /** Horizontal sprite position for CPC+ PRI overlay. @type {number} */
    spriteX      : 0,

    /**
     * Frame counter for FPS display.
     * Incremented by `display()`. Instance property, not a global.
     * @type {number}
     */
    frameCounter: 0,

    /**
     * Currently active pixel renderer function (renderMode0 / renderMode1 / renderMode2).
     * Switched by Palette_Colors.applyPaletteMode() when the video mode changes.
     * @type {Function|null}
     */
    renderPixelFunc: null,

    /**
     * Host CPU byte order, detected once in `init()`.
     * True on little-endian systems (x86, ARM LE) which make up >99% of targets.
     * Available for external code that needs to build Uint32 pixel values.
     * @type {boolean}
     */
    isLittleEndian: false,

    /**
     * Initialises the canvas, creates the ImageData and Uint32Array pixel buffer,
     * and pre-computes all three monitor palette look-up tables.
     *
     * Palette generation (gamma correction):
     *   - Colour mode: each of the R, G, B channels uses γ = 1/1.4 (power-law).
     *   - Green mode:  luminance = 3R + 9G + B; green channel uses γ = 1/1.9.
     *   - Greyscale:   same luminance formula; all three channels use γ = 1/1.7.
     *   The exponent 1/γ maps the linear 0–15 CPC colour range to perceptually
     *   uniform 8-bit output values via `Math.pow(v/maxIn, 1/γ) * 255`.
     *
     * @param {HTMLCanvasElement} canvasElement - The canvas to render into.
     * @returns {boolean} `true` on success, `false` if the browser lacks required APIs.
     */
    init(canvasElement) {
        const canvas = canvasElement;

        if (!canvas) {
            console.error("[Video_Hardware] Canvas element not found.");
            return false;
        }

        if (typeof canvas.getContext === "undefined") {
            console.error("[Video_Hardware] Canvas API not supported by this browser.");
            return false;
        }

        this.canvasCtx = canvas.getContext("2d");
        this.imageData = this.canvasCtx.createImageData(this.width, this.height);

        if (typeof Uint8ClampedArray !== "undefined" && this.imageData.data instanceof Uint8ClampedArray) {
            this.pixelBuffer32 = new Uint32Array(this.imageData.data.buffer);
        } else {
            return false;
        }

        const gammaR = new Array(16);
        for (let i = 0; i <= 15; i++) {
            gammaR[i] = Math.round(255 * Math.pow(i / 15, 1 / 1.4));
        }
        const gammaG = gammaR;
        const gammaB = gammaR;

        const gammaGreenLut = new Array(4096);
        const gammaGrayLut  = new Array(4096);
        for (let i = 0; i <= 4095; i++) {
            gammaGreenLut[i] = Math.round(255 * Math.pow(i / 4095, 1 / 1.9));
            gammaGrayLut[i]  = Math.round(255 * Math.pow(i / 4095, 1 / 1.7));
        }

        const isLE = (new Int8Array((new Int16Array([1])).buffer))[0] > 0;
        this.isLittleEndian = isLE;
        this.opaqueAlpha = isLE ? 0xFF000000 : 0x000000FF;

        for (let idx = 0; idx <= 4095; idx++) {
            const luma  = 3 * ((idx & 0xF00) >>> 8) + 9 * ((idx & 0xF0) >>> 4) + (idx & 0xF);
            const gv    = gammaGreenLut[Math.round(21 * luma)];
            const gyv   = gammaGrayLut [Math.round(21 * luma)];
            const rv    = gammaR[(idx & 0xF00) >>> 8];
            const green = gammaG[(idx & 0xF0)  >>> 4];
            const bv    = gammaB[ idx & 0xF];

            if (this.isLittleEndian) {
                this.paletteGreen[idx] = 0xFF000000 | (gv  << 8);
                this.paletteGray [idx] = 0xFF000000 | (gyv << 16) | (gyv << 8) | gyv;
                this.paletteColor[idx] = 0xFF000000 | (bv  << 16) | (green  << 8) | rv;
            } else {
                this.paletteGreen[idx] = (gv  << 16) | 0xFF;
                this.paletteGray [idx] = (gyv << 24) | (gyv << 16) | (gyv << 8) | 0xFF;
                this.paletteColor[idx] = (rv  << 24) | (green  << 16) | (bv  << 8) | 0xFF;
            }
        }
        return true;
    },

    /**
     * Resets the pixel buffer to opaque black and pushes it to the canvas.
     */
    reset() {
        this.canvasCtx.fillStyle = "rgba(128, 128, 128, 0.5)";
        for (let i = 0; i <= 31; i++) this.hwPalette[i] = 0;
        this.pixelBuffer32.fill(this.opaqueAlpha);
        this.spriteX = 0;
        this.display();
    },

    /**
     * Renders 16 pixels in CPC Mode 0 (4 bits/pixel, 16 colours).
     * Decodes the 16-bit `word` (two LUT-processed bytes from video RAM)
     * into four groups of four pixels each (2 pixels per nibble).
     * On CPC+, overlays hardware sprites from the PRI buffer.
     * @param {number} word - 16-bit pixel word from the Gate Array tick.
     */
    renderMode0(word) {
        const pal = this.hwPalette;
        const buf = this.pixelBuffer32;
        let   px  = this.pixelIndex;
        let   col;

        if (this.machineType >= 4) {
            const pri = this._getAsicPriBuffer();
            let sx = (this._getHccCounter() << 4);
            for (let i = 0; i < 16; i++) {
                if (i === 8) this._applyQueuedColor();
                if ((i & 3) === 0) { col = pal[word & 15]; word >>>= 4; }
                const spc = pri[sx];
                buf[px++] = spc !== 0 ? pal[16 + spc] : col;
                sx = (sx + 1) & 1023;
            }
        } else {
            for (let i = 0; i < 16; i++) {
                if (i === 8)  this._applyQueuedColor();
                if ((i & 3) === 0) { col = pal[word & 15]; word >>>= 4; }
                buf[px++] = col;
            }
        }
    },

    /**
     * Renders 16 pixels in CPC Mode 1 (2 bits/pixel, 4 colours).
     * Each pair of pixels shares a nibble; 8 pairs are decoded per call.
     * On CPC+, overlays hardware sprites from the PRI buffer.
     * @param {number} word - 16-bit pixel word.
     */
    renderMode1(word) {
        const pal = this.hwPalette;
        const buf = this.pixelBuffer32;
        let   px  = this.pixelIndex;
        let   col;

        if (this.machineType >= 4) {
            const pri = this._getAsicPriBuffer();
            let sx = (this._getHccCounter() << 4);
            for (let i = 0; i < 16; i++) {
                if (i === 8)  this._applyQueuedColor();
                if ((i & 1) === 0) { col = pal[word & 3]; word >>>= 2; }
                const spc = pri[sx];
                buf[px++] = spc !== 0 ? pal[16 + spc] : col;
                sx = (sx + 1) & 1023;
            }
        } else {
            for (let i = 0; i < 16; i++) {
                if (i === 8)  this._applyQueuedColor();
                if ((i & 1) === 0) { col = pal[word & 3]; word >>>= 2; }
                buf[px++] = col;
            }
        }
    },

    /**
     * Renders 16 pixels in CPC Mode 2 (1 bit/pixel, 2 colours).
     * Each bit of the 16-bit word maps to one pixel.
     * On CPC+, overlays hardware sprites from the PRI buffer.
     * @param {number} word - 16-bit pixel word.
     */
    renderMode2(word) {
        const pal = this.hwPalette;
        const buf = this.pixelBuffer32;
        let   px  = this.pixelIndex;

        if (this.machineType >= 4) {
            const pri = this._getAsicPriBuffer();
            let sx = (this._getHccCounter() << 4);
            for (let i = 0; i < 16; i++) {
                if (i === 8) this._applyQueuedColor();
                const spc = pri[sx];
                buf[px++] = spc !== 0 ? pal[16 + spc] : pal[word & 1];
                word >>>= 1;
                sx = (sx + 1) & 1023;
            }
        } else {
            for (let i = 0; i < 16; i++) {
                if (i === 8) this._applyQueuedColor();
                buf[px++] = pal[word & 1];
                word >>>= 1;
            }
        }
    },

    /**
     * Renders 16 border pixels using the border pen (index 16).
     * Applies any queued colour change mid-scanline at pixel 8.
     */
    renderBorder() {
        const pal = this.hwPalette;
        const buf = this.pixelBuffer32;
        let   px  = this.pixelIndex;
        for (let i = 0; i < 16; i++) {
            if (i === 8) this._applyQueuedColor();
            buf[px++] = pal[16];
        }
    },

    /**
     * Renders 16 blank (HSync/VBlank) pixels using the opaque background colour.
     * Applies any queued colour change once.
     */
    renderBlank() {
        const buf   = this.pixelBuffer32;
        const blank = this.opaqueAlpha;
        let   px    = this.pixelIndex;
        this._applyQueuedColor();
        for (let i = 0; i < 16; i++) buf[px++] = blank;
    },

    /**
     * Called when the current pixel position is outside the visible line buffer.
     * Applies any queued colour change but writes no pixels.
     */
    skipRender() {
        this._applyQueuedColor();
    },

    /**
     * Clears the pixel index and line buffer offset, then updates the canvas.
     */
    clear() {
        this.pixelIndex = 0;
        this._setLineBufferOffset(0);
        this.display();
    },

    /**
     * Fills the remainder of the pixel buffer with the opaque background colour,
     * increments the frame counter, and uploads the ImageData to the canvas.
     * This is the normal end-of-frame render path (Canvas 2D).
     * WebGPU and turbo mode replace this function in-place via CPC_Bus.js wiring.
     */
    display() {
        const start = Math.max(this.pixelIndex, this._getLineBufferOffset());
        this.pixelBuffer32.fill(this.opaqueAlpha, start < 0 ? 0 : start);
        this.frameCounter++;
        this.canvasCtx.putImageData(this.imageData, -15, 0);
    },

    /**
     * Debug overlay: draws crosshairs at the current beam position.
     * Requires a `fillStyle` to have been set on `canvasCtx` before calling.
     */
    oG() {
        const beamX = this.pixelIndex - this._getLineBufferOffset() - 15;
        const beamY = this._getCurrentLineY() - this._getTopBorderLine() + 1;
        this.canvasCtx.fillRect(beamX, 0, 1, 272);
        this.canvasCtx.fillRect(0, beamY, 768, 1);
    }
};


// =============================================================================
// Display_Sync_Manager — software PLL for frame synchronisation
// =============================================================================

/**
 * @namespace Display_Sync_Manager
 * @description Software Phase-Locked Loop (PLL) that synchronises the emulated
 * CRT raster scan with the host display refresh rate.
 *
 * Algorithm overview:
 *   The emulator generates video at approximately 50 Hz (16 384 T-states/frame).
 *   The host display may refresh at 60 Hz, 75 Hz, etc.
 *   Each HSync the CRTC sends a `syncPhase()` signal that captures the current
 *   `frameAccumulator` as `phaseAccumulator`.
 *   At each VSync (`adjustPLL()`) the error between the emulated frame boundary
 *   and the host VSync is measured and `adjCyclesPerFrame` is nudged
 *   (±1–128 T-states) to reduce drift.
 *   A `driftCompensation` integrator detects sustained drift and adjusts
 *   `baseCyclesPerFrame` in 256-cycle increments when the error exceeds ±512.
 */
const Display_Sync_Manager = {

    /** @type {Function|null} */ _display     : null,
    /** @type {Function|null} */ _setPixelIndex: null,

    /** Canvas pixel width (passed from Video_Hardware). @type {number} */
    displayWidth : 768,
    /** Canvas pixel height. @type {number} */
    displayHeight: 272,

    /**
     * Injects dependencies from CPC_Bus.js.
     * @param {Object} bus
     */
    link(bus) {
        if ('displayWidth'  in bus) this.displayWidth  = bus.displayWidth;
        if ('displayHeight' in bus) this.displayHeight = bus.displayHeight;
        if (bus.display)             this._display      = bus.display;
        if (bus.setPixelIndex)       this._setPixelIndex = bus.setPixelIndex;
    },

    /**
     * Minimum scan line count before VSync is considered valid.
     * Prevents false triggers from very short frames.
     * @type {number}
     */
    VSYNC_MIN_LINES   : 291,
    /**
     * Maximum scan lines before the frame is force-rendered.
     * Safety net for frames where VSync never fires.
     * @type {number}
     */
    MAX_LINES_PER_FRAME: 350,

    /** Remaining blank lines for the VBlank period (counts down from 26). @type {number|null} */
    vblankCounter    : null,
    /** Nominal T-states per frame (16 384 = 4 MHz / 244 lines / ~50 Hz). @type {number|null} */
    baseCyclesPerFrame: null,
    /** PLL-adjusted T-states per frame. @type {number|null} */
    adjCyclesPerFrame : null,
    /** Accumulates T-states within the current frame for frame boundary detection. @type {number|null} */
    frameAccumulator : null,
    /** Captures frameAccumulator at each HSync for phase error measurement. @type {number|null} */
    phaseAccumulator : null,
    /** True once per frame after adjustPLL() has been called. @type {boolean|null} */
    isPhaseSynced    : null,
    /** Current raster scan line (0-based). @type {number|null} */
    currentLineY     : null,
    /** Pixel offset of the first visible line in pixelBuffer32. @type {number|null} */
    lineBufferOffset : null,
    /** Pixel offset past the last visible line (exclusive). @type {number|null} */
    lineBufferLimit  : null,
    /** First visible scan line (computed each frame). @type {number|null} */
    topBorderLine    : null,
    /** Last visible scan line + 1. @type {number|null} */
    bottomBorderLine : null,
    /** Integrator for long-term drift between emulator and host refresh rate. @type {number|null} */
    driftCompensation: null,

    /**
     * Resets all PLL state to initial values.
     */
    reset() {
        this.vblankCounter      = 0;
        this.baseCyclesPerFrame = 16384;
        this.adjCyclesPerFrame  = 16384;
        this.frameAccumulator   = 0;
        this.phaseAccumulator   = 0;
        this.isPhaseSynced      = false;
        this.currentLineY       = 0;
        this.lineBufferOffset   = 0;
        this.lineBufferLimit    = 0;
        this.driftCompensation  = 0;
        this.topBorderLine      = 24;
        this.bottomBorderLine   = this.topBorderLine + this.displayHeight;
    },

    /**
     * Starts the VBlank period by setting the VBlank counter to 26 lines.
     * Called by Palette_Colors when the CRTC VSync becomes active.
     */
    triggerVBlank() {
        if (this.vblankCounter === 0) {
            this.vblankCounter = 26;
        }
    },

    /**
     * Captures the current frame accumulator value as the phase reference.
     * Called at each HSync start; the captured value represents the phase
     * offset between the emulated beam position and the previous frame boundary.
     */
    syncPhase() {
        this.phaseAccumulator = this.frameAccumulator;
    },

    /**
     * Adjusts `adjCyclesPerFrame` to reduce phase error between the emulated
     * frame boundary and the host VSync.
     *
     * PLL correction algorithm:
     *   - `phase = 0`         → no error; nudge driftCompensation back toward 0.
     *   - `phase > base/2`    → emulator is slow; decrease adjCyclesPerFrame
     *                           by min(1 + (adj−phase)/4, 128).
     *   - `phase <= base/2`   → emulator is fast; increase adjCyclesPerFrame
     *                           by min(1 + phase/4, 128).
     *   Called at most once per frame (`isPhaseSynced` guard).
     */
    adjustPLL() {
        if (this.isPhaseSynced) return;

        const base  = this.baseCyclesPerFrame;
        const phase = this.phaseAccumulator;

        if (phase === 0) {
            this.adjCyclesPerFrame = base;
            if      (this.driftCompensation > 0) this.driftCompensation--;
            else if (this.driftCompensation < 0) this.driftCompensation++;
        } else if (phase > (base >>> 1)) {
            const adj = Math.min(1 + ((this.adjCyclesPerFrame - phase) >>> 2), 128);
            this.adjCyclesPerFrame = base - adj;
            this.driftCompensation++;
        } else {
            const adj = Math.min(1 + (phase >>> 2), 128);
            this.adjCyclesPerFrame = base + adj;
            this.driftCompensation--;
        }
        this.isPhaseSynced = true;
    },

    /**
     * Called at each line boundary to update vertical display geometry and
     * trigger the frame renderer when appropriate.
     *
     * Frame is displayed when:
     *   a) currentLineY ≥ MAX_LINES_PER_FRAME (safety watchdog), or
     *   b) currentLineY ≥ VSYNC_MIN_LINES and VBlank has just started.
     *
     * After rendering:
     *   - Long-term drift correction adjusts baseCyclesPerFrame ±256 when
     *     driftCompensation exceeds ±512.
     *   - topBorderLine is recomputed from the actual frame height to keep
     *     the visible area centred vertically.
     *
     * Each line: lineBufferOffset and lineBufferLimit define the pixel slice
     * in pixelBuffer32 for the current scan line.
     * Fine horizontal scroll is applied via a 4-bit sub-pixel offset derived
     * from frameAccumulator bits [7:4].
     */
    updateLineOffsets() {
        const forceRender = this.currentLineY >= this.MAX_LINES_PER_FRAME;
        const vsyncReady  = (this.currentLineY >= this.VSYNC_MIN_LINES) && (this.vblankCounter === 26);

        if (forceRender || vsyncReady) {
            this._display();

            if (this.driftCompensation > 512) {
                if (this.baseCyclesPerFrame > 16128) this.baseCyclesPerFrame -= 256;
                this.driftCompensation = 0;
            } else if (this.driftCompensation < -512) {
                if (this.baseCyclesPerFrame < 16640) this.baseCyclesPerFrame += 256;
                this.driftCompensation = 0;
            }

            this.topBorderLine    = (this.currentLineY + 24 - this.displayHeight) >>> 1;
            this.bottomBorderLine = this.topBorderLine + this.displayHeight;
            this.currentLineY     = 0;
        } else {
            this.currentLineY++;
        }

        this.lineBufferOffset = (this.currentLineY - this.topBorderLine) * this.displayWidth;
        this.lineBufferLimit  = (this.currentLineY < this.topBorderLine || this.currentLineY >= this.bottomBorderLine)
                                ? this.lineBufferOffset
                                : this.lineBufferOffset + this.displayWidth;

        const fineXScroll = (this.frameAccumulator >>> 4) & 15;
        this._setPixelIndex(this.lineBufferOffset - 1 - 176 + fineXScroll);

        if (this.vblankCounter > 0) this.vblankCounter--;
        this.isPhaseSynced = false;
    },

    /**
     * Advances the PLL accumulators by one Gate Array clock step (256 sub-units per T-state).
     * When `frameAccumulator` wraps around `adjCyclesPerFrame`, a new line begins.
     */
    tick() {
        this.phaseAccumulator += 128;
        if (this.phaseAccumulator >= this.adjCyclesPerFrame) {
            this.phaseAccumulator -= this.adjCyclesPerFrame;
        }
        this.frameAccumulator += 256;
        if (this.frameAccumulator >= this.adjCyclesPerFrame) {
            this.frameAccumulator -= this.adjCyclesPerFrame;
            this.updateLineOffsets();
        }
    }
};
