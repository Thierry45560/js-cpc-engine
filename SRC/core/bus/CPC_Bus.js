"use strict";

/**
 * @file CPC_Bus.js — Central wiring file (load last).
 *
 * Load order in your HTML — CPC_Bus.js MUST come last:
 *
 *   <!-- Utilities (no dependencies) -->
 *   <script src="js/Tools_Formatters.js"></script>
 *   <script src="js/ZipTools.js"></script>
 *   <!-- Emulation engine -->
 *   <script src="js/Z80.js"></script>
 *   <script src="js/Memory.js"></script>
 *   <script src="js/GateArray.js"></script>
 *   <script src="js/Display.js"></script>
 *   <script src="js/MC6845.js"></script>
 *   <script src="js/ASIC.js"></script>
 *   <script src="js/AY38910.js"></script>
 *   <script src="js/PPI_8255.js"></script>
 *   <script src="js/IO_Bus.js"></script>
 *   <!-- Peripherals -->
 *   <script src="js/peripheral/Keyboard.js"></script>
 *   <script src="js/peripheral/Printer.js"></script>
 *   <script src="js/peripheral/Floppy.js"></script>
 *   <script src="js/peripheral/Tape.js"></script>
 *   <script src="js/peripheral/Snapshot.js"></script>
 *   <script src="js/peripheral/Cartouche.js"></script>
 *   <!-- Main engine + wiring -->
 *   <script src="js/Emulator_Setup.js"></script>
 *   <script src="js/CPC_Bus.js"></script>   ← last, wires everything
 *
 * This file wires each module's `_bus` dependencies via its `link()` method
 * and instantiates `window.CPU_Z80`.
 * It is the ONLY place where modules know about each other.
 */

// =============================================================================
// GLOBAL UTILITIES
// =============================================================================

/**
 * Global error handler. Logs the message to the console.
 * @param {string} msg - Error description.
 */
window.throwError = function throwError(msg) {
    console.error(msg);
};

// =============================================================================
// STUBS — default values if the host application has not defined them
// =============================================================================

if (typeof Config_Manager === "undefined") {
    window.Config_Manager = {
        brandId:             0,
        language:            "en",
        ramExpansion:        false,
        soundEnabled:        true,
        volume:              1.0,
        monitorPalette:      [],
        joystickEnabled:     false,
        audioOutputFunction: null,
        /** @param {number} v */
        setVolume(v) { this.volume = v; }
    };
}

if (typeof Machine_Type === "undefined") {
    window.Machine_Type = 0;
}

if (typeof Emulator_Core === "undefined") {
    window.Emulator_Core = {
        tStates:      0,
        executeTicks: () => {},
        reset:        () => {}
    };
}

// =============================================================================
// MODULE WIRING
// =============================================================================

/**
 * Memory_Manager (Memory.js)
 * machineType and ramExpansion are local properties initialised to defaults.
 * Override them before calling link() for non-6128 machines.
 */
Memory_Manager.link({});

/**
 * ROM_Manager (Memory.js)
 * Receives palette config updates, ASIC read/write callbacks.
 */
ROM_Manager.link({
    updatePaletteRom: (val)          => { Palette_Colors.romConfig = val; },
    readAsic:         (offset)       => ASIC_Manager.read(offset),
    writeAsic:        (offset, val)  => ASIC_Manager.write(offset, val),
});

/**
 * CRTC_Manager (MC6845.js)
 * machineType is a local property (default: 2).
 * Receives ASIC unlock feed and split-screen parameters from ASIC_Manager.
 */
CRTC_Manager.link({
    feedUnlock      : (val) => ASIC_Manager.feedAsicUnlock(val),
    getAsicHScroll  : ()    => ASIC_Manager.asicHScroll,
    getAsicSplitLine: ()    => ASIC_Manager.asicSplitLine,
    getAsicSsaHigh  : ()    => ASIC_Manager.asicSsaHigh,
    getAsicSsaLow   : ()    => ASIC_Manager.asicSsaLow,
    getAsicSscr     : ()    => ASIC_Manager.asicSscr,
    renderAsicSplit : ()    => PriManager.renderAsicSplit(),
});

