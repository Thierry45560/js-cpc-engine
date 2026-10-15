"use strict";

/**
 * @module Config_Manager
 * @description Manages user preferences for the CPC emulator: persistence via browser
 * cookies, application of settings to all subsystems, volume control, and FPS display.
 *
 * Load order (index.html):
 *   1. Utils.js          — setCookie, getCookie, startTimer, throwError
 *   2. Config.js         — this file
 *   3. Emulator_Core.js  — main emulation loop
 *   4. Emulator_Setup.js — AppMain + bootstrap DOMContentLoaded
 *
 * Dependencies:
 *   Reads  : setCookie, getCookie (Utils.js globals)
 *   Calls  : Floppy_Drive_A/B, CPC_INPUT, ROM_Manager, Video_Hardware,
 *             Palette_Colors, Audio_Output, CRTC_Manager, Tape_Recorder,
 *             Memory_Manager, Config_Manager (self-reference for callbacks)
 */
const Config_Manager = {

  /** @type {boolean} Developer mode — breakpoints active when true. */
  debugMode:           false,
  /** @type {boolean} Cap emulation speed to real-time 50 Hz when true. */
  limitSpeed:          true,
  /** @type {boolean} Uncapped turbo mode (CPU runs as fast as possible). */
  turboMode:           false,
  /** @type {boolean} Digital joystick remapping enabled. */
  joystickEnabled:     true,
  /** @type {boolean} Audio output active. */
  soundEnabled:        false,
  /** @type {number|null} Normalised volume [0.0–1.0] on a logarithmic perceptual curve. */
  volume:              null,
  /** @type {number|null} Brand identifier: 4=AWA, 5=Schneider, 7=Amstrad. */
  brandId:             null,
  /** @type {string|null} Active firmware locale: "english" | "french" | "spanish". */
  language:            null,
  /** @type {Array|null} Active monitor palette reference (colour / green / gray). */
  monitorPalette:      null,
  /** @type {Function|null} Audio mixing function: Audio_Output.Mono or Audio_Output.Stereo. */
  audioOutputFunction: null,
  /** @type {boolean|null} 512 KB RAM expansion present. */
  ramExpansion:        null,

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Primary initialisation: sets default volume, marks both floppy drives as
   * ready, then loads persisted settings and applies them to all subsystems.
   */
  init() {
    this.setVolume(75);
    Floppy_Drive_A.MediaIn = true;
    Floppy_Drive_B.MediaIn = true;
    Floppy_Drive_A.ready   = true;
    this.loadConfiguration();
    this.applyConfiguration();
  },

  // ---------------------------------------------------------------------------
  // Persistence (cookies)
  // ---------------------------------------------------------------------------

  /**
   * Serialises the current UI radio/checkbox state to cookies (365-day expiry).
   * Called when the user confirms the settings panel.
   */
  saveConfiguration() {
    const radio = (name) => document.querySelector(`input[type=radio][name=${name}]:checked`)?.value;
    const coche = (sel) => document.querySelector(sel)?.checked;
    setCookie("brand",    radio("brand"),    365);
    setCookie("firmware", radio("firmware"), 365);
    setCookie("monitor",  radio("monitor"),  365);
    setCookie("audio",    radio("audio"),    365);
    setCookie("crtc",     radio("crtc"),     365);
    setCookie("floppy",   coche("#floppy-option"), 365);
    setCookie("tape",     coche("#tape-option"),   365);
    setCookie("ram",      coche("#ram-option"),    365);
    setCookie("sound",    Config_Manager.soundEnabled, 365);
  },

  /**
   * Restores persisted preferences from cookies and ticks the corresponding
   * radio buttons / checkboxes in the settings panel.
   * Invalid or absent cookie values fall back to safe defaults.
   */
  loadConfiguration() {
    let val;

    // Set the `checked` property (not the attribute): it is the real state
    // of the control, even if the user already toggled it.
    const cocher = (selecteur) => {
      const radio = document.querySelector(selecteur);
      if (radio) radio.checked = true;
    };

    val = getCookie("brand");
    if (!["awa", "schneider", "amstrad"].includes(val)) val = "amstrad";
    cocher(`input[type=radio][name=brand][value=${val}]`);

    val = getCookie("firmware");
    if (!["english", "french", "spanish"].includes(val)) {
      const detectedLayout = CPC_INPUT.detectLayoutFromNavigatorLanguage();
      val = ({ US: "english", FR: "french", ES: "spanish" })[detectedLayout];
    }
    cocher(`input[type=radio][name=firmware][value=${val}]`);

    val = getCookie("monitor");
    if (!["colour", "green", "grayscale"].includes(val)) val = "colour";
    cocher(`input[type=radio][name=monitor][value=${val}]`);

    val = getCookie("audio");
    if (!["mono", "stereo"].includes(val)) val = "stereo";
    cocher(`input[type=radio][name=audio][value=${val}]`);

    val = getCookie("crtc");
    if (!["type0", "type1", "type2", "type3"].includes(val)) val = "type1";
    cocher(`input[type=radio][name=crtc][value=${val}]`);

    const floppy = document.querySelector("#floppy-option");
    const tape   = document.querySelector("#tape-option");
    const ram    = document.querySelector("#ram-option");
    if (floppy) floppy.checked = getCookie("floppy") === "true";
    if (tape)   tape.checked   = getCookie("tape")   === "true";
    if (ram)    ram.checked    = getCookie("ram")    === "true";
  },

  /**
   * Reads the current UI radio/checkbox state and configures all emulator
   * subsystems accordingly:
   *   - Brand ID (AWA / Schneider / Amstrad)
   *   - Firmware locale and ROM set
   *   - Monitor palette (colour / green phosphor / grayscale)
   *   - Audio mixing mode (mono / stereo)
   *   - CRTC type (0–3) via polymorphic dispatch
   *   - Drive B and tape recorder visibility
   *   - 512 KB RAM expansion flag
   */
  applyConfiguration() {
    const radio = (name) => document.querySelector(`input[type=radio][name=${name}]:checked`)?.value;
    const visible = (sel) => (document.querySelector(sel)?.getClientRects().length ?? 0) > 0;

    const brandMap = { awa: 4, schneider: 5, amstrad: 7 };
    const brand    = radio("brand");
    this.brandId   = brandMap[brand];
    if (this.brandId === undefined) alert("[Error] default case triggered in config_update()");

    const firmware = radio("firmware");
    if (["english", "french", "spanish"].includes(firmware)) {
      // Firmware active before the change.
      // Read before overwriting `this.language`, otherwise the comparison
      // would always be equal and the reload would never happen.
      const firmwareActif = this.language;
      this.language = firmware;
      CPC_INPUT.keyboard.setLayout(({ english: "US", french: "FR", spanish: "ES" })[firmware]);

      // Firmware change: write the cookie first, then reload the page so that
      // the JavaScript context is rebuilt from scratch.
      if (firmwareActif && firmwareActif !== firmware) {
        setCookie("firmware", firmware, 365);

        // Drop the ROM images cached by path so the new machine does not
        // start again with the previous ones.
        if (typeof window !== "undefined" && window.files) window.files = {};

        location.reload();
        return;
      }

      ROM_Manager.loadROMs();
    } else {
      alert("[Error] default case triggered in config_update()");
    }

    const paletteMap = {
      colour:    Video_Hardware.paletteColor,
      green:     Video_Hardware.paletteGreen,
      grayscale: Video_Hardware.paletteGray,
    };
    const monitor = radio("monitor");
    this.monitorPalette = paletteMap[monitor];
    if (!this.monitorPalette) alert("[Error] default case triggered in config_update()");
    this.updatePalette();

    const audioMap = { mono: Audio_Output.Mono, stereo: Audio_Output.Stereo };
    const audio    = radio("audio");
    this.audioOutputFunction = audioMap[audio];
    if (!this.audioOutputFunction) alert("[Error] default case triggered in config_update()");

    const crtcMap = {
      type0: CRTC_Type0, type1: CRTC_Type1,
      type2: CRTC_Type2, type3: CRTC_Type3,
    };
    const crtcType = radio("crtc");
    if (crtcMap[crtcType]) {
      CRTC_Manager.P(crtcMap[crtcType]);
    } else {
      alert("[Error] default case triggered in config_update()");
    }

    if (document.querySelector("#floppy-option")?.checked) {
      Floppy_Drive_B.ready = true;
      const b = document.querySelector("#fieldset-driveb");
      if (visible("#fieldset-drivea") && b) b.style.display = '';
    } else {
      Floppy_Drive_B.ready = false;
      const b = document.querySelector("#fieldset-driveb");
      if (b) b.style.display = 'none';
    }

    if (document.querySelector("#tape-option")?.checked) {
      Tape_Recorder.ready = true;
      const t = document.querySelector("#fieldset-tape");
      if (visible("#fieldset-drivea") && t) t.style.display = '';
    } else {
      document.querySelector("#tape-stop")?.click();
      Tape_Recorder.ready = false;
      const t = document.querySelector("#fieldset-tape");
      if (t) t.style.display = 'none';
    }

    this.ramExpansion = document.querySelector("#ram-option")?.checked ?? false;
    Memory_Manager.ramExpansion = this.ramExpansion;
    ROM_Manager.ramExpansion    = this.ramExpansion;
    this.updateMemoryConfig();
  },

  // ---------------------------------------------------------------------------
  // Palette & memory helpers
  // ---------------------------------------------------------------------------

  /**
   * Rebuilds the 32-entry hardware palette by mapping each logical colour index
   * through the active monitor filter (colour / green phosphor / grayscale).
   * Must be called whenever the monitor type or Gate Array palette changes.
   */
  updatePalette() {
    for (let i = 0; i < 32; i++) {
      Video_Hardware.hwPalette[i] =
        Config_Manager.monitorPalette[Palette_Colors.hwColorIndex[i]];
    }
  },

  /**
   * Resets the memory bank map to a state consistent with the current RAM
   * expansion setting, preventing out-of-range bank selects on standard CPC
   * models after the expansion is toggled off.
   */
  updateMemoryConfig() {
    if (!Memory_Manager.memoryBanks) {
      Memory_Manager.memoryBanks = new Int32Array(4);
    }

    if (!this.ramExpansion) {
      if (Machine_Type === 2 || Machine_Type === 4) {
        for (let i = 0; i <= 3; i++) {
          Memory_Manager.memoryBanks[i] &= 0x1FFFF;
        }
      } else {
        Memory_Manager.memoryBanks[0] = 0;
        Memory_Manager.memoryBanks[1] = 16384;
        Memory_Manager.memoryBanks[2] = 32768;
        Memory_Manager.memoryBanks[3] = 49152;
      }
    }
  },

  // ---------------------------------------------------------------------------
  // Volume
  // ---------------------------------------------------------------------------

  /**
   * Applies a volume level using a perceptual logarithmic curve (power of 2).
   * Raw slider position 0–100 maps to a gain of [0.0–1.0] where the midpoint
   * (50) gives 0.25 — roughly matching the ear's equal-loudness contour.
   * @param {number} rawValue - Slider position in the range [0, 100].
   */
  setVolume(rawValue) {
    let v = parseFloat(rawValue);
    if (isNaN(v)) v = 75;
    v = Math.max(0, Math.min(100, v));
    this.volume = Math.pow(v / 100, 2);
    if (typeof Audio_Output !== "undefined") Audio_Output.k = this.volume;
    const slider = document.getElementById("sound-volume");
    if (slider) slider.value = v;
  },

  /**
   * Attaches native HTML5 `input` and `change` listeners to the volume slider
   * element (#sound-volume). Safe to call before Audio_Output is initialised.
   */
  initVolumeSlider() {
    const slider = document.getElementById("sound-volume");
    if (!slider) return;
    slider.value = 75;
    const onSliderChange = () => {
      let v = parseFloat(slider.value);
      if (isNaN(v)) { v = 75; slider.value = 75; }
      Config_Manager.volume = Math.pow(v / 100, 2);
      if (typeof Audio_Output !== "undefined") Audio_Output.k = Config_Manager.volume;
    };
    slider.addEventListener("input",  onSliderChange);
    slider.addEventListener("change", onSliderChange);
  },

  // ---------------------------------------------------------------------------
  // FPS display
  // ---------------------------------------------------------------------------

  /**
   * Refreshes the FPS counter in the status bar.
   * Scheduled by `setInterval` at 1-second intervals (fpsUpdateTimer).
   * In turbo mode the display shows virtual FPS and percentage of nominal speed.
   */
  updateFps() {
    const elapsed = getElapsedTime();
    const fps     = Math.round(1000 * Video_Hardware.frameCounter / elapsed);     window.statusElement.innerHTML = Config_Manager.turboMode
      ? `⚡ TURBO @ ${fps} fps`
      : `Running @ ${fps} fps`;
    Video_Hardware.frameCounter = 0;
    startTimer();
  },
};
