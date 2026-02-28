"use strict";

/**
 * @module Emulator_Core
 * @description Main emulation loop, pause/resume control, hard reset, turbo mode,
 * and single-step debugging for the CPC emulator.
 *
 * Load order (index.html):
 *   1. Utils.js          — setCookie, getCookie, startTimer, throwError
 *   2. Config.js         — Config_Manager
 *   3. Emulator_Core.js  — this file
 *   4. Emulator_Setup.js — AppMain + $(document).ready bootstrap
 *
 * Dependencies:
 *   Config_Manager, CPU_Z80, Palette_Colors, Display_Sync_Manager,
 *   CRTC_Manager, IO_Manager, TapeController, Audio_Output,
 *   ASIC_DMA_Controller, Machine_Type (global), statusElement (global),
 *   emulationLoopTimer (global), fpsUpdateTimer (global)
 */

// ---------------------------------------------------------------------------
// Main-loop state variables
// ---------------------------------------------------------------------------

/** @type {number} Handle returned by setInterval for the FPS refresh callback. */
let fpsUpdateTimer;

/** @type {number} Handle returned by setInterval for the main emulation callback. */
let emulationLoopTimer;

/** @type {HTMLElement} Status bar element displaying "Running @ N fps" or "Paused". */
let statusElement;

/**
 * @type {number} Active machine model.
 * Values: 0=CPC 464, 1=CPC 664, 2=CPC 6128, 4=CPC 6128+, 5=CPC 464+.
 */
let Machine_Type;

/**
 * @type {Set<string>} Snapshot IDs that represent a clean boot (no SNA to load).
 * When the selected snapshot is in this set, hardReset() skips SNA parsing.
 */
const BOOT_IDS = new Set([
  "boot_cpc464", "boot_cpc664", "boot_cpc6128",
  "boot_464plus", "boot_6128plus"
]);


// ---------------------------------------------------------------------------
// Turbo mode — CPU loop via MessageChannel, display via requestAnimationFrame
//
// Why MessageChannel instead of setInterval(fn, 0)?
//   setInterval enforces a minimum ~4 ms delay (≤ 250 calls/sec).
//   MessageChannel tasks are processed in the microtask queue at ~0.1 ms
//   intervals, yielding roughly ×40 more CPU iterations per second.
//
// Why requestAnimationFrame for display?
//   In turbo mode, display() would be called hundreds of times per second.
//   putImageData() is expensive (GPU upload). We decouple it from the CPU
//   loop and let rAF push pixels to the screen at ≤ 60 Hz, synchronised
//   with the monitor's VSync.
// ---------------------------------------------------------------------------

/** @type {MessagePort|null} MessageChannel port 1 (sends messages to itself via port 2). */
let _turboMcPort1     = null;
/** @type {MessagePort|null} MessageChannel port 2 (bounces messages back to port 1). */
let _turboMcPort2     = null;
/** @type {number|null} requestAnimationFrame handle for the turbo render loop. */
let _turboRafId       = null;
/** @type {Function|null} Original Video_Hardware.display() saved before turbo patches it. */
let _turboOrigDisplay = null;
/** @type {number} Cumulative virtual frame count rendered in turbo mode (for stats). */
let virtualFrameCount = 0;


/**
 * Starts the turbo loop: Z80 runs at maximum speed on a MessageChannel
 * micro-task loop while the screen is refreshed at up to 60 Hz via rAF.
 *
 * Patch strategy for display():
 *   - The original display() is saved in _turboOrigDisplay.
 *   - The replacement fills the pixel buffer (internal state consistency)
 *     but skips the expensive putImageData / GPU upload.
 *   - The rAF callback performs the actual screen upload at 60 Hz.
 *   - turboStop() restores the original display().
 */
function turboStart() {
  const mc = new MessageChannel();
  _turboMcPort1 = mc.port1;
  _turboMcPort2 = mc.port2;

  mc.port1.onmessage = () => {
    if (!Config_Manager.turboMode) return;
    Emulator_Core.loopFast();
    mc.port2.postMessage(null);
  };
  mc.port2.postMessage(null);

  _turboOrigDisplay = Video_Hardware.display;

  Video_Hardware.display = function () {
    virtualFrameCount++;
    this.frameCounter++;

    const start = Math.max(this.pixelIndex, Display_Sync_Manager.lineBufferOffset);
    this.pixelBuffer32.fill(this.opaqueAlpha, start < 0 ? 0 : start);
  };

  const gpu = window._cpcGpuRenderer;

  const rafLoop = () => {
    if (!Config_Manager.turboMode) return;

    if (gpu) {
      gpu.uploadAndDisplay(Video_Hardware.imageData);
    } else {
      Video_Hardware.canvasCtx.putImageData(Video_Hardware.imageData, -15, 0);
    }

    _turboRafId = requestAnimationFrame(rafLoop);
  };
  _turboRafId = requestAnimationFrame(rafLoop);
}

