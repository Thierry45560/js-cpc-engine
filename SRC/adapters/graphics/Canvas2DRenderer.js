/**
 * @file Canvas2DRenderer.js
 * @module Canvas2DRenderer
 *
 * Canvas 2D fallback renderer for the JS CPC emulator.
 * Registered as a global on `window.Canvas2DRenderer`.
 * Compatible with a plain `<script src="…">` include — no module bundler required.
 *
 * Buffer-sharing strategy (default — Mode B):
 *   Does NOT create a second 2D context on the canvas.
 *   Reuses `Video_Hardware.canvasCtx` and `Video_Hardware.imageData` already
 *   initialised by `Video_Hardware.init()`.
 *   `getFramebuffer()` returns `Video_Hardware.pixelBuffer32` directly, so the
 *   emulator core writes into it with zero extra allocation and `display()` is
 *   a single `putImageData` call — identical to the original `Video_Hardware.display()`.
 *
 * Guarantees:
 *   - No context conflict (a single `getContext("2d")` call per canvas).
 *   - No additional memory allocation (same buffer object).
 *   - Behaviour identical to the original `Video_Hardware.display()`.
 */

"use strict";

(function (global) {

/**
 * Creates a Canvas2DRenderer instance.
 *
 * @constructor
 * @param {Object} [videoHardware] - Optional reference to the `Video_Hardware` singleton.
 *   When provided, `init()` reuses its existing buffers instead of creating new ones.
 *   Passed automatically by `RendererFactory.create()` when `Video_Hardware` is available.
 */
function Canvas2DRenderer(videoHardware) {
    this.backend       = "canvas2d";
    this._vh           = videoHardware || null;  /** @type {Object|null} Video_Hardware reference, or null in standalone mode. */
    this._ctx          = null;                   /** @type {CanvasRenderingContext2D|null} Active 2D rendering context. */
    this._imageData    = null;                   /** @type {ImageData|null} ImageData object backed by the pixel buffer. */
    this._pixelBuf32   = null;                   /** @type {Uint32Array|null} 32-bit RGBA pixel buffer written by the core. */
    this._opaqueAlpha  = 0;                      /** @type {number} Endian-correct opaque alpha mask (0xFF000000 LE / 0x000000FF BE). */
    this._offsetX      = -15;                    /** @type {number} Horizontal pixel offset compensating the CPC left border. */
    this._ready        = false;                  /** @type {boolean} True once the renderer has been successfully initialised. */
}

Object.defineProperty(Canvas2DRenderer.prototype, "isReady", {
    /**
     * Whether the renderer has been successfully initialised.
     * @type {boolean}
     */
    get: function () { return this._ready; }
});

/**
 * Initialises the renderer against the given canvas.
 *
 * If `Video_Hardware` has already been initialised (its `canvasCtx` is non-null),
 * this method reuses its context and buffers (Mode B — zero allocation).
 * Otherwise it creates a new 2D context and allocates a fresh `ImageData`
 * (standalone / headless mode).
 *
 * @param {HTMLCanvasElement} canvas - Target canvas element.
 * @param {number}            width  - Framebuffer width in pixels (default 783).
 * @param {number}            height - Framebuffer height in pixels (default 272).
 * @returns {boolean} `true` on success, `false` if the canvas or context is unavailable.
 */
Canvas2DRenderer.prototype.init = function (canvas, width, height) {
    const vh = this._vh;

    // Case 1: Video_Hardware already initialised — reuse its buffers (no-alloc path).
    if (vh && vh.canvasCtx && vh.imageData && vh.pixelBuffer32) {
        this._ctx        = vh.canvasCtx;
        this._imageData  = vh.imageData;
        this._pixelBuf32 = vh.pixelBuffer32;
        const isLE         = (vh.isLittleEndian !== undefined) ? vh.isLittleEndian
                         : (new Int8Array((new Int16Array([1])).buffer))[0] > 0;
        this._opaqueAlpha = isLE ? 0xFF000000 : 0x000000FF;
        this._ready = true;
        console.info("[Canvas2DRenderer] Ready (Video_Hardware buffers reused)");
        return true;
    }

    // Case 2: Standalone mode — create a new context and allocate buffers.
    if (!canvas || typeof canvas.getContext !== "function") {
        console.error("[Canvas2DRenderer] Invalid canvas.");
        return false;
    }
    this._ctx = canvas.getContext("2d");
    if (!this._ctx) {
        console.error("[Canvas2DRenderer] 2D context unavailable.");
        return false;
    }
    this._imageData   = this._ctx.createImageData(width || 783, height || 272);
    this._pixelBuf32  = new Uint32Array(this._imageData.data.buffer);
    var isLE2 = (new Int8Array((new Int16Array([1])).buffer))[0] > 0;
    this._opaqueAlpha = isLE2 ? 0xFF000000 : 0x000000FF;
    this._ready = true;
    console.info("[Canvas2DRenderer] Ready (standalone " + (width||783) + "×" + (height||272) + ")");
    return true;
};

/**
 * Returns the `Uint32Array` into which the emulator core writes pixel data.
 *
 * In buffer-sharing mode this is the same object as `Video_Hardware.pixelBuffer32`,
 * so the copy performed by `RendererBridge` is effectively a no-op.
 *
 * @returns {Uint32Array} The active 32-bit pixel buffer.
 */
Canvas2DRenderer.prototype.getFramebuffer = function () {
    return this._pixelBuf32;
};

/**
 * No-op palette update — the palette is already resolved to RGBA values by
 * `Video_Hardware` before pixels reach this renderer.
 *
 * @returns {void}
 */
Canvas2DRenderer.prototype.updatePalette = function () { /* no-op */ };

/**
 * Flushes the pixel buffer to the canvas via `putImageData`.
 * The pixels in `_pixelBuf32` are already fully resolved RGBA values.
 *
 * @returns {void}
 */
Canvas2DRenderer.prototype.display = function () {
    if (!this._ready) return;
    this._ctx.putImageData(this._imageData, this._offsetX, 0);
};

/**
 * Fills the pixel buffer with opaque black and repaints the canvas.
 * Used when the emulator is reset or the screen must be cleared.
 *
 * @returns {void}
 */
Canvas2DRenderer.prototype.reset = function () {
    if (!this._ready) return;
    this._pixelBuf32.fill(this._opaqueAlpha);
    this._ctx.putImageData(this._imageData, this._offsetX, 0);
};

/**
 * Releases all held references, allowing garbage collection.
 * The renderer cannot be used after this call without re-initialising.
 *
 * @returns {void}
 */
Canvas2DRenderer.prototype.destroy = function () {
    this._ctx      = null;
    this._imageData = null;
    this._ready    = false;
};

global.Canvas2DRenderer = Canvas2DRenderer;

}(window));
