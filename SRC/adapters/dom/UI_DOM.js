/**
 * @file UI_DOM.js
 * @module UI_Manager
 *
 * Single point of contact between the JS CPC emulator and the DOM / jQuery.
 *
 * All DOM interactions live here — no other emulator module touches the DOM
 * or jQuery directly, keeping core modules (AY38910, Memory, Display, …)
 * purely logical and reusable outside the browser.
 *
 * Responsibilities:
 *   - Per-subsystem UI updates (PSG, ROM, memory, debugger, …)
 *   - Canvas resize
 *   - Event binding for buttons, radios, and checkboxes
 *   - Settings panel management
 *   - Compatibility error display
 *   - FPS measurement and display
 *
 * Convention: all functions are either prefixed `UI_` or are methods of
 * the `UI_Manager` singleton object.
 */

"use strict";

// ---------------------------------------------------------------------------
// Shared DOM references — populated once in UI_Manager.init()
// ---------------------------------------------------------------------------
const UI_Manager = {

    /** @type {HTMLElement|null} Status bar element. */
    statusEl         : null,
    /** @type {HTMLElement|null} Drive A activity LED element. */
    driveLedA        : null,
    /** @type {HTMLElement|null} Drive B activity LED element. */
    driveLedB        : null,
    /** @type {HTMLElement|null} Tape counter display element. */
    tapeCounterEl    : null,
    /** @type {HTMLElement|null} Main emulator canvas element. */
    canvasEl         : null,

    // -------------------------------------------------------------------------
    // Initialisation
    // -------------------------------------------------------------------------

    /**
     * Queries and wires all required DOM elements.
     * Must be called inside `$(document).ready`, before `AppMain.reset()`.
     *
     * Also injects LED and counter references into the peripheral modules
     * so they can update the UI without importing jQuery themselves.
     *
     * @returns {void}
     */
    init() {
        this.statusEl      = document.getElementById("status");
        this.driveLedA     = document.getElementById("drivea-led");
        this.driveLedB     = document.getElementById("driveb-led");
        this.tapeCounterEl = document.getElementById("tape-counter");
        this.canvasEl      = document.getElementById("screen");

        Floppy_Drive_A.ledElement    = this.driveLedA;
        Floppy_Drive_B.ledElement    = this.driveLedB;
        Tape_Recorder.counterElement = this.tapeCounterEl;
    },

    // -------------------------------------------------------------------------
    // UI update — PSG
    // -------------------------------------------------------------------------

    /**
     * Refreshes all 16 PSG register display cells and highlights the
     * currently selected register index.
     *
     * @returns {void}
     */
    updatePSG() {
        const psg = PSG_Sound_AY38910;
        for (let i = 0; i <= 15; i++) {
            $(`#psg_r${i}`).text(toHex8(psg.Regs_Main[i])).removeClass("dasm-selected");
        }
        if (psg.Sel_Reg_Index <= 15) {
            $(`#psg_r${psg.Sel_Reg_Index}`).addClass("dasm-selected");
        }
    },

    // -------------------------------------------------------------------------
    // UI update — Memory / ROM
    // -------------------------------------------------------------------------

    /**
     * Refreshes the four memory bank mapping select elements.
     *
     * @returns {void}
     */
    updateMemoryMapping() {
        for (let i = 0; i <= 3; i++) {
            $(`#pal_mapping_${i}`).val(
                `Page ${Memory_Manager.Bank[i] >>> 16} / Bank ${(Memory_Manager.Bank[i] >>> 14) & 3}`
            );
        }
    },

    /**
     * Synchronises the lower/upper ROM enable checkboxes and the upper ROM
     * bank number display with the current ROM_Manager state.
     *
     * @returns {void}
     */
    updateRomStatus() {
        const rom = ROM_Manager;
        rom.lowerRomEnabled
            ? $("#gatearray_lr").attr("checked", "checked")
            : $("#gatearray_lr").removeAttr("checked");
        rom.upperRomEnabled
            ? $("#gatearray_ur").attr("checked", "checked")
            : $("#gatearray_ur").removeAttr("checked");
        $("#gatearray_ur_bank").text(toHex8(rom.selectedUpperRom));
    },

    // -------------------------------------------------------------------------
    // Canvas and resize
    // -------------------------------------------------------------------------

    /**
     * Resizes the canvas placeholder to fill the available window area
     * while preserving the CPC aspect ratio.
     *
     * @returns {void}
     */
    resizeCanvas() {
        const size = this.calculateCanvasSize();
        $("#screen-placeholder").width(size.width).height(size.height);
    },

    /**
     * Computes the largest canvas dimensions that fit inside the current
     * window while maintaining the CPC aspect ratio (≈ 1.36).
     *
     * Enforces a minimum size of 739.84 × 544 px.
     *
     * @returns {{ width: number, height: number }} Pixel dimensions to apply.
     */
    calculateCanvasSize() {
        const aw = window.innerWidth  - 22;
        const ah = window.innerHeight - 127;
        const RATIO = 1.36;
        const MIN_W = 739.84, MIN_H = 544;

        if (aw < MIN_W || ah < MIN_H) return { width: MIN_W, height: MIN_H };
        if (aw / ah < RATIO)          return { width: aw,     height: aw / RATIO };
        return                               { width: ah * RATIO, height: ah };
    },

    // -------------------------------------------------------------------------
    // Compatibility error display
    // -------------------------------------------------------------------------

    /**
     * Appends a single error message to the error log element.
     *
     * @param {string} message - Human-readable error description.
     * @returns {void}
     */
    showCompatError(message) {
        $("#error-log").append(`<p>${message}</p>`);
    },

    /**
     * Prepends a header to the error log and makes it visible.
     *
     * @param {string[]} errors - Array of compatibility error messages.
     * @returns {void}
     */
    showCompatErrors(errors) {
        $("#error-log")
            .prepend("<div>JS CPC won't work on this browser:</div><ul>")
            .append("</ul>")
            .show();
    },

    // -------------------------------------------------------------------------
    // FPS display
    // -------------------------------------------------------------------------

    /**
     * Updates the status bar with the current frames-per-second count.
     * Prefixes the label with a lightning bolt when turbo mode is active.
     *
     * @param {number}  fps       - Measured frame rate.
     * @param {boolean} turboMode - Whether the emulator is running in turbo mode.
     * @returns {void}
     */
    updateFps(fps, turboMode) {
        if (!this.statusEl) return;
        this.statusEl.innerHTML = turboMode
            ? `⚡ TURBO @ ${fps} fps`
            : `Running @ ${fps} fps`;
    },

    /**
     * Sets arbitrary text in the status bar.
     *
     * @param {string} text - Content to display (HTML allowed).
     * @returns {void}
     */
    setStatus(text) {
        if (this.statusEl) this.statusEl.innerHTML = text;
    },

    // -------------------------------------------------------------------------
    // Main button bindings
    // -------------------------------------------------------------------------

    /**
     * Attaches click handlers to the main emulator control buttons:
     * Run/Pause, Reset, Step, Step-Over, and Joystick toggle.
     *
     * @returns {void}
     */
    bindMainButtons() {
        $("#button-run").off("click").on("click", function () {
            if ($(this).hasClass("button")) Emulator_Core.resumeEmulator();
        });
        $("#button-reset").off("click").on("click", function () {
            if ($(this).hasClass("button")) Emulator_Core.hardReset();
        });
        $("#button-step").off("click").on("click", function () {
            if ($(this).hasClass("button")) { CPU_Z80.exec(); launch_debugger(); }
        });
        $("#button-stepover").off("click").on("click", function () {
            if ($(this).hasClass("button")) Emulator_Core.stepOver();
        });
        $("#checkbox-joystick").off("click").on("click", function () {
            Config_Manager.joystickEnabled = !Config_Manager.joystickEnabled;
            $(this).toggleClass("active");
        });
    },

    // -------------------------------------------------------------------------
    // Settings panel
    // -------------------------------------------------------------------------

    /**
     * Attaches open/close handlers to the settings panel overlay.
     * Opening pauses the emulator; closing saves and applies the configuration
     * before resuming.
     *
     * @returns {void}
     */
    bindSettingsPanel() {
        $("#checkbox-settings").off("click").on("click", () => {
            Emulator_Core.pauseEmulator();
            $("#option-panel-overlay, #option-panel").fadeIn(200);
        });
        $("#settings-close").off("click").on("click", () => {
            Config_Manager.saveConfiguration();
            Config_Manager.applyConfiguration();
            $("#option-panel-overlay, #option-panel").fadeOut(200);
            Emulator_Core.resumeEmulator();
        });
        $("#option-panel-overlay").off("click").on("click", () => {
            $("#option-panel-overlay, #option-panel").fadeOut(200);
            Emulator_Core.resumeEmulator();
        });
    },

    // -------------------------------------------------------------------------
    // Sound button
    // -------------------------------------------------------------------------

    /**
     * Reads the sound preference from the cookie, sets the initial icon state,
     * and attaches a click handler that toggles audio output on/off.
     *
     * @returns {void}
     */
    bindSoundButton() {
        const _soundCookie = getCookie("sound");
        Config_Manager.soundEnabled = (_soundCookie !== "false");

        if (Config_Manager.soundEnabled) {
            $("#checkbox-sound").addClass("active")
                .find("i").removeClass("fa-volume-mute").addClass("fa-volume-up");
        } else {
            $("#checkbox-sound").removeClass("active")
                .find("i").removeClass("fa-volume-up").addClass("fa-volume-mute");
        }

        $("#checkbox-sound").off("click").on("click", async function () {
            if (Config_Manager.soundEnabled) {
                Config_Manager.soundEnabled = false;
                setCookie("sound", false, 365);
                $(this).removeClass("active")
                    .find("i").removeClass("fa-volume-up").addClass("fa-volume-mute");
            } else {
                await Audio_Output.Resume();
                Config_Manager.soundEnabled = true;
                setCookie("sound", true, 365);
                $(this).addClass("active")
                    .find("i").removeClass("fa-volume-mute").addClass("fa-volume-up");
            }
        });
    },

    // -------------------------------------------------------------------------
    // Snapshot / machine selector
    // -------------------------------------------------------------------------

    /**
     * Binds the machine/snapshot selector dropdown.
     * On change, resolves the ROM file paths for the selected machine, loads
     * any missing ROMs via XHR, and triggers a hard reset.
     *
     * @returns {void}
     */
    bindSnapshotSelector() {
        $("#snapshot").val("none");
        $("#checkbox-debugger").removeAttr("checked");

        $("#snapshot").off("change").on("change", function () {
            $(this).blur();
            const val = $(this).val();
            if (!val || val === "none") return;

            const ROM_PATH = "ROM/";
            const lang = (typeof Config_Manager !== "undefined" && Config_Manager.language)
                ? Config_Manager.language
                : "english";

            const getFilesForMachine = (machineVal) => {
                const p = `${ROM_PATH}${lang}/`;
                if (machineVal === "boot_6128plus" || machineVal === "boot_464plus") {
                    return [`${ROM_PATH}CPC_PLUS.CPR`];
                }
                switch (machineVal) {
                    case "boot_cpc464":   return [`${p}464.ROM`,  `${p}BASIC1-0.ROM`, `${ROM_PATH}AMSDOS_0.5.ROM`];
                    case "boot_cpc664":   return [`${p}664.ROM`,  `${p}BASIC1-1.ROM`, `${ROM_PATH}AMSDOS_0.5.ROM`];
                    case "boot_cpc6128":  return [`${p}6128.ROM`, `${p}BASIC1-1.ROM`, `${ROM_PATH}AMSDOS_0.5.ROM`];
                    case "boot_6128plus": return [`${p}6128P.ROM`,`${p}BASIC1-1.ROM`, `${ROM_PATH}AMSDOS_0.7.ROM`];
                    default:              return [];
                }
            };

            const filesToLoad = getFilesForMachine(val);

            if (filesToLoad.every((p) => window.files?.[p])) {
                Emulator_Core.hardReset();
                return;
            }

            window.files = window.files || {};
            let loadedCount = 0;

            filesToLoad.forEach((path) => {
                const req = new XMLHttpRequest();
                req.open("GET", path, true);
                req.responseType = "arraybuffer";
                req.onload = () => {
                    if (req.status === 200 || req.status === 0) {
                        window.files[path] = new Uint8Array(req.response);
                    }
                    if (++loadedCount >= filesToLoad.length) {
                        Emulator_Core.hardReset();
                    }
                };
                req.send();
            });
        });
    },

    // -------------------------------------------------------------------------
    // Miscellaneous helpers
    // -------------------------------------------------------------------------

    /**
     * Prevents form controls (buttons, radios, checkboxes) from retaining
     * visible focus after interaction, keeping keyboard input clean for the
     * emulator.
     *
     * @returns {void}
     */
    blurFormControls() {
        $(":button, :radio, :submit, :checkbox").on("focus", function () {
            $(this).blur();
        });
    },

    /**
     * Shows or hides peripheral panels (drive B, tape) based on the current
     * option checkboxes.
     *
     * @returns {void}
     */
    updateDrivePanels() {
        $("#fieldset-drivea").show();
        if ($("#floppy-option").is(":checked")) $("#fieldset-driveb").show();
        if ($("#tape-option").is(":checked"))   $("#fieldset-tape").show();
    },

    /**
     * Toggles the cartridge panel visibility based on the active machine type.
     *
     * @param {boolean} show - `true` to reveal the panel, `false` to hide it.
     * @returns {void}
     */
    toggleCartPanel(show) {
        $("#fieldset-cart").toggle(show);
    },

    /**
     * Makes the emulator canvas visible and hides the splash logo.
     *
     * @returns {void}
     */
    showEmulatorScreen() {
        $("#screen").show();
        $("#logo, #browser-nfo").hide();
    },

    /**
     * Updates Run/Pause, Step, and Step-Over button states to reflect
     * whether the emulator is currently running or paused.
     *
     * @param {boolean} running - `true` if the emulator is actively running.
     * @returns {void}
     */
    setRunningState(running) {
        if (running) {
            $("#button-step, #button-stepover")
                .removeClass("button").addClass("disabled-button");
            $("#button-run")
                .html('<span class="guifx2">2 </span>Pause')
                .off("click")
                .on("click", function () {
                    if ($(this).hasClass("button")) Emulator_Core.pauseEmulator();
                });
            $("#button-run, #button-reset").removeClass("disabled-button").addClass("button");
        } else {
            $("#button-run")
                .html('<span class="guifx2">d </span> Resume')
                .off("click")
                .on("click", function () {
                    if ($(this).hasClass("button")) Emulator_Core.resumeEmulator();
                });
            $("#button-run, #button-reset, #button-step, #button-stepover")
                .removeClass("disabled-button").addClass("button");
        }
    },

    // -------------------------------------------------------------------------
    // Cookie-based configuration persistence
    // -------------------------------------------------------------------------

    /**
     * Reads the current UI control values and persists them as cookies
     * (1-year expiry).
     *
     * @returns {void}
     */
    saveConfigToCookies() {
        const radio = (name) => $(`input:radio[name=${name}]:checked`).val();
        setCookie("brand",    radio("brand"),    365);
        setCookie("firmware", radio("firmware"), 365);
        setCookie("monitor",  radio("monitor"),  365);
        setCookie("audio",    radio("audio"),    365);
        setCookie("crtc",     radio("crtc"),     365);
        setCookie("floppy",   $("#floppy-option").is(":checked"), 365);
        setCookie("tape",     $("#tape-option").is(":checked"),   365);
        setCookie("ram",      $("#ram-option").is(":checked"),    365);
        setCookie("sound",    Config_Manager.soundEnabled,         365);
    },

    /**
     * Restores the emulator configuration from cookies and updates the
     * corresponding radio buttons and checkboxes.
     *
     * Falls back to sane defaults when a cookie value is missing or invalid.
     *
     * @returns {void}
     */
    loadConfigFromCookies() {
        let val;

        val = getCookie("brand");
        if (!["awa", "schneider", "amstrad"].includes(val)) val = "amstrad";
        $(`input:radio[name=brand][value=${val}]`).attr("checked", true);

        val = getCookie("firmware");
        if (!["english", "french", "spanish"].includes(val)) val = "spanish";
        $(`input:radio[name=firmware][value=${val}]`).attr("checked", true);

        val = getCookie("monitor");
        if (!["colour", "green", "grayscale"].includes(val)) val = "colour";
        $(`input:radio[name=monitor][value=${val}]`).attr("checked", true);

        val = getCookie("audio");
        if (!["mono", "stereo"].includes(val)) val = "stereo";
        $(`input:radio[name=audio][value=${val}]`).attr("checked", true);

        val = getCookie("crtc");
        if (!["type0", "type1", "type2", "type3"].includes(val)) val = "type1";
        $(`input:radio[name=crtc][value=${val}]`).attr("checked", true);

        $("#floppy-option").attr("checked", getCookie("floppy") === "true");
        $("#tape-option")  .attr("checked", getCookie("tape")   === "true");
        $("#ram-option")   .attr("checked", getCookie("ram")    === "true");
    },

    /**
     * Reads the current state of all configuration controls and returns it
     * as a plain object.
     *
     * @returns {{ brand: string, firmware: string, monitor: string,
     *             audio: string, crtcType: string, floppyB: boolean,
     *             tape: boolean, ram: boolean }} Current UI configuration.
     */
    readConfigFromUI() {
        return {
            brand    : $("input:radio[name=brand]:checked").val(),
            firmware : $("input:radio[name=firmware]:checked").val(),
            monitor  : $("input:radio[name=monitor]:checked").val(),
            audio    : $("input:radio[name=audio]:checked").val(),
            crtcType : $("input:radio[name=crtc]:checked").val(),
            floppyB  : $("#floppy-option").is(":checked"),
            tape     : $("#tape-option").is(":checked"),
            ram      : $("#ram-option").is(":checked"),
        };
    },

    /**
     * Shows or hides the drive B and tape panels according to the provided
     * configuration, and updates the corresponding peripheral ready flags.
     *
     * @param {{ floppyB: boolean, tape: boolean }} cfg - Subset of the UI config.
     * @returns {void}
     */
    applyDriveVisibility(cfg) {
        if (cfg.floppyB) {
            Floppy_Drive_B.ready = true;
            if ($("#fieldset-drivea").is(":visible")) $("#fieldset-driveb").show();
        } else {
            Floppy_Drive_B.ready = false;
            $("#fieldset-driveb").hide();
        }

        if (cfg.tape) {
            Tape_Recorder.ready = true;
            if ($("#fieldset-drivea").is(":visible")) $("#fieldset-tape").show();
        } else {
            $("#tape-stop").click();
            Tape_Recorder.ready = false;
            $("#fieldset-tape").hide();
        }
    },

    /**
     * Forces the CRTC type radio button selection to match the active machine type.
     * CPC 664 (type 2) → CRTC type 1; CPC Plus / GX4000 (type ≥ 4) → CRTC type 3.
     *
     * @param {number} machineType - Numeric machine type identifier.
     * @returns {void}
     */
    forceCrtcRadio(machineType) {
        if (machineType === 2) {
            $("input:radio[name=crtc][value=type1]").prop("checked", true);
        } else if (machineType >= 4) {
            $("input:radio[name=crtc][value=type3]").prop("checked", true);
        }
    },

    // -------------------------------------------------------------------------
    // Floppy drive bindings
    // -------------------------------------------------------------------------

    /**
     * Wires all DOM events for floppy drives A and B:
     * file input change, eject button, and new blank disk button.
     *
     * @returns {void}
     */
    bindFloppyDrives() {
        window.files = window.files || {};

        $('#drivea-input').on('change', function (e) {
            handleDiskUpload(e.target.files[0], Floppy_Drive_A, 'drivea-filename', 'drivea-eject', 'drivea-programs');
        });

        $('#drivea-eject').on('click', function () {
            if (Floppy_Drive_A.isDirty) {
                if (confirm("La disquette a été modifiée. Voulez-vous la sauvegarder avant l'éjection ?")) {
                    downloadDisk(Floppy_Drive_A);
                }
            }
            Floppy_Drive_A.diskImage = null;
            Floppy_Drive_A.isDirty   = false;
            $('#drivea-filename').text('Vide');
            $('#drivea-programs').hide().empty();
            $(this).removeClass('button').addClass('disabled-button');
            $('#drivea-input').val('');
        });

        $('#drivea-new').off('click').on('click', function () {
            mountBlankDSK(Floppy_Drive_A, 'drivea-filename', 'drivea-eject');
        });

        $('#driveb-input').on('change', function (e) {
            handleDiskUpload(e.target.files[0], Floppy_Drive_B, 'driveb-filename', 'driveb-eject', 'driveb-programs');
        });

        $('#driveb-eject').on('click', function () {
            if (Floppy_Drive_B.isDirty) {
                if (confirm("La disquette a été modifiée. Voulez-vous la sauvegarder avant l'éjection ?")) {
                    downloadDisk(Floppy_Drive_B);
                }
            }
            Floppy_Drive_B.diskImage = null;
            Floppy_Drive_B.isDirty   = false;
            $('#driveb-filename').text('Vide');
            $('#driveb-programs').hide().empty();
            $(this).removeClass('button').addClass('disabled-button');
            $('#driveb-input').val('');
        });

        $('#driveb-new').off('click').on('click', function () {
            mountBlankDSK(Floppy_Drive_B, 'driveb-filename', 'driveb-eject');
        });
    },

    // -------------------------------------------------------------------------
    // Tape bindings
    // -------------------------------------------------------------------------

    /**
     * Wires DOM events for the tape deck: file load, new blank tape, and save.
     *
     * @returns {void}
     */
    bindTape() {
        $('#tape-input').off('change').on('change', function () {
            const file = this.files[0];
            if (!file) return;
            if (typeof Tape_Recorder === 'undefined' || typeof TapeController === 'undefined') return;
            const reader = new FileReader();
            reader.onload = function (e) {
                const data = new Uint8Array(e.target.result);
                const parsed = WAV_Parser.parseFile(data);
                if (!parsed) return;
                TapeController.ejectTape();
                Tape_Recorder.diskImage = parsed;
                $('#tape-filename').text(file.name);
                $('#tape-eject').removeClass('disabled-button').addClass('button');
                TapeController.setTapeState(TapeController.STATE_STOP);
                analyzeTape(Tape_Recorder.diskImage);
            };
            reader.readAsArrayBuffer(file);
        });

        $('#tape-eject').off('click').on('click', function () {
            if ($(this).hasClass('disabled-button')) return;
            if (typeof TapeController === 'undefined') return;
            TapeController.ejectTape();
            Tape_Recorder.diskImage = null;
            $('#tape-filename').text('Aucune cassette');
            $('#tape-input').val('');
            $(this).removeClass('button').addClass('disabled-button');
        });

        $('#tape-new').off('click').on('click', function () {
            if (typeof WAV_Parser === 'undefined' || typeof TapeController === 'undefined') return;
            TapeController.ejectTape();
            Tape_Recorder.diskImage = WAV_Parser.createBlankTape(90);
            $('#tape-filename').text('Cassette Vierge (90 min)');
            $('#tape-eject').removeClass('disabled-button').addClass('button');
            TapeController.setTapeState(TapeController.STATE_STOP);
        });

        $('#tape-save').off('click').on('click', function () {
            if (typeof Tape_Recorder !== 'undefined' && Tape_Recorder.diskImage) {
                downloadTapeAsWav(Tape_Recorder.diskImage);
            }
        });
    },

    // -------------------------------------------------------------------------
    // Keyboard / AutoType bindings
    // -------------------------------------------------------------------------

    /**
     * Wires the AutoType send and clear buttons.
     *
     * @returns {void}
     */
    bindKeyboard() {
        $('#autotype-send').off('click').on('click', function () {
            const code = $('#autotype-area').val();
            if (!code) return;
            AutoType.inject(code + '\r');
        });

        $('#autotype-clear').on('click', function () {
            AutoType.cancel();
            $('#autotype-area').val('');
        });
    },

    // -------------------------------------------------------------------------
    // Snapshot bindings
    // -------------------------------------------------------------------------

    /**
     * Wires the snapshot capture, load (including ZIP multi-entry handling),
     * ZIP entry selector, and eject buttons.
     *
     * @returns {void}
     */
    bindSnapshot() {
        $('#snapshot-capture').off('click').on('click', function () {
            Snapshot_Manager.takeSnapshot();
        });

        $('#snapshot-input').off('change').on('change', function (e) {
            const file = e.target.files[0];
            if (!file) return;

            $('#snapshot-filename').text(file.name);
            $('#snapshot-eject').removeClass('disabled-button');

            if (file.name.toLowerCase().endsWith('.zip')) {
                Snapshot_Manager.extractZipEntries(file, snaFiles => {
                    if (!snaFiles || snaFiles.length === 0) {
                        $('#snapshot-filename').text('Aucun snapshot');
                        $('#snapshot-eject').addClass('disabled-button');
                        return;
                    }
                    Snapshot_Manager.currentZipEntries = snaFiles;
                    if (snaFiles.length > 1) {
                        const $select = $('#snapshot-zipselect').empty();
                        snaFiles.forEach(f => $select.append($('<option>', { value: f.name, text: f.name })));
                        $select.show();
                        Snapshot_Manager.loadFromZipEntry(snaFiles[0].entry);
                    } else {
                        $('#snapshot-zipselect').hide();
                        Snapshot_Manager.loadFromZipEntry(snaFiles[0].entry);
                    }
                });
            } else {
                $('#snapshot-zipselect').hide();
                const reader = new FileReader();
                reader.onload = event => Snapshot_Manager.loadSnapshot(event.target.result);
                reader.readAsArrayBuffer(file);
            }
        });

        $('#snapshot-zipselect').off('change').on('change', function () {
            const selectedName = $(this).val();
            const found = Snapshot_Manager.currentZipEntries &&
                Snapshot_Manager.currentZipEntries.find(f => f.name === selectedName);
            if (found) {
                Snapshot_Manager.loadFromZipEntry(found.entry);
                $('#snapshot-filename').text(selectedName);
            }
        });

        $('#snapshot-eject').off('click').on('click', function () {
            if ($(this).hasClass('disabled-button')) return;
            $('#snapshot-filename').text('Aucun snapshot');
            $('#snapshot-input').val('');
            $('#snapshot-zipselect').hide().empty();
            $(this).addClass('disabled-button');
            Snapshot_Manager.ejectSnapshot();
            if (typeof Emulator_Core !== 'undefined') {
                Emulator_Core.pauseEmulator();
            }
        });
    },

    // -------------------------------------------------------------------------
    // Cartridge bindings
    // -------------------------------------------------------------------------

    /**
     * Wires the cartridge file input and eject button.
     * Loading a new cartridge file triggers a hard reset automatically.
     *
     * @returns {void}
     */
    bindCartridge() {
        $('#cart-input').on('change', function (e) {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = function (event) {
                const data = new Uint8Array(event.target.result);
                window.currentCprPath = `USER/${file.name}`;
                window.files          = window.files || {};
                window.files[window.currentCprPath] = data;
                $('#cart-filename').text(file.name);
                $('#cart-eject').removeClass('disabled-button').addClass('button');
                Emulator_Core.hardReset();
            };
            reader.readAsArrayBuffer(file);
        });

        $('#cart-eject').on('click', function () {
            if ($(this).hasClass('disabled-button')) return;
            window.currentCprPath = null;
            $('#cart-filename').text('Aucune cartouche');
            $(this).removeClass('button').addClass('disabled-button');
            $('#cart-input').val('');
            Emulator_Core.hardReset();
        });
    },

    // -------------------------------------------------------------------------
    // Virtual printer bindings
    // -------------------------------------------------------------------------

    /**
     * Wires the virtual printer clear and output toggle buttons.
     *
     * @returns {void}
     */
    bindPrinter() {
        $('#printer-clear').on('click', function () {
            if (typeof VirtualPrinter !== 'undefined') VirtualPrinter.clear();
        });

        $('#printer-toggle').on('click', function () {
            const $output = $('#printer-output');
            const $icon   = $(this).find('i');
            if ($output.is(':visible')) {
                $output.slideUp(150);
                $icon.removeClass('fa-chevron-up').addClass('fa-chevron-down');
            } else {
                $output.slideDown(150);
                $icon.removeClass('fa-chevron-down').addClass('fa-chevron-up');
            }
        });
    },

    // -------------------------------------------------------------------------
    // Turbo button
    // -------------------------------------------------------------------------

    /**
     * Wires the turbo toggle button. Enabling turbo mode also mutes the sound
     * to avoid audio artefacts at above-normal emulation speed.
     *
     * @returns {void}
     */
    bindTurboButton() {
        $('#button-turbo').off('click').on('click', function () {
            if (typeof toggleTurbo === 'undefined') return;
            toggleTurbo();
            if (Config_Manager.turboMode) {
                $(this).addClass('turbo-on');
                if (Config_Manager.soundEnabled) {
                    Config_Manager.soundEnabled = false;
                    if (typeof setCookie === 'function') setCookie('sound', false, 365);
                    $('#checkbox-sound')
                        .removeClass('active')
                        .find('i').removeClass('fa-volume-up').addClass('fa-volume-mute');
                }
            } else {
                $(this).removeClass('turbo-on');
            }
        });
    },

    // -------------------------------------------------------------------------
    // Fullscreen binding
    // -------------------------------------------------------------------------

    /**
     * Wires the fullscreen toggle button with cross-browser prefixed API support.
     * Updates the button icon to reflect the current fullscreen state.
     *
     * @returns {void}
     */
    bindFullscreen() {
        $('#checkbox-fullscreen').off('click').on('click', function () {
            const isFullscreen = document.fullscreenElement      ||
                               document.mozFullScreenElement   ||
                               document.webkitFullscreenElement;
            if (isFullscreen) {
                const exitFn = document.exitFullscreen ||
                             document.mozCancelFullScreen ||
                             document.webkitExitFullscreen;
                if (exitFn) exitFn.call(document);
                $(this).find('i').removeClass('fa-compress').addClass('fa-expand');
            } else {
                const el    = document.getElementById('emulator-area');
                const reqFn = el.requestFullscreen ||
                            el.mozRequestFullScreen ||
                            el.webkitRequestFullscreen;
                if (reqFn) {
                    const p = reqFn.call(el);
                    if (p && p.catch) p.catch(function (e) {
                        console.warn('[Fullscreen] Failed:', e.message);
                    });
                    $(this).find('i').removeClass('fa-expand').addClass('fa-compress');
                }
            }
        });
    },

    // -------------------------------------------------------------------------
    // Game page header bindings
    // -------------------------------------------------------------------------

    /**
     * Wires the game-page header controls: volume slider, joystick toggle,
     * sound toggle, and fullscreen button.
     *
     * Also synchronises the header fullscreen button with the settings panel
     * fullscreen checkbox so both controls stay in step.
     *
     * @returns {void}
     */
    bindGameHeader() {
        $('#volume-slider-ui').on('input', function () {
            const val = parseInt(this.value, 10);
            $('#sound-volume').val(val).trigger('input');
            if (typeof Config_Manager !== 'undefined' && typeof Config_Manager.setVolume === 'function') {
                Config_Manager.setVolume(val / 100);
            }
        });

        var _joystickOn = true;
        $('#btn-joystick').on('click', function () {
            _joystickOn = !_joystickOn;
            if (typeof Config_Manager !== 'undefined') Config_Manager.joystickEnabled = _joystickOn;
            if (_joystickOn) {
                $('#checkbox-joystick').addClass('active');
                $(this).removeClass('disabled').attr('title', 'Joystick clavier (actif)');
            } else {
                $('#checkbox-joystick').removeClass('active');
                $(this).addClass('disabled').attr('title', 'Joystick clavier (désactivé)');
            }
        });

        var _soundOn = true;
        $('#btn-sound').on('click', function () {
            _soundOn = !_soundOn;
            if (typeof Config_Manager !== 'undefined') Config_Manager.soundEnabled = _soundOn;
            const $btn = $(this);
            if (_soundOn) {
                $btn.removeClass('muted').find('i').removeClass('fa-volume-mute').addClass('fa-volume-up');
                if (typeof Audio_Output !== 'undefined') Audio_Output.Resume().catch(function () {});
                $('#checkbox-sound').addClass('active').find('i').removeClass('fa-volume-mute').addClass('fa-volume-up');
            } else {
                $btn.addClass('muted').find('i').removeClass('fa-volume-up').addClass('fa-volume-mute');
                $('#checkbox-sound').removeClass('active').find('i').removeClass('fa-volume-up').addClass('fa-volume-mute');
            }
        });

        $('#btn-fullscreen').on('click', function () {
            const el  = document.getElementById('emulator-area');
            const isF = document.fullscreenElement || document.webkitFullscreenElement;
            if (isF) {
                (document.exitFullscreen || document.webkitExitFullscreen).call(document);
                $(this).find('i').removeClass('fa-compress').addClass('fa-expand');
            } else {
                const reqFn = el.requestFullscreen || el.webkitRequestFullscreen;
                if (reqFn) reqFn.call(el).catch(function (e) { console.warn('[Fullscreen]', e.message); });
                $(this).find('i').removeClass('fa-expand').addClass('fa-compress');
            }
        });

        $('#checkbox-fullscreen').off('click').on('click', function () {
            $('#btn-fullscreen').trigger('click');
        });
    },

    // -------------------------------------------------------------------------
    // Tape transport bindings (first mount)
    // -------------------------------------------------------------------------

    /**
     * Wires the tape transport buttons (Play, Record, Rewind, Fast-Forward, Stop)
     * the first time a tape is inserted.
     *
     * Each button checks the current tape position before changing state to
     * avoid requesting an action at a boundary (e.g. play past end-of-tape).
     *
     * Called from `TapeController.setTapeState()` on the STATE_EMPTY → STATE_STOP
     * transition.
     *
     * @param {Object} TC   - TapeController singleton.
     * @param {Object} disk - The currently loaded `Tape_Recorder.diskImage`.
     * @returns {void}
     */
    bindTapeTransport(TC, disk) {
        $("#tape-record").on("click", () => {
            TC.setTapeState(TC.tapePosition < disk.size - 1 ? TC.STATE_RECORD : TC.STATE_STOP);
        });
        $("#tape-play").on("click", () => {
            TC.setTapeState(TC.tapePosition < disk.size - 1 ? TC.STATE_PLAY : TC.STATE_STOP);
        });
        $("#tape-rewind").on("click", () => {
            TC.setTapeState(TC.tapePosition > 0 ? TC.STATE_REWIND : TC.STATE_STOP);
        });
        $("#tape-forward").on("click", () => {
            TC.setTapeState(TC.tapePosition < disk.size - 1 ? TC.STATE_FORWARD : TC.STATE_STOP);
        });
        $("#tape-stop").on("click", () => {
            TC.setTapeState(TC.STATE_STOP);
        });
    },

    // -------------------------------------------------------------------------
    // Audio context resume on first user gesture
    // -------------------------------------------------------------------------

    /**
     * Resumes the Web Audio context on the first user interaction event.
     *
     * ⚠ Do NOT call this method alongside `bindSoundButton()` on the same page.
     * Both methods call `Audio_Output.Resume()`, which could create a race
     * condition resulting in a duplicate AudioContext and an unregistered
     * AudioWorklet.
     *
     * Use only on pages that have no sound button managed by `bindSoundButton()`,
     * and only when audio should start automatically on the first user gesture.
     *
     * @param {string} [events='click'] - jQuery event string (e.g. `'click keydown'`).
     * @returns {void}
     */
    bindAudioResume(events) {
        $(document).one(events || 'click', async function () {
            if (typeof Audio_Output === 'undefined') return;
            if (typeof Config_Manager !== 'undefined' && !Config_Manager.soundEnabled) return;
            if (Audio_Output.isInitialized) {
                if (Audio_Output.audioContext?.state === 'suspended') {
                    try { await Audio_Output.audioContext.resume(); } catch (e) { /* silent */ }
                }
                return;
            }
            try { await Audio_Output.Resume(); } catch (e) { /* silent */ }
        });
    },
};