/**
 * Stops the turbo loop cleanly: tears down the MessageChannel, cancels the
 * rAF render loop, and restores the original display() implementation.
 */
function turboStop() {
  if (_turboMcPort1) { _turboMcPort1.onmessage = null; _turboMcPort1 = null; }
  _turboMcPort2 = null;
  if (_turboRafId !== null) { cancelAnimationFrame(_turboRafId); _turboRafId = null; }
  if (_turboOrigDisplay) {
    Video_Hardware.display = _turboOrigDisplay;
    _turboOrigDisplay = null;
  }
}

/**
 * Toggles turbo mode on or off from the UI.
 * When toggled while the emulator is running, the active loop is replaced
 * immediately without pausing; when toggled while paused, the change takes
 * effect on the next resumeEmulator() call.
 */
function toggleTurbo() {
  Config_Manager.turboMode = !Config_Manager.turboMode;
  const isRunning = statusElement && !statusElement.innerHTML.includes("Paused");

  if (isRunning) {
    turboStop();
    clearInterval(emulationLoopTimer);

    if (Config_Manager.turboMode) {
      turboStart();
      statusElement.innerHTML = "⚡ TURBO";
    } else {
      emulationLoopTimer = Config_Manager.limitSpeed
        ? setInterval(Emulator_Core.loopFast, 10)
        : setInterval(Emulator_Core.loopFast,  1);
      statusElement.innerHTML = "Running";
    }
  }
}


// ---------------------------------------------------------------------------
// Emulator_Core
// ---------------------------------------------------------------------------