/**
 * Palette_Colors (GateArray.js)
 * machineType and monitorPalette are local properties.
 * Aggregates CRTC timing signals, RAM video data, ROM banking,
 * ASIC state, and rendering callbacks from Video_Hardware and Display_Sync_Manager.
 */
Palette_Colors.link({
    getMonitorPalette    : () => Config_Manager.monitorPalette,
    getHsyncActive       : () => CRTC_Manager.hsyncActive,
    getVsyncActive       : () => CRTC_Manager.vsyncActive,
    getVcc               : () => CRTC_Manager.vcc,
    getVlcCrtc           : () => CRTC_Manager.vlc_crtc,
    getBorder            : () => CRTC_Manager.border,
    getMaRow             : () => CRTC_Manager.maRow,
    getVlc               : () => CRTC_Manager.vlc,
    getRamData           : () => Memory_Manager.ramData,
    getRamArrayRef       : () => Memory_Manager.ramData,
    selectAsicRom        : (n)   => ROM_Manager.selectAsicRom(n),
    updateRomConfig      : (cfg) => ROM_Manager.updateRomConfig(cfg),
    getAsicLocked        : () => ASIC_Manager.asicLocked,
    getAsicPri           : () => ASIC_Manager.asicPri,
    getAsicIvr           : () => ASIC_Manager.asicIvr,
    feedAsicUnlock       : (val) => ASIC_Manager.feedAsicUnlock(val),
    triggerAsicDmaUpdate : ()    => ASIC_DMA_Controller.updateStatus(),
    getDmaStatusControl  : () => ASIC_DMA_Controller.statusControl,
    setDmaStatusControl  : (val) => { ASIC_DMA_Controller.statusControl = val; },
    setHwPalette         : (pen, val) => { Video_Hardware.hwPalette[pen] = val; },
    setRenderMode(mode) {
        const vh = Video_Hardware;
        switch (mode) {
            case 0: vh.renderPixelFunc = vh.renderMode0.bind(vh); break;
            case 1: vh.renderPixelFunc = vh.renderMode1.bind(vh); break;
            case 2: vh.renderPixelFunc = vh.renderMode2.bind(vh); break;
        }
    },
    renderBlank          : ()     => Video_Hardware.renderBlank(),
    renderBorder         : ()     => Video_Hardware.renderBorder(),
    renderPixelFunc      : (word) => Video_Hardware.renderPixelFunc(word),
    skipRender           : ()     => Video_Hardware.skipRender(),
    advancePixel() {
        Video_Hardware.pixelIndex += 16;
        Video_Hardware.spriteX = (Video_Hardware.spriteX + 16) & 1023;
    },
    getPixelIndex        : () => Video_Hardware.pixelIndex,
    syncPhase            : ()  => Display_Sync_Manager.syncPhase(),
    triggerVBlank        : ()  => Display_Sync_Manager.triggerVBlank(),
    adjustPLL            : ()  => Display_Sync_Manager.adjustPLL(),
    getVblankCounter     : () => Display_Sync_Manager.vblankCounter,
    getLineBufferOffset  : () => Display_Sync_Manager.lineBufferOffset,
    getLineBufferLimit   : () => Display_Sync_Manager.lineBufferLimit,
});

/**
 * PSG_Sound_AY38910 (AY38910.js)
 * Receives keyboard row reads and PPI Port C state.
 */
PSG_Sound_AY38910.link({
    readKeyboardRow: () => Keyboard_Manager.readMatrixRow(),
    getPpiPortC    : () => PPI_8255.portC,
});

/**
 * Audio_Output (AY38910.js)
 * Receives sound config and per-channel PSG output values.
 */
