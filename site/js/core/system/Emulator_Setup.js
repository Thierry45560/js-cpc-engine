"use strict";

/**
 * @module Emulator_Setup
 * @description Browser bootstrap for the JS CPC emulator.
 *
 * Responsibilities:
 *   - Global utility functions: cookie helpers, elapsed-time timer, error handler.
 *   - AppMain: browser compatibility check, singleton sealing, subsystem init,
 *     ROM preload, and initial hard reset.
 *   - DOMContentLoaded: DOM wiring, UI binding, synchronous bootstrap, then
 *     an optional asynchronous WebGPU upgrade that does not block startup.
 *   - _installWebGPUAsync: post-boot WebGPU canvas overlay with size tracking.
 *
 * Load order (index.html):
 *   1. Utils.js          — (this file now contains the utilities inline)
 *   2. Config.js         — Config_Manager
 *   3. Emulator_Core.js  — Emulator_Core, turboStart/Stop, toggleTurbo
 *   4. Emulator_Setup.js — this file
 */

// ---------------------------------------------------------------------------
// Global utility functions
// ---------------------------------------------------------------------------

/**
 * Writes a browser cookie with an optional expiry.
 * @param {string} name   - Cookie name.
 * @param {*}      value  - Cookie value (stringified automatically).
 * @param {number} [days] - Lifetime in days; omit for a session cookie.
 */
const setCookie = (name, value, days) => {
  let expires = "";
  if (days) {
    const date = new Date();
    date.setTime(date.getTime() + days * 86_400_000);
    expires = `; expires=${date.toGMTString()}`;
  }
  document.cookie = `${name}=${value}${expires}; path=/`;
};

/**
 * Reads a browser cookie by name.
 * @param  {string}      name - Cookie name to look up.
 * @returns {string|null}      Cookie value, or null if not found.
 */
const getCookie = (name) => {
  const prefix = `${name}=`;
  for (let part of document.cookie.split(";")) {
    part = part.trimStart();
    if (part.startsWith(prefix)) return part.slice(prefix.length);
  }
  return null;
};

/**
 * Deletes a cookie by setting its expiry to the past.
 * @param {string} name - Cookie name.
 */
const deleteCookie = (name) => setCookie(name, "", -1);

/** @type {number} Timestamp (ms) recorded by the most recent startTimer() call. */
let lastTimerTimestamp = 0;

/** Records the current wall-clock time for subsequent getElapsedTime() calls. */
const startTimer     = () => { lastTimerTimestamp = Date.now(); };

/**
 * Returns the number of milliseconds since the last startTimer() call.
 * Used by the FPS counter to measure one-second intervals.
 * @returns {number} Elapsed milliseconds.
 */
const getElapsedTime = () => Date.now() - lastTimerTimestamp;

/**
 * Installs a no-op console shim on browsers that expose no console object
 * (primarily legacy IE without DevTools open).
 */
const initConsoleStub = () => {
  if (typeof console === "undefined") {
    const noop = () => {};
    window.console = { log: noop, info: noop, warn: noop, error: noop, debug: noop };
  }
};

/**
 * Handles emulator errors: shows an alert for non-breakpoint messages,
 * then pauses the emulator and activates the debugger when debugMode is on.
 * @param {string} message - Error description, or "breakpoint" for silent pause.
 */
const throwError = (message) => {
  if (message !== "breakpoint") alert(message);
  if (Config_Manager.debugMode) {
    breakpoint = true;
    Emulator_Core.pauseEmulator();
  }
};


// ---------------------------------------------------------------------------
// AppMain — browser compatibility, sealing, and boot sequence
// ---------------------------------------------------------------------------

/**
 * @namespace AppMain
 * @description Orchestrates the emulator startup sequence: feature detection,
 * object sealing for JIT optimisation, subsystem initialisation, file preload,
 * and the initial hard reset.
 */