const Emulator_Core = {

  /** @type {number} Accumulated T-state count since the last reset. */
  tStates: 0,

  // ── Main loop ─────────────────────────────────────────────────────────────

  /**
   * Executes a block of T-states and is called periodically by setInterval.
   * Normal mode: 10 000 T-states per call (≈ 10 ms of emulated time at 1 MHz).
   * Turbo mode:  200 000 T-states per call (×20 multiplier to saturate the JS engine).
   */
  loopFast() {
    const core   = Emulator_Core;
    const z80    = CPU_Z80;
    const chunk  = Config_Manager.turboMode ? 200_000 : 10_000;
    const target = core.tStates + chunk;
    while (core.tStates < target) z80.exec();
  },

  /**
   * Simulates exactly `count` additional T-states, driving all CPC subsystems
   * in the correct hardware order for each clock cycle:
   *
   *   1. Gate Array pixel clock and display sync
   *   2. Z80 memory/I/O contention arbitration
   *   3. CRTC HSync generation and border rendering
   *   4. Tape motor and bit stream (every 8 T-states)
   *   5. PSG audio sample generation (every 8 T-states, skipped in turbo)
   *   6. ASIC DMA channel execution (CPC+ only)
   *
   * Two inner loops exist to avoid the DMA branch on standard CPC models,
   * keeping the hot path as tight as possible.
   *
   * @param {number} count - Number of T-states to simulate.
   */
  executeTicks(count) {
    const pal   = Palette_Colors;
    const dsm   = Display_Sync_Manager;
    const crtc  = CRTC_Manager;
    const z80   = CPU_Z80;
    const io    = IO_Manager;
    const tape  = TapeController;
    const audio = Audio_Output;
    const cfg   = Config_Manager;
    const isDma = (Machine_Type >= 4);
    const dma   = isDma ? ASIC_DMA_Controller : null;

    let t     = this.tStates;
    const end = t + count;

    if (!isDma) {
      while (t < end) {
        pal.tick();
        dsm.tick();
        crtc.updateHsync();

        switch (z80.ioWriteState) {
          case 0: crtc.tick(); break;
          case 1: io.triggerIO(z80.ioWriteAddr, z80.ioWriteVal); crtc.tick(); break;
          case 2: crtc.tick(); io.triggerIO(z80.ioWriteAddr, z80.ioWriteVal); break;
        }

        crtc.renderBorder();
        crtc.checkHsync();
        pal.checkInterrupts();

        if ((t & 7) === 0) {
          tape.tick();
          if (!cfg.turboMode) audio.executeTicks();
        }

        t++;
      }

    } else {
      while (t < end) {
        pal.tick();
        dsm.tick();
        crtc.updateHsync();

        switch (z80.ioWriteState) {
          case 0: crtc.tick(); break;
          case 1: io.triggerIO(z80.ioWriteAddr, z80.ioWriteVal); crtc.tick(); break;
          case 2: crtc.tick(); io.triggerIO(z80.ioWriteAddr, z80.ioWriteVal); break;
        }

        crtc.renderBorder();
        crtc.checkHsync();
        pal.checkInterrupts();

        if ((t & 7) === 0) {
          tape.tick();
          if (!cfg.turboMode) audio.executeTicks();
        }

        dma.tick();
        t++;
      }
    }

    this.tStates = t;
  },

  // ── Reset ─────────────────────────────────────────────────────────────────

  /**
   * Resets all emulator subsystems in the correct dependency order.
   * Called by hardReset() after Machine_Type and configuration are applied.
   */
  reset() {
    this.tStates = 0;
    Display_Sync_Manager.reset();
    ROM_Manager.reset();
    Memory_Manager.reset();
    Palette_Colors.reset();
    ASIC_DMA_Controller.init();
    PriManager.reset();
    ASIC_Manager.reset();
    CPU_Z80.reset();
    CRTC_Manager.reset();
    PPI_8255.reset();
    InputExpansion.reset();
    PSG_Sound_AY38910.reset();
    Audio_Output.reset();
    Keyboard_Manager.init();
    TapeController.reset();
    Floppy_Controller_FDC.reset();
  },

  // ── Emulation control ─────────────────────────────────────────────────────

  /**
   * Resumes emulation from a paused state.
   * Updates the Run/Pause button label, starts the FPS timer, and launches
   * either the turbo MessageChannel loop or the standard setInterval loop.
   */
  resumeEmulator() {
    $("#button-step, #button-stepover")
      .removeClass("button").addClass("disabled-button");

    $("#button-run")
      .html('<span class="guifx2">2 </span>Pause')
      .off("click")
      .on("click", function () {
        if ($(this).hasClass("button")) Emulator_Core.pauseEmulator();
      });

    $("#button-run, #button-reset").removeClass("disabled-button").addClass("button");

    if ($("#logo").is(":visible")) {
      $("#logo").hide();
      $("#screen").show();
    }

    Video_Hardware.frameCounter = 0;
    startTimer();
    statusElement.innerHTML = Config_Manager.turboMode ? "⚡ TURBO" : "Running";
    fpsUpdateTimer = setInterval(this.updateFps, 1_000);

    if (Config_Manager.turboMode) {
      turboStart();
    } else {
      emulationLoopTimer = Config_Manager.limitSpeed
        ? setInterval(this.loopFast, 10)
        : setInterval(this.loopFast,  1);
    }
  },

  /**
   * Pauses emulation: stops the CPU loop and FPS timer, updates the UI, and
   * optionally opens the debugger if its checkbox is active.
   */
  pauseEmulator() {
    $("#button-run")
      .html('<span class="guifx2">d </span> Resume')
      .off("click")
      .on("click", function () {
        if ($(this).hasClass("button")) Emulator_Core.resumeEmulator();
      });

    $("#button-run, #button-reset, #button-step, #button-stepover")
      .removeClass("disabled-button").addClass("button");

    turboStop();
    clearInterval(emulationLoopTimer);
    clearInterval(fpsUpdateTimer);
    statusElement.innerHTML = "Paused";

    if ($("#checkbox-debugger").is(":checked")) launch_debugger();
  },

  // ── Single-step debugging ─────────────────────────────────────────────────

  /**
   * Executes exactly one Z80 instruction and refreshes the debugger view.
   */
  tick() {
    CPU_Z80.exec();
    launch_debugger();
  },

  /**
   * Executes Z80 instructions until the program counter advances past the
   * current instruction (step-over behaviour for CALL / DJNZ / etc.).
   */
  stepOver() {
    const startPC = CPU_Z80.regPC;
    do { CPU_Z80.exec(); } while (CPU_Z80.regPC === startPC);
    launch_debugger();
  },

  // ── Hard reset ────────────────────────────────────────────────────────────

  /**
   * Performs a full hard reset of the emulator.
   *
   * Sequence:
   *   1. Pause the running emulator.
   *   2. Determine Machine_Type from the snapshot selector value.
   *   3. Push Machine_Type to all subsystems (push model — no global reads in modules).
   *   4. Call reset() to reinitialise all subsystems.
   *   5. Re-apply configuration (CRTC type, palette, etc.).
   *   6. Load the CPR cartridge ROM for CPC+ models.
   *   7. Load the selected SNA file (if any) and resume or open the debugger.
   */
  hardReset() {
    this.pauseEmulator();

    const val        = $("#snapshot").val();
    const isBootMode = !val || val === "none" || BOOT_IDS.has(val);

    const hasCprCartridge = !!(
      window.currentCprPath &&
      window.files?.[window.currentCprPath]
    );

    switch (val) {
      case "boot_cpc464":   Machine_Type = 0; break;
      case "boot_cpc664":   Machine_Type = 1; break;
      case "boot_cpc6128":  Machine_Type = 2; break;
      case "boot_464plus":  Machine_Type = hasCprCartridge ? 5 : 0; break;
      case "boot_6128plus": Machine_Type = hasCprCartridge ? 4 : 2; break;
      default:
        if (!isBootMode) Machine_Type = 2;
        break;
    }

    ROM_Manager.machineType          = Machine_Type;
    Memory_Manager.machineType       = Machine_Type;
    Video_Hardware.machineType       = Machine_Type;
    Palette_Colors.machineType       = Machine_Type;
    CRTC_Manager.machineType         = Machine_Type;
    ASIC_Manager.machineType         = Machine_Type;
    ASIC_DMA_Controller.machineType  = Machine_Type;
    PPI_8255.machineType             = Machine_Type;
    IO_Manager.machineType           = Machine_Type;

    this.reset();

    if (Machine_Type === 2) {
      $("input:radio[name=crtc][value=type1]").prop("checked", true);
    } else if (Machine_Type >= 4) {
      $("input:radio[name=crtc][value=type3]").prop("checked", true);
    }

    Config_Manager.applyConfiguration();

    if (Machine_Type >= 4) {
      const cprPath = (window.currentCprPath && window.files?.[window.currentCprPath])
        ? window.currentCprPath
        : "ROM/CPC_PLUS.CPR";

      if (window.files?.[cprPath]) {
        CPR_Parser.parseFile(window.files[cprPath]);
        ROM_Manager.selectAsicRom(0);
        ROM_Manager.selectRom(1);
      } else {
        console.error(`[hardReset] CPC+ - CPR not found: ${cprPath}`);
      }
    } else {
      ROM_Manager.loadROMs();
    }

    $("#fieldset-drivea").show();
    if ($("#floppy-option").is(":checked")) $("#fieldset-driveb").show();
    if ($("#tape-option").is(":checked"))   $("#fieldset-tape").show();

    const isPlusMode =
      val === "boot_464plus" || val === "boot_6128plus" || Machine_Type >= 4;
    $("#fieldset-cart").toggle(isPlusMode);

    const launch = () => {
      $("#screen").show();
      $("#logo, #browser-nfo").hide();
      $("#checkbox-debugger").is(":checked")
        ? launch_debugger()
        : Emulator_Core.resumeEmulator();
    };

    if (isBootMode) {
      launch();
    } else {
      if (files[val]) {
        SNA_Parser.parseFile(files[val]);
      } else {
        console.warn(`[hardReset] SNA not found: ${val} - booting ROM defaults`);
      }
      launch();
    }
  },

  /**
   * Callback invoked after an externally loaded SNA file has been read.
   * Parses the snapshot and either opens the debugger or resumes normal emulation.
   * @param {ArrayBuffer} data - Raw SNA file bytes.
   */
  loadSnaCallback(data) {
    SNA_Parser.parseFile(data);
    $("#checkbox-debugger").is(":checked")
      ? launch_debugger()
      : Emulator_Core.resumeEmulator();
  },

  /**
   * Refreshes the FPS counter in the status bar.
   * Computes virtual FPS from Video_Hardware.frameCounter and elapsed wall time.
   * In turbo mode, also displays the percentage of nominal 50 Hz speed.
   */
  updateFps() {
    const elapsed    = getElapsedTime();
    const virtualFps = Math.round(1000 * Video_Hardware.frameCounter / elapsed);
    const speedPercent = Math.round((virtualFps / 50) * 100);

    statusElement.innerHTML = Config_Manager.turboMode
      ? `⚡ TURBO: ${speedPercent}% (${virtualFps} v-fps)`
      : `Running @ ${virtualFps} fps`;

    Video_Hardware.frameCounter = 0;
    startTimer();
  },
};
