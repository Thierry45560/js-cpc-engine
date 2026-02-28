/**
 * @file RendererBridge.js
 * @module RendererBridge
 *
 * Adapter between `Video_Hardware` and any `IRenderer` implementation.
 * Registered as a global on `window.RendererBridge`.
 * Compatible with a plain `<script src="…">` include — no module bundler required.
 *
 * Role:
 *   Monkey-patches `Video_Hardware.display()` and `Video_Hardware.reset()` to
 *   route rendering to the active backend (WebGPU or Canvas 2D) without touching
 *   any emulator core module.
 *
 * Framebuffer modes:
 *
 *   Mode B — RGBA direct (default, no core changes required):
 *     `Video_Hardware.pixelBuffer32` contains packed Uint32 RGBA values.
 *     The bridge copies this buffer into `renderer.getFramebuffer()` each frame.
 *     Fully compatible with the existing `renderMode0/1/2` pipeline.
 *
 *   Mode A — Palette index (GPU-optimised):
 *     `pixelBuffer32` stores pen indices 0–31 instead of resolved colours.
 *     Palette resolution happens entirely in the compute shader.
 *     Requires patching `renderMode0/1/2` to write the pen index rather than
 *     the resolved palette colour.
 *     Enable with: `bridge.attach({ paletteIndexMode: true })`.
 */

"use strict";

(function (global) {

/**
 * Creates a RendererBridge instance linking a renderer to Video_Hardware.
 *
 * @constructor
 * @param {WebGPURenderer|Canvas2DRenderer} renderer    - Active renderer backend.
 * @param {Object}                          videoHardware - Reference to the `Video_Hardware` singleton.
 */
function RendererBridge(renderer, videoHardware) {
    this._renderer     = renderer;
    this._vh           = videoHardware;
    this._origDisplay  = null;  /** @type {Function|null} Saved original Video_Hardware.display(). */
    this._origReset    = null;  /** @type {Function|null} Saved original Video_Hardware.reset(). */
    this._attached     = false; /** @type {boolean} Whether the bridge is currently patched in. */
    this._palIndexMode = false; /** @type {boolean} Whether palette-index mode is active. */
}

Object.defineProperty(RendererBridge.prototype, "isAttached", {
    /**
     * Whether the bridge is currently patched into Video_Hardware.
     * @type {boolean}
     */
    get: function () { return this._attached; }
});

Object.defineProperty(RendererBridge.prototype, "backend", {
    /**
     * The backend identifier string of the active renderer (e.g. `"webgpu"` or `"canvas2d"`).
     * @type {string}
     */
    get: function () { return this._renderer.backend; }
});

/**
 * Patches `Video_Hardware.display()` and `Video_Hardware.reset()` to forward
 * rendering to the active renderer backend.
 *
 * The patched `display()` copies `Video_Hardware.pixelBuffer32` into the
 * renderer framebuffer then calls `renderer.display()`.
 * In Mode B (default) the semantics are identical for both index-palette and
 * RGBA-direct modes — the distinction only affects the values stored in the buffer.
 *
 * Calling `attach()` a second time before `detach()` is a no-op.
 *
 * @param {Object}  [options]                    - Optional configuration.
 * @param {boolean} [options.paletteIndexMode=false] - Enable palette-index mode (Mode A).
 * @returns {void}
 */
RendererBridge.prototype.attach = function (options) {
    if (this._attached) return;
    options = options || {};
    this._palIndexMode = options.paletteIndexMode || false;

    const renderer = this._renderer;
    const vh       = this._vh;
    const bridge   = this;

    this._origDisplay = vh.display;

    vh.display = function () {
        const src = vh.pixelBuffer32;
        const dst = renderer.getFramebuffer();
        dst.set(src);
        renderer.display();
        vh.frameCounter++;
    };

    this._origReset = vh.reset;
    vh.reset = function () {
        for (let i = 0; i <= 31; i++) vh.hwPalette[i] = 0;
        renderer.reset();
        vh.frameCounter = 0;
    };

    this._attached = true;
    console.info("[RendererBridge] Attached — backend: " + renderer.backend +
                 ", mode: " + (this._palIndexMode ? "index-palette" : "rgba-direct"));
};

/**
 * Restores the original `Video_Hardware.display()` and `reset()` methods,
 * detaching the bridge from the rendering pipeline.
 *
 * @returns {void}
 */
RendererBridge.prototype.detach = function () {
    if (!this._attached) return;
    if (this._origDisplay) this._vh.display = this._origDisplay;
    if (this._origReset)   this._vh.reset   = this._origReset;
    this._attached = false;
    console.info("[RendererBridge] Detached — Video_Hardware restored.");
};

/**
 * Pushes the current hardware palette from `Video_Hardware.hwPalette` to the
 * renderer's `updatePalette()` method.
 *
 * @param {boolean} [isLE] - Whether the host is little-endian.
 *   Defaults to `Video_Hardware.isLittleEndian` when available, otherwise auto-detected.
 * @returns {void}
 */
RendererBridge.prototype.syncPalette = function (isLE) {
    const le = (isLE !== undefined) ? isLE : (this._vh.isLittleEndian !== false);
    this._renderer.updatePalette(this._vh.hwPalette, le);
};

/**
 * Returns a version of the patched `display()` function that automatically
 * synchronises the hardware palette before each frame.
 *
 * Useful for renderers that need an up-to-date palette without modifying
 * `CPC_Bus.js`.
 *
 * Usage (after `attach()`):
 * ```js
 * Video_Hardware.display = bridge.makeAutoSyncDisplay();
 * ```
 *
 * @returns {Function} A bound `display()` function with auto-palette sync.
 */
RendererBridge.prototype.makeAutoSyncDisplay = function () {
    const bridge  = this;
    const wrapped = this._vh.display.bind(this._vh);
    return function autoSyncDisplay() {
        bridge.syncPalette();
        wrapped();
    };
};

global.RendererBridge = RendererBridge;

}(window));
