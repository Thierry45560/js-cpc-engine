/**
 * @file loader.js
 * @description Sequential async script loader for the JS CPC emulator.
 *
 * Loads all emulator modules in strict dependency order using an async IIFE.
 * Each script tag is created with `async = false` so the browser executes them
 * in the order they are appended, even though the network requests may overlap.
 * A rejected Promise (network or parse error) propagates out of the IIFE and
 * appears in the browser console.
 *
 * Load order:
 *   1. UI_DOM.js                  — DOM helpers and UI bindings (jQuery-based)
 *   2. Tools_Formatters.js        — hex/binary formatting utilities
 *   3. ZipTools.js                — ZIP archive reader (for SNA/DSK inside ZIP)
 *   4. Z80.js                     — Zilog Z80 CPU core
 *   5. Memory.js                  — RAM/ROM banking and memory manager
 *   6. RomLoader.js               — Firmware ROM fetch and patch
 *   7. GateArray.js               — Amstrad Gate Array (palette, interrupts)
 *   8. WebGPURenderer.js          — WebGPU backend (no-op if unsupported)
 *   9. Canvas2DRenderer.js        — Canvas 2D fallback renderer
 *   10. RendererFactory.js        — Renderer selection logic
 *   11. RendererBridge.js         — Unified renderer API
 *   12. Display.js                — Pixel buffer, sync manager, frame output
 *   13. MC6845.js                 — Motorola 6845 CRTC (all 4 variants)
 *   14. ASIC.js                   — CPC+ ASIC (DMA, sprites, palette)
 *   15. AY38910.js                — AY-3-8910 PSG sound chip
 *   16. WebAudioHost.js           — Web Audio API output host
 *   17. PPI_8255.js               — Intel 8255 PPI (keyboard, tape, PSG bus)
 *   18. IO_Bus.js                 — I/O address decoder and bus manager
 *   19. peripheral/Keyboard.js    — Keyboard matrix and AutoType engine
 *   20. peripheral/Printer.js     — Centronics printer port
 *   21. peripheral/DSK_Parser.js  — DSK floppy disk image parser
 *   22. peripheral/FDC_Controller.js — µPD765 floppy disk controller
 *   23. peripheral/Floppy_UI.js   — Floppy drive UI bindings
 *   24. peripheral/Tape.js        — Cassette tape controller and WAV parser
 *   25. peripheral/Snapshot.js    — SNA snapshot save/load
 *   26. peripheral/Cartouche.js   — CPC+ CPR cartridge loader
 *   27. Config.js                 — User preferences and configuration
 *   28. CPC_Bus.js                — Module linker (must be last core module)
 *   29. Emulator_Core.js          — Main emulation loop and hard reset
 *   30. Emulator_Setup.js         — Browser bootstrap and document.ready wiring
 *   31. js/pages/cpc-blank.js     — Page-specific entry point (add custom code here)
 */
(async function loadEmulator() {
    const scripts = [
        "js/UI_DOM.js",

        "js/Tools/Tools_Formatters.js",
        "js/Tools/ZipTools.js",

        "js/Z80.js",
        "js/Memory.js",
        "js/RomLoader.js",
        "js/GateArray.js",

        "js/renderer/WebGPURenderer.js",
        "js/renderer/Canvas2DRenderer.js",
        "js/renderer/RendererFactory.js",
        "js/renderer/RendererBridge.js",
        "js/Display.js",
        "js/MC6845.js",
        "js/ASIC.js",
        "js/AY38910.js",
        "js/WebAudioHost.js",
        "js/PPI_8255.js",
        "js/IO_Bus.js",

        "js/peripheral/Keyboard.js",
        "js/peripheral/Printer.js",
        "js/peripheral/DSK_Parser.js",
        "js/peripheral/FDC_Controller.js",
        "js/peripheral/Floppy_UI.js",
        "js/peripheral/Tape.js",
        "js/peripheral/Snapshot.js",
        "js/peripheral/Cartouche.js",

        "js/Config.js",
        "js/CPC_Bus.js",
        "js/Emulator_Core.js",
        "js/Emulator_Setup.js",

        // Add page-specific entry point last.
        "js/pages/cpc-blank.js"
    ];

    const target = document.head || document.documentElement;

    for (const src of scripts) {
        await new Promise((resolve, reject) => {
            const script   = document.createElement("script");
            script.src     = src;
            script.async   = false;
            script.onload  = resolve;
            script.onerror = () => reject(new Error(`Failed to load: ${src}`));
            target.appendChild(script);
        });
    }

    console.log("CPC emulator fully loaded.");
})();