const AppMain = {

  /**
   * Verifies that all required browser APIs are available (Canvas 2D, ES5,
   * XMLHttpRequest Level 2, FileReader with readAsArrayBuffer).
   * Displays a user-readable error list and returns false on any failure.
   * @returns {boolean} true if the browser is compatible, false otherwise.
   */
  checkCompatibility() {
    const canvas = document.getElementById("screen");
    let ok = Video_Hardware.init(canvas);
    const journal = () => document.querySelector("#error-log");

    if (typeof Object.seal === "undefined") {
      journal()?.insertAdjacentHTML("beforeend", "<p>Your browser doesn't support ECMAScript5.</p>");
      ok = false;
    }
    if (typeof XMLHttpRequest === "undefined") {
      journal()?.insertAdjacentHTML("beforeend", "<p>Your browser doesn't support AJAX XMLHttpRequest.</p>");
      ok = false;
    } else {
      const xhr = new XMLHttpRequest();
      if (typeof xhr.response === "undefined") {
        journal()?.insertAdjacentHTML("beforeend", "<p>Your browser doesn't support AJAX XMLHttpRequest Level2.</p>");
        ok = false;
      }
    }
    if (typeof FileReader === "undefined") {
      journal()?.insertAdjacentHTML("beforeend", "<p>Your browser doesn't support HTML5 File API.</p>");
      ok = false;
    } else if (typeof new FileReader().readAsArrayBuffer === "undefined") {
      journal()?.insertAdjacentHTML("beforeend", "<p>Your browser doesn't support HTML5 File API: readAsArrayBuffer().</p>");
      ok = false;
    }
    if (!ok) {
      const log = journal();
      if (log) {
        log.insertAdjacentHTML("afterbegin", "<div>JS CPC won't work on this browser:</div><ul>");
        log.insertAdjacentHTML("beforeend", "</ul>");
        log.style.display = '';
      }
    }
    return ok;
  },

  /**
   * Calls Object.seal() on every emulator singleton.
   * Sealing freezes the object's property set so the JS engine can assign
   * a stable hidden class, eliminating dictionary-mode lookups on the hot path.
   * Note: sealed objects can still have their existing properties mutated.
   */
  sealObjects() {
    const singletons = [
      Floppy_Drive_A, Floppy_Drive_B, Tape_Recorder, Cart_Drive,
      ASIC_Manager, AppMain, IO_Manager, Video_Hardware, Config_Manager,
      Emulator_Core, CRTC_Manager, CRTC_Type0, CRTC_Type1, CRTC_Type2,
      CRTC_Type3, ASIC_DMA_Controller, PriManager, Palette_Colors,
      CPC_INPUT, CPC_INPUT.keyboard, CPC_INPUT.inputExpansion, CPC_INPUT.autoType, ROM_Manager, Memory_Manager, CPR_Parser,
      DSK_Parser, SNA_Parser, WAV_Parser, PPI_8255,
      PSG_Sound_AY38910, TapeController, Display_Sync_Manager,
      Audio_Output, CPU_Z80,
    ];
    singletons.forEach(Object.seal);
  },

  /**
   * Initialises subsystems that require explicit setup before sealing.
   * Called by reset() before sealObjects().
   */
  init() {
    PriManager.init();
    ASIC_Manager.init();
    Palette_Colors.init();
    TapeController.init();
  },

  /**
   * Full bootstrap sequence:
   *   1. init() — subsystem pre-seal setup.
   *   2. sealObjects() — freeze property sets for JIT.
   *   3. initConsoleStub() — shim console on IE.
   *   4. Config_Manager.init() — apply persisted preferences.
   *   5. Video_Hardware.reset() — clear frame buffer.
   *   6. preloadFiles() — load any bundled assets.
   *   7. ROM_Manager.loadROMs() — fetch and patch CPC firmware ROMs.
   */
  reset() {
    this.init();
    this.sealObjects();
    initConsoleStub();
    Config_Manager.init();
    Video_Hardware.reset();
    this.preloadFiles();
    ROM_Manager.loadROMs();

    if (!Config_Manager.debugMode) {
      window.addEventListener("resize", () => UI_Manager.resizeCanvas());
      UI_Manager.resizeCanvas();
    }
  },

  /** Placeholder for preloading bundled assets (DSK images, cartridges, etc.). */
  preloadFiles() {},

  /**
   * Reads the firmware language cookie, selects the default machine model from
   * the snapshot selector, then fetches all required ROM files before triggering
   * the first hardReset().
   *
   * The ROM list is determined by getRomListForMachine() (defined in the page
   * script). Once all ROMs are loaded the status bar shows "Starting…" and
   * hardReset() is called.
   */
  loadInitialRoms() {
    let lang = (typeof getCookie === "function") ? getCookie("firmware") : null;
    if (!["english", "french", "spanish"].includes(lang)) lang = "english";

    const selecteur = document.querySelector("#snapshot");
    let machine = selecteur?.value || "boot_cpc6128";
    if (!machine || machine === "none") machine = "boot_cpc6128";
    if (selecteur) selecteur.value = machine;

    if (typeof DEFAULT_CRTC !== "undefined" && DEFAULT_CRTC[machine]) {
      const crtcVal = DEFAULT_CRTC[machine];
      const radio = document.querySelector("input[type=radio][name=crtc][value=" + crtcVal + "]");
      if (radio) radio.checked = true;
    }
    if (machine === "boot_6128plus" || machine === "boot_464plus") {
      const cart = document.querySelector("#fieldset-cart");
      if (cart) cart.style.display = '';
    }

    const filesToLoad = (typeof getRomListForMachine === "function")
      ? getRomListForMachine(machine, lang) : [];

    const barre = document.querySelector("#status");
    if (barre) barre.textContent = "Loading ROMs…";
    let loaded = 0;

    function onRomLoaded() {
      loaded++;
      if (loaded >= filesToLoad.length) {
        const b = document.querySelector("#status");
        if (b) b.textContent = "Starting…";
        Emulator_Core.hardReset();
      }
    }

    if (filesToLoad.length === 0) {
      Emulator_Core.hardReset();
    } else {
      filesToLoad.forEach(path => loadRomFile(path, onRomLoaded));
    }
  },
};


