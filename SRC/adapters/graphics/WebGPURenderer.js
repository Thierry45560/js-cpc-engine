/**
 * @file WebGPURenderer.js
 * @module WebGPURenderer
 *
 * WebGPU-accelerated renderer for the JS CPC emulator.
 * Registered as a global on `window.WebGPURenderer`.
 *
 * The WGSL fragment shader implements five selectable filter modes via a
 * `filterType` uniform (integer encoded as float):
 *
 *   0 — RAW
 *         Point-sampling: textureSampleLevel at the exact UV coordinate.
 *
 *   1 — SHARP BILINEAR
 *         Sub-pixel sharpening via fwidth-based gradient clamping.
 *         Algorithm: for each fragment, the fractional texel coordinate is
 *         clamped by the screen-space derivative (fwidth) so that the
 *         bilinear kernel snaps toward the nearest texel centre, producing
 *         sharp pixel edges while still anti-aliasing diagonal boundaries.
 *
 *   2–3 — CRT SCANLINE
 *         Applies a sine-wave luminance modulation along the Y axis to
 *         simulate the dark gap between CRT scanlines:
 *           attenuation = mix(1.0, 0.75, |sin(uv.y × height × π)|)
 *
 *   5 — BALANCED AI-SMOOTH (fMode ≥ 4.5)
 *         Edge-directed diagonal reconstruction inspired by EPX/hqx-family
 *         algorithms. For each fragment:
 *           1. Sample a 3×3 neighbourhood (centre + 4 cardinals + 4 diagonals).
 *           2. Compute luma for each sample using the ITU-R BT.709 coefficients
 *              (0.2126 R + 0.7152 G + 0.0722 B).
 *           3. Measure axis-aligned contrast: edge_v = |luma(top) − luma(bottom)|,
 *              edge_h = |luma(left) − luma(right)|.
 *           4. Compare diagonal contrast: w1 = |luma(a) − luma(i)| (top-left→bottom-right),
 *              w2 = |luma(c) − luma(g)| (top-right→bottom-left).
 *           5. Derive a diagonal confidence score:
 *              clamp(|w1 − w2| / (0.01 + edge_v + edge_h), 0, 1)
 *              A high score means one diagonal is clearly dominant.
 *           6. Blend the centre pixel toward the dominant diagonal average
 *              using 50 % of the confidence factor.
 *           7. Final mix: 70 % reconstructed + 30 % original to preserve sharpness.
 *           8. Unsharp-mask step: subtract 10 % of the 4-cardinal average
 *              to accentuate edges.
 */

"use strict";

