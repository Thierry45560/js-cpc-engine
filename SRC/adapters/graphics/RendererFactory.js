/**
 * @file RendererFactory.js
 * @module RendererFactory
 *
 * Automatic renderer selection for the JS CPC emulator.
 * Registered as a global on `window.RendererFactory`.
 * Compatible with a plain `<script src="…">` include — no module bundler required.
 *
 * Selection policy:
 *   1. Try WebGPU if `navigator.gpu` is present and `options.forceCanvas` is false.
 *   2. Fall back to Canvas 2D on WebGPU init failure or absence.
 *
 * Prerequisite:
 *   `Video_Hardware.init(canvas)` must be called BEFORE `RendererFactory.create()`.
 *   This ordering is guaranteed by `Emulator_Setup.initRenderer()`.
 */

"use strict";

(function (global) {

const RendererFactory = {

    /**
     * Creates and initialises the best available renderer for the given canvas.
     *
     * `Video_Hardware.init()` must have been called before this method.
     * On success the returned renderer is ready to receive framebuffer writes
     * and `display()` calls.
     *
     * @param {HTMLCanvasElement} canvas              - Target canvas element.
     * @param {number}            [width=783]         - Framebuffer width in pixels.
     * @param {number}            [height=272]        - Framebuffer height in pixels.
     * @param {Object}            [options]           - Optional flags.
     * @param {boolean}           [options.forceCanvas=false] - Skip WebGPU and use Canvas 2D directly (useful for debugging).
     * @returns {Promise<WebGPURenderer|Canvas2DRenderer>} Initialised renderer instance.
     * @throws {Error} If Canvas 2D initialisation also fails (browser incompatible).
     */
    create: async function (canvas, width, height, options) {
        width   = width   || 783;
        height  = height  || 272;
        options = options || {};

        const vh = (typeof Video_Hardware !== "undefined") ? Video_Hardware : null;

        if (!options.forceCanvas && navigator.gpu) {
            try {
                const gpu = new WebGPURenderer();
                const ok  = await gpu.init(canvas, width, height, false /* Mode B */);
                if (ok) {
                    console.info("[RendererFactory] WebGPU active.");
                    return gpu;
                }
                console.warn("[RendererFactory] WebGPU init failed — falling back to Canvas 2D.");
            } catch (e) {
                console.warn("[RendererFactory] WebGPU exception: " + e.message + " — falling back to Canvas 2D.");
            }
        }

        const c2d   = new Canvas2DRenderer(vh);
        const c2dOk = c2d.init(canvas, width, height);
        if (!c2dOk) throw new Error("[RendererFactory] Canvas 2D init failed — browser incompatible.");
        console.info("[RendererFactory] Canvas 2D active.");
        return c2d;
    },

    /**
     * Probes WebGPU availability without allocating a device or any GPU resources.
     *
     * @returns {Promise<boolean>} `true` if a WebGPU adapter can be obtained, `false` otherwise.
     */
    isWebGPUAvailable: async function () {
        if (!navigator.gpu) return false;
        try {
            const adapter = await navigator.gpu.requestAdapter();
            return adapter !== null;
        } catch (e) {
            return false;
        }
    },
};

global.RendererFactory = RendererFactory;

}(window));