// ---------------------------------------------------------------------------
// Bootstrap — synchronous startup followed by optional async WebGPU upgrade
// ---------------------------------------------------------------------------

(function () {
    function demarrer() {

    UI_Manager.init();

    if (!AppMain.checkCompatibility()) return;

    window.statusElement = document.getElementById("status");
    Floppy_Drive_A.ledElement    = document.getElementById("drivea-led");
    Floppy_Drive_B.ledElement    = document.getElementById("driveb-led");
    Tape_Recorder.counterElement = document.getElementById("tape-counter");

    UI_Manager.blurFormControls();
    UI_Manager.bindMainButtons();
    UI_Manager.bindSettingsPanel();
    UI_Manager.bindSoundButton();
    UI_Manager.bindSnapshotSelector();
    UI_Manager.bindFloppyDrives();
    UI_Manager.bindTape();
    UI_Manager.bindKeyboard();
    UI_Manager.bindSnapshot();
    UI_Manager.bindCartridge();

    if (!Config_Manager.debugMode) {
            window.addEventListener("resize", () => UI_Manager.resizeCanvas());
        UI_Manager.resizeCanvas();
    }

    // Synchronous bootstrap — emulator starts in Canvas 2D mode.
    AppMain.reset();
    AppMain.loadInitialRoms();

    // Asynchronous WebGPU upgrade — attempted after the emulator is running.
    //
    // Why after reset()?
        //   _installWebGPUAsync is async (Promise-based). Making the boot function
        //   async would move its errors into an unhandled promise rejection, so we
        //   keep reset() and loadInitialRoms() synchronous. By deferring the WebGPU
        //   path we guarantee Canvas 2D startup regardless of GPU availability.
    //
    // Why it works after Object.seal():
    //   seal() prevents new properties but allows existing ones to be mutated.
    //   Video_Hardware.display is already declared, so it can be replaced.
    //
    if (typeof WebGPURenderer !== "undefined" && navigator.gpu) {
        _installWebGPUAsync();
    }
    };

    // Remplacement de `$(document).ready(fn)`.
    //
    // `demarrer` est declaree dans cette IIFE et non pas en`tete de fichier :
    // le nom d`une IIFE nommee n`est visible que dans sa propre portee, donc
    // une garde ecrite a l`exterieur lerverait un ReferenceError. C`est un piege
    // que `node --check` ne voit pas et que les tests statiques ne pouvaient pas
    // voir non plus : seul l`execution dans un navigateur le revelait.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', demarrer, { once: true });
    } else {
        demarrer();
    }
})();