Audio_Output.link({
    getSoundEnabled: () => Config_Manager.soundEnabled,
    getVolume      : () => Config_Manager.volume,
    getAudioOutput : () => Config_Manager.audioOutputFunction,
    getTapeBitOut  : () => TapeController.tapeBitOut,
    getMotorRelay  : () => TapeController.motorRelay,
    getChanA       : () => PSG_Sound_AY38910.Output_ChanA,
    getChanB       : () => PSG_Sound_AY38910.Output_ChanB,
    getChanC       : () => PSG_Sound_AY38910.Output_ChanC,
    psgClock       : () => PSG_Sound_AY38910.Clock_Cycle(),
});

/**
 * PPI_8255 (PPI_8255.js)
 * machineType is a local property (default: 2).
 * Bridges the PSG, tape motor, VSync signal, brand ID, and joystick inputs.
 */
PPI_8255.link({
    readPsg       : ()    => PSG_Sound_AY38910.readPort(),
    writePsg      : (val) => PSG_Sound_AY38910.writePort(val),
    getTapeBitOut : ()    => TapeController.tapeBitOut,
    getVsyncActive: ()    => CRTC_Manager.vsyncActive,
    getBrandId    : ()    => Config_Manager.brandId,
    getJoystick1  : ()    => InputExpansion.joystick1 ?? 1,
    getJoystick2  : ()    => InputExpansion.joystick2 ?? 0,
    setMotorRelay : (v)   => TapeController.setMotorRelay(v),
    throwError    : (msg) => throwError(msg),
});

/**
 * TapeController (Tape.js)
 * Reads PPI Port C to determine cassette motor state.
 */
TapeController.link({
    getPpiPortC: () => PPI_8255.portC,
});

/**
 * Keyboard_Manager (Keyboard.js)
 * Reads joystick-enabled flag and the currently selected keyboard row
 * from PPI Port C bits 3:0.
 */
Keyboard_Manager.link({
    getJoystickEnabled: () => Config_Manager.joystickEnabled,
    getSelectedRow    : () => PPI_8255.portC & 0x0F,
});

/**
 * AutoType (Keyboard.js)
 * Reads the active firmware language to build the correct character map.
 */
AutoType.bus = {
    get language() { return Config_Manager.language; }
};

/** InputExpansion (Keyboard.js) — standalone, no bus required. */
InputExpansion._bus = {};

/**
 * IO_Manager (IO_Bus.js)
 * machineType is a local property (default: 2).
 * Routes Z80 I/O reads and writes to every peripheral.
 */
IO_Manager.link({
    readPrinter      : (addr)       => VirtualPrinter.readPort(addr),
    readCrtc         : (addr)       => CRTC_Manager.readPort(addr),
    readPpi          : (addr)       => PPI_8255.readPort(addr),
    readFdc          : (addr)       => Floppy_Controller_FDC.readPort(addr),
    writePrinter     : (addr, data) => VirtualPrinter.writePort(addr, data),
    writeCrtc        : (addr, data) => CRTC_Manager.writePort(addr, data),
    writePalette     : (addr, data) => Palette_Colors.writePort(addr, data),
    writeRom         : (addr, data) => ROM_Manager.writePort(addr, data),
    writeMemory      : (addr, data) => Memory_Manager.writePort(addr, data),
    writePpi         : (addr, data) => PPI_8255.writePort(addr, data),
    writeFdc         : (addr, data) => Floppy_Controller_FDC.writePort(addr, data),
    writeInputExp    : (addr, data) => InputExpansion.writePort(addr, data),
    clearIoWriteState: ()           => { CPU_Z80.ioWriteState = 0; },
});

/**
 * PriManager (ASIC.js)
 * CPC+ hardware sprite manager — reads CRTC vertical counters to
 * determine which sprite line to render.
 */
PriManager.link({
    getVcc    : () => CRTC_Manager.vcc,
    getVlcCrtc: () => CRTC_Manager.vlc_crtc,
});

/**
 * Video_Hardware (Display.js)
 * machineType is a local property (default: 2).
 * Receives palette application callbacks, ASIC PRI buffer, and CRTC
 * horizontal counter for sprite X alignment.
 */