(function (global) {

const WGSL_RENDER = `
    struct Uniforms {
        filterType : f32,
        time       : f32,
        resolution : vec2f,
    }

    @group(0) @binding(0) var tex  : texture_2d<f32>;
    @group(0) @binding(1) var samp : sampler;
    @group(0) @binding(2) var<uniform> ui : Uniforms;

    struct V { @builtin(position) p : vec4f, @location(0) uv : vec2f }

    fn get_luma(c: vec3f) -> f32 {
        return dot(c, vec3f(0.2126, 0.7152, 0.0722));
    }

    @vertex fn vs(@builtin(vertex_index) i : u32) -> V {
        var P = array<vec2f,6>(vec2f(-1.,-1.),vec2f(1.,-1.),vec2f(-1.,1.),vec2f(-1.,1.),vec2f(1.,-1.),vec2f(1.,1.));
        var U = array<vec2f,6>(vec2f(0.,1.),vec2f(1.,1.),vec2f(0.,0.),vec2f(0.,0.),vec2f(1.,1.),vec2f(1.,0.));
        var o : V; o.p = vec4f(P[i],0.,1.); o.uv = U[i]; return o;
    }

    @fragment fn fs(in : V) -> @location(0) vec4f {
        let uv = in.uv;
        let res = ui.resolution;
        let fMode = ui.filterType;
        let dx = 1.0 / res.x;
        let dy = 1.0 / res.y;

        // --- MODE 0: RAW ---
        if (fMode < 0.5) {
            return textureSampleLevel(tex, samp, uv, 0.0);
        }

        // --- MODE 1: SHARP BILINEAR ---
        if (fMode < 1.5) {
            let texel = uv * res;
            let fp = fract(texel);
            let fw = fwidth(texel);
            let sharp = clamp(fp / fw, vec2f(0.0), vec2f(1.0)) - 0.5;
            return textureSampleLevel(tex, samp, (floor(texel) + 0.5 + sharp) / res, 0.0);
        }

        // --- MODES 2 & 3: CRT SCANLINE ---
        if (fMode < 3.5) {
            let color = textureSampleLevel(tex, samp, uv, 0.0).rgb;
            let s = sin(uv.y * res.y * 3.1415);
            return vec4f(color * mix(1.0, 0.75, abs(s)), 1.0);
        }

        // --- MODE 5: BALANCED AI-SMOOTH ---
        if (fMode >= 4.5) {
            // 3×3 neighbourhood samples (cardinal + diagonal)
            let e = textureSampleLevel(tex, samp, uv, 0.0).rgb;
            let b = textureSampleLevel(tex, samp, uv + vec2f( 0, -dy), 0.0).rgb;
            let d = textureSampleLevel(tex, samp, uv + vec2f(-dx,  0), 0.0).rgb;
            let f = textureSampleLevel(tex, samp, uv + vec2f( dx,  0), 0.0).rgb;
            let h = textureSampleLevel(tex, samp, uv + vec2f( 0,  dy), 0.0).rgb;

            let a = textureSampleLevel(tex, samp, uv + vec2f(-dx, -dy), 0.0).rgb;
            let c = textureSampleLevel(tex, samp, uv + vec2f( dx, -dy), 0.0).rgb;
            let g = textureSampleLevel(tex, samp, uv + vec2f(-dx,  dy), 0.0).rgb;
            let i = textureSampleLevel(tex, samp, uv + vec2f( dx,  dy), 0.0).rgb;

            let le = get_luma(e); let lb = get_luma(b); let ld = get_luma(d);
            let lf = get_luma(f); let lh = get_luma(h);
            let la = get_luma(a); let lc = get_luma(c); let lg = get_luma(g); let li = get_luma(i);

            // Axis-aligned edge contrast
            let edge_v = abs(lb - lh);
            let edge_h = abs(ld - lf);

            // Diagonal dominance weights
            let w1 = abs(la - li); // top-left → bottom-right
            let w2 = abs(lc - lg); // top-right → bottom-left

            var res_col = e;

            // Confidence: how strongly one diagonal dominates over the other
            let diag_confidence = clamp(abs(w1 - w2) / (0.01 + edge_v + edge_h), 0.0, 1.0);

            if (w1 < w2) {
                // Dominant diagonal: top-left → bottom-right
                let blend = mix(e, mix(a, i, 0.5), 0.5 * diag_confidence);
                res_col = blend;
            } else {
                // Dominant diagonal: top-right → bottom-left
                let blend = mix(e, mix(c, g, 0.5), 0.5 * diag_confidence);
                res_col = blend;
            }

            // 70 % reconstructed + 30 % original to preserve fine detail
            let final_mix = mix(e, res_col, 0.7);

            // Unsharp-mask: subtract 10 % of the 4-cardinal average to boost edges
            let sharp_col = mix(final_mix, (b+d+f+h)*0.25, -0.1);

            return vec4f(sharp_col, 1.0);
        }

        return textureSampleLevel(tex, samp, uv, 0.0);
    }
`;

/**
 * Creates a WebGPURenderer instance.
 * Call `init()` before any other method.
 *
 * @constructor
 */
function WebGPURenderer() {
    this.backend       = "webgpu";
    this._device       = null;  /** @type {GPUDevice|null} Active WebGPU logical device. */
    this._context      = null;  /** @type {GPUCanvasContext|null} WebGPU canvas context. */
    this._texture      = null;  /** @type {GPUTexture|null} Source texture holding the CPC framebuffer. */
    this._pipeline     = null;  /** @type {GPURenderPipeline|null} Compiled render pipeline. */
    this._bindGroup    = null;  /** @type {GPUBindGroup|null} Bind group tying texture, sampler, and uniforms. */
    this._uniformBuffer = null; /** @type {GPUBuffer|null} Uniform buffer containing filter type, time, and resolution. */
    this._filterType   = 0;    /** @type {number} Active filter mode (0–5). */
    this._ready        = false; /** @type {boolean} True once the pipeline has been successfully built. */
    this._uniformData  = new Float32Array(4); /** @type {Float32Array} Pre-allocated uniform upload buffer (avoids per-frame allocation). */
}

/**
 * Initialises the WebGPU device, swap-chain, texture, and render pipeline.
 *
 * @param {HTMLCanvasElement} visibleCanvas  - On-screen canvas to present to.
 * @param {HTMLCanvasElement} offscreenCanvas - Unused in Mode B; reserved for future Mode A support.
 * @param {number}            [width=783]    - Source framebuffer width in pixels.
 * @param {number}            [height=272]   - Source framebuffer height in pixels.
 * @returns {Promise<boolean>} `true` on success, `false` if WebGPU is unavailable.
 */
WebGPURenderer.prototype.init = async function (visibleCanvas, offscreenCanvas, width, height) {
    this._width  = width  || 783;
    this._height = height || 272;
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    this._device = await adapter.requestDevice();
    this._context = visibleCanvas.getContext("webgpu");
    const fmt = navigator.gpu.getPreferredCanvasFormat();
    this._context.configure({ device: this._device, format: fmt, alphaMode: "opaque" });
    this._texture = this._device.createTexture({
        size: [this._width, this._height],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    this._uniformBuffer = this._device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    const mod = this._device.createShaderModule({ code: WGSL_RENDER });
    this._pipeline = await this._device.createRenderPipelineAsync({
        layout: 'auto',
        vertex:   { module: mod, entryPoint: "vs" },
        fragment: { module: mod, entryPoint: "fs", targets: [{ format: fmt }] }
    });
    this._sampler = this._device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this._bindGroup = this._device.createBindGroup({
        layout: this._pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: this._texture.createView() },
            { binding: 1, resource: this._sampler },
            { binding: 2, resource: { buffer: this._uniformBuffer } }
        ]
    });
    this._ready = true;
    this.updateUniforms();
    return true;
};

/**
 * Writes the current filter type, elapsed time (seconds), and framebuffer
 * dimensions into the GPU uniform buffer.
 *
 * Should be called whenever `_filterType` changes, and once per frame before
 * the render pass to keep the `time` uniform current.
 *
 * @returns {void}
 */
WebGPURenderer.prototype.updateUniforms = function() {
    if (!this._ready) return;
    const data = this._uniformData;
    data[0] = this._filterType;
    data[1] = performance.now() / 1000;
    data[2] = this._width;
    data[3] = this._height;
    this._device.queue.writeBuffer(this._uniformBuffer, 0, data);
};

/**
 * Selects the active post-processing filter by numeric ID.
 *
 * @param {number|string} id - Filter mode (0 = RAW, 1 = Sharp Bilinear, 2–3 = CRT, 5 = AI-Smooth).
 * @returns {void}
 */
WebGPURenderer.prototype.setFilter = function(id) {
    this._filterType = parseFloat(id);
    this.updateUniforms();
    console.log("[WebGPU] Filter set:", id);
};

/**
 * Uploads a new CPC framebuffer to the GPU texture and submits a render pass
 * that applies the active post-processing filter.
 *
 * The full-screen quad is drawn with 6 vertices (two triangles covering NDC).
 *
 * @param {ImageData} imageData - RGBA pixel data with dimensions matching `_width × _height`.
 * @returns {void}
 */
WebGPURenderer.prototype.uploadAndDisplay = function (imageData) {
    if (!this._ready) return;
    this.updateUniforms();
    this._device.queue.writeTexture(
        { texture: this._texture },
        imageData.data,
        { bytesPerRow: this._width * 4 },
        { width: this._width, height: this._height }
    );
    const encoder = this._device.createCommandEncoder();
    const swapTexture = this._context.getCurrentTexture();
    const pass = encoder.beginRenderPass({
        colorAttachments: [{
            view: swapTexture.createView(),
            loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store"
        }]
    });
    const w = swapTexture.width;
    const h = swapTexture.height;
    pass.setViewport(0, 0, w, h, 0, 1);
    pass.setScissorRect(0, 0, w, h);
    pass.setPipeline(this._pipeline);
    pass.setBindGroup(0, this._bindGroup);
    pass.draw(6);
    pass.end();
    this._device.queue.submit([encoder.finish()]);
};

global.WebGPURenderer = WebGPURenderer;
}(window));