// ---------------------------------------------------------------------------
// _installWebGPUAsync — post-boot WebGPU canvas overlay
// ---------------------------------------------------------------------------

/**
 * Attempts to initialise a WebGPU renderer and overlay its canvas on top of
 * the existing Canvas 2D screen. If initialisation fails the overlay is removed
 * and the emulator continues on Canvas 2D unaffected.
 *
 * Overlay sizing strategy:
 *   The GPU canvas uses the same internal resolution as the CPC pixel buffer
 *   (Video_Hardware.width × Video_Hardware.height). Its CSS dimensions are kept
 *   in sync with the Canvas 2D element via syncSize(), which is called on
 *   window resize, fullscreenchange, and after every UI_Manager.resizeCanvas().
 *
 * display() patch:
 *   The original Video_Hardware.display() is replaced with a version that fills
 *   the pixel buffer and calls gpu.uploadAndDisplay() instead of putImageData().
 *   The Canvas 2D element is hidden (visibility:hidden) so the GPU canvas shows.
 */
function _installWebGPUAsync() {
    const canvas2d = document.getElementById("screen");
    if (!canvas2d) return;

    const vh = Video_Hardware;

    const gpuCanvas = document.createElement("canvas");
    gpuCanvas.id = "screen-gpu";

    gpuCanvas.width  = vh.width;
    gpuCanvas.height = vh.height;

    gpuCanvas.style.position       = "absolute";
    gpuCanvas.style.zIndex         = "10";
    gpuCanvas.style.imageRendering = "pixelated";

    canvas2d.parentNode.insertBefore(gpuCanvas, canvas2d.nextSibling);

    const gpu = new WebGPURenderer();

    gpu.init(gpuCanvas, canvas2d, vh.width, vh.height).then(function (ok) {
        if (!ok) { gpuCanvas.remove(); return; }

        const origDisplay = vh.display;
        vh.display = function () {
            const start = Math.max(this.pixelIndex, this._getLineBufferOffset());
            this.pixelBuffer32.fill(this.opaqueAlpha, start < 0 ? 0 : start);
            this.frameCounter++;
            gpu.uploadAndDisplay(this.imageData);
        };

        canvas2d.style.visibility = "hidden";
        window._cpcGpuRenderer = gpu;

        /**
         * Synchronises the GPU canvas position and CSS size with the Canvas 2D
         * element after any layout change (resize, fullscreen toggle).
         */
        function syncSize() {
            gpuCanvas.style.top    = canvas2d.offsetTop    + "px";
            gpuCanvas.style.left   = canvas2d.offsetLeft   + "px";
            gpuCanvas.style.width  = canvas2d.offsetWidth  + "px";
            gpuCanvas.style.height = canvas2d.offsetHeight + "px";
        }

        window.addEventListener("resize", syncSize);

        if (typeof UI_Manager !== "undefined" && UI_Manager.resizeCanvas) {
            const _oldResize = UI_Manager.resizeCanvas.bind(UI_Manager);
            UI_Manager.resizeCanvas = function() {
                _oldResize();
                syncSize();
            };
        }

        syncSize();
        document.addEventListener("fullscreenchange", () => setTimeout(syncSize, 100));
    });
}