Video_Hardware.link({
    applyQueuedColor   : ()    => Palette_Colors.applyQueuedColor(),
    getAsicPriBuffer   : ()    => PriManager.buffer,
    getHccCounter      : ()    => CRTC_Manager.hcc_counter,
    getLineBufferOffset: ()    => Display_Sync_Manager.lineBufferOffset,
    setLineBufferOffset: (v)   => { Display_Sync_Manager.lineBufferOffset = v; },
    getCurrentLineY    : ()    => Display_Sync_Manager.currentLineY,
    getTopBorderLine   : ()    => Display_Sync_Manager.topBorderLine,
});

/**
 * Display_Sync_Manager (Display.js)
 * displayWidth and displayHeight are local properties (defaults: 768 × 272).
 * Drives the software PLL that synchronises the emulated CRT scan to the
 * host display VSync.
 */
Display_Sync_Manager.link({
    displayWidth : Video_Hardware.width,
    displayHeight: Video_Hardware.height,
    display      : ()    => Video_Hardware.display(),
    setPixelIndex: (val) => { Video_Hardware.pixelIndex = val; },
});

/**
 * ASIC_Manager (ASIC.js)
 * machineType is a local property (default: 2).
 * Manages the CPC+ ASIC register space: sprites, palette, scroll,
 * DMA control, and the hardware unlock sequence.
 */
ASIC_Manager.link({
    getHwPalette      : (i)        => Palette_Colors.hwColorIndex[i],
    writeColorLow     : (pen, val) => Palette_Colors.writeAsicColorLow(pen, val),
    writeColorHigh    : (pen, val) => Palette_Colors.writeAsicColorHigh(pen, val),
    setGaIntStatus    : (bits)     => { Palette_Colors.gaIntStatus |= bits; },
    getAsicRamEnabled : ()         => ROM_Manager.asicRamEnabled,
    setAsicRamEnabled : (v)        => { ROM_Manager.asicRamEnabled = v; },
    readMemory        : (addr)     => ROM_Manager.readMemory(addr),
    getDmaStatus      : ()         => ASIC_DMA_Controller.statusControl,
    setDmaStatus      : (v)        => { ASIC_DMA_Controller.statusControl = v; },
    getDmaChannels    : ()         => ASIC_DMA_Controller.channels,
    triggerDma        : ()         => ASIC_DMA_Controller.updateStatus(),
    getTStates        : ()         => Emulator_Core.tStates,
    executeTicks      : (n)        => Emulator_Core.executeTicks(n),
    getVcc            : ()         => CRTC_Manager.vcc,
    getVlcCrtc        : ()         => CRTC_Manager.vlc_crtc,
});

/**
 * ASIC_DMA_Controller (ASIC.js)
 * machineType is a local property (default: 2).
 * Three-channel DMA engine that drives the PSG from RAM command lists
 * without CPU intervention.
 */
ASIC_DMA_Controller.link({
    readMemory     : (addr)      => ROM_Manager.readMemory(addr),
    writePsgDma    : (reg, val)  => PSG_Sound_AY38910.writeFromDMA(reg, val),
    setGaIntStatus : (bits)      => { Palette_Colors.gaIntStatus |= bits; },
    executeTicks   : (n)         => Emulator_Core.executeTicks(n),
    getTStates     : ()          => Emulator_Core.tStates,
});

// =============================================================================
// Z80 CPU BUS — CPU instantiation
// =============================================================================

/**
 * Z80 bus interface object passed to the Z80 CPU constructor.
 * Provides memory read/write, I/O read, interrupt acknowledge, and
 * the T-state execution entry point used by the emulation loop.
 */
const Z80_Bus = {
    readMemory:           (addr)      => ROM_Manager.readMemory(addr),
    writeMemory:          (addr, val) => ROM_Manager.writeMemory(addr, val),
    readIO:               (addr)      => IO_Manager.readIO(addr),
    executeTicks:         (n)         => Emulator_Core.executeTicks(n),
    getIntStatus:         ()          => Palette_Colors.gaIntStatus,
    acknowledgeInterrupt: ()          => Palette_Colors.acknowledgeInterrupt()
};

/** @type {Z80_CPU} The emulated Z80 processor instance. */
window.CPU_Z80 = new Z80_CPU(Z80_Bus);
