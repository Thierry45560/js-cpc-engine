/**
 * @file UI_DOM.js
 * @module UI_Manager
 *
 * Single point of contact between the JS CPC emulator and the DOM.
 *
 * All DOM interactions live here — no other emulator module touches the DOM
 * directly, keeping core modules (AY38910, Memory, Display, …) purely logical
 * and reusable outside the browser.
 *
 * Migration jQuery → DOM natif (2026-10) : ce fichier ne dépend plus de
 * jQuery. Conventions :
 *   - `document.querySelector` / `querySelectorAll` pour les sélecteurs ;
 *   - `?` (chaînage optionnel) partout où jQuery était tolérant au `null`
 *     (`$('#absent').text(x)` ne faisait rien, pas de SelectorError) ;
 *   - `addEventListener` pour les événements, avec suppression explicite de
 *     l'ancien écouteur quand le code rebindait le même élément ;
 *   - `classList` pour les classes, `textContent` pour le texte ;
 *   - Web Animations API (`element.animate`) pour les apparitions.
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
// Helpers DOM — équivalent natif des rares usages jQuery sans équivalent direct
// ---------------------------------------------------------------------------

/**
 * Affiche ou masque une collection d'éléments avec une transition d'opacité.
 * Remplace `$(sel).fadeIn(ms)` / `$(sel).fadeOut(ms)`.
 *
 * Deux différences de comportement avec jQuery, corrigées ici :
 *
 * 1. **jQuery annulait l'animation en cours** avant d'en lancer une autre.
 *    La Web Animations API, elle, **compose** les animations : un `fadeIn`
 *    suivi d'un `fadeOut` 50 ms plus tard laisse les deux vivantes, et avec
 *    `fill: 'forwards'` la première continue de pousser l'opacité vers 1 après
 *    que la seconde a fini. On annule donc explicitement — c'est l'équivalent
 *    du `stop(true)` implicite de `.fadeOut()` sous jQuery.
 * 2. `.fadeOut()` sur un élément déjà masqué ne faisait rien. Même règle ici,
 *    ce qui évite une animation invisible dont le `onfinish` referait un
 *    `display: 'none'` sans raison.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * L'ÉTAT EST LU SUR LE STYLE CALCULÉ, PAS SUR LE STYLE INLINE
 * ─────────────────────────────────────────────────────────────────────────────
 * La feuille de style masque déjà les modales (`.modal { display: none }`), et
 * ce `display: none` n'est jamais repris en ligne par le script. Lire
 * `noeud.style.display` revenait donc à lire une chaîne VIDE, jamais
 * renseignée : la modale passait pour déjà visible, `animer()` sortait
 * aussitôt, et le bouton « Configuration » ne faisait que mettre le Z80 en
 * pause sans jamais afficher la fenêtre.
 *
 * `getComputedStyle()` tient compte de toute la cascade, feuille de style
 * comprise, et voit donc la modale correctement masquée. En revanche, vider le
 * style inline ne suffit plus à la faire apparaître face à un `display: none`
 * de la feuille : il faut poser explicitement le display à rétablir.
 *
 */
const DISPLAY_PAR_TAG = new Map([
    ['SPAN', 'inline'], ['A', 'inline'], ['B', 'inline'], ['I', 'inline'],
    ['EM', 'inline'], ['STRONG', 'inline'], ['LABEL', 'inline'],
    ['BUTTON', 'inline-block'], ['IMG', 'inline-block'], ['INPUT', 'inline-block'],
]);

/**
 * Display à poser pour rendre un élément visible, trié par type de balise.
 *
 * Utile lorsqu'un `display: none` vient de la FEUILLE DE STYLE : vider le
 * style inline ne la neutralise pas, il faut donc imposer une valeur qui
 * l'emporte sur elle. `'block'` convient à tous les conteneurs, qui sont le
 * cas visé ici (les modales et la sortie imprimante).
 *
 * @param {HTMLElement} noeud Élément à rendre visible.
 * @returns {string} Valeur de `display` à écrire en style inline.
 */
function displayInitial(noeud) {
    return DISPLAY_PAR_TAG.get(noeud.tagName) || 'block';
}

/**
 * @param {string} selecteur Sélecteur CSS (peut cibler plusieurs éléments).
 * @param {boolean} afficher `true` pour apparaître, `false` pour disparaître.
 * @param {number} ms Durée de la transition, en millisecondes.
 * @returns {void}
 */
function animer(selecteur, afficher, ms) {
    document.querySelectorAll(selecteur).forEach((noeud) => {
        for (const precedente of noeud.getAnimations()) precedente.cancel();

        // Le style calculé, et non `style.display` : c'est la seule source qui
        // voie un `display: none` posé par la feuille de style.
        const dejaVisible = getComputedStyle(noeud).display !== 'none';
        if (afficher === dejaVisible) return;   // déjà dans l'état demandé

        // Pour apparaître, l'élément doit être rendu *avant* d'animer, sinon la
        // transition part d'un élément non affiché (donc sans dimension).
        // Vider le style inline ne suffit pas face à un masquage CSS : on pose
        // donc le display correspondant au type d'élément, ce qui prend le
        // dessus sur la feuille de style.
        if (afficher) noeud.style.display = displayInitial(noeud);
        const cible = afficher
            ? [{ opacity: 0 }, { opacity: 1 }]
            : [{ opacity: 1 }, { opacity: 0 }];
        const anim = noeud.animate(cible, { duration: ms, fill: 'forwards' });
        if (!afficher) anim.onfinish = () => { noeud.style.display = 'none'; };
    });
}

/**
 * Registre des écouteurs posés par ce module : permet de les **retirer**,
 * ce que `$().off()` faisait et que `addEventListener` ne permet pas
 * (il faut posséder la référence de la fonction). Les pages qui veulent
 * neutraliser un bouton générique appellent `UI_Manager.detach(selecteur)`.
 *
 * @type {WeakMap<EventTarget, Map<string, Function>>}
 */
const _ecouteursUI = new WeakMap();

/**
 * Branche un écouteur en fluvial : l'éventuel écouteur précédent du même
 * type sur la même cible est retiré d'abord (équivalent de
 * `$(sel).off(ev).on(ev, fn)`).
 *
 * @param {EventTarget} cible Élément, `document` ou `window`.
 * @param {string} type Nom de l'événement, sans le préfixe `on`.
 * @param {Function} fn L'écouteur à (re)brancher.
 * @returns {void}
 */
function brancher(cible, type, fn) {
    if (!cible) return;
    let table = _ecouteursUI.get(cible);
    if (!table) { table = new Map(); _ecouteursUI.set(cible, table); }
    const ancien = table.get(type);
    if (ancien) cible.removeEventListener(type, ancien);
    table.set(type, fn);
    cible.addEventListener(type, fn);
}

/**
 * Retire tous les écouteurs posés par `brancher()` sur une cible.
 *
 * @param {EventTarget} cible Élément, `document` ou `window`.
 * @returns {void}
 */
function detacher(cible) {
    const table = _ecouteursUI.get(cible);
    if (!table) return;
    for (const [type, fn] of table) cible.removeEventListener(type, fn);
    table.clear();
}

/**
 * Bascule la classe d'icône d'un bouton (enfant `<i>` de type Font Awesome).
 *
 * @param {Element|null} bouton Bouton à traiter.
 * @param {string} ancien Classe à retirer.
 * @param {string} nouveau Classe à poser.
 * @returns {void}
 */
function basculerIcone(bouton, ancien, nouveau) {
    const icone = bouton?.querySelector('i');
    if (!icone) return;
    icone.classList.remove(ancien);
    icone.classList.add(nouveau);
}

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
     * Must be called once the DOM is ready, before `AppMain.reset()`.
     *
     * Also injects LED and counter references into the peripheral modules
     * so they can update the UI without touching the DOM themselves.
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
            const cellule = document.querySelector(`#psg_r${i}`);
            if (!cellule) continue;
            cellule.textContent = toHex8(psg.Regs_Main[i]);
            cellule.classList.remove("dasm-selected");
        }
        if (psg.Sel_Reg_Index <= 15) {
            document.querySelector(`#psg_r${psg.Sel_Reg_Index}`)?.classList.add("dasm-selected");
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
            const select = document.querySelector(`#pal_mapping_${i}`);
            if (!select) continue;
            select.value =
                `Page ${Memory_Manager.Bank[i] >>> 16} / Bank ${(Memory_Manager.Bank[i] >>> 14) & 3}`;
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
        // `.checked` (propriété) plutôt que l'attribut : c'est l'état réel
        // d'une case à cocher, et il reste correct après une interaction.
        const lr = document.querySelector("#gatearray_lr");
        const ur = document.querySelector("#gatearray_ur");
        if (lr) lr.checked = rom.lowerRomEnabled;
        if (ur) ur.checked = rom.upperRomEnabled;
        const banque = document.querySelector("#gatearray_ur_bank");
        if (banque) banque.textContent = toHex8(rom.selectedUpperRom);
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
        const cadre = document.querySelector("#screen-placeholder");
        if (!cadre) return;
        cadre.style.width  = size.width + 'px';
        cadre.style.height = size.height + 'px';
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
        document.querySelector("#error-log")?.insertAdjacentHTML("beforeend", `<p>${message}</p>`);
    },

    /**
     * Prepends a header to the error log and makes it visible.
     *
     * @param {string[]} errors - Array of compatibility error messages.
     * @returns {void}
     */
    showCompatErrors(errors) {
        const journal = document.querySelector("#error-log");
        if (!journal) return;
        journal.insertAdjacentHTML(
            "afterbegin",
            "<div>JS CPC won't work on this browser:</div><ul>"
        );
        journal.insertAdjacentHTML("beforeend", "</ul>");
        journal.style.display = '';
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
        const clicSiActif = (selecteur, action) => {
            const bouton = document.querySelector(selecteur);
            if (!bouton) return;
            brancher(bouton, 'click', function () {
                if (this.classList.contains("button")) action();
            });
        };
        brancher(document.querySelector('#button-run'), 'click', function () {
            if (this.classList.contains('button')) {
                if (Emulator_Core.isPaused) {
                    Emulator_Core.resumeEmulator();
                } else {
                    Emulator_Core.pauseEmulator();
                }
            }
        });
        clicSiActif("#button-reset",   () => Emulator_Core.hardReset());
        clicSiActif("#button-step",    () => { CPU_Z80.exec(); launch_debugger(); });
        clicSiActif("#button-stepover",() => Emulator_Core.stepOver());

        const joy = document.querySelector("#checkbox-joystick");
        if (joy) {
            brancher(joy, 'click', function () {
                Config_Manager.joystickEnabled = !Config_Manager.joystickEnabled;
                this.classList.toggle("active");
            });
        }
    },

    // -------------------------------------------------------------------------
    // Event detachment (used by pages that replace generic bindings)
    // -------------------------------------------------------------------------

    /**
     * Removes every listener this module attached to the matching element.
     * Replaces the `$('#id').off('click')` idiom used by the game page.
     *
     * @param {string} selecteur Sélecteur CSS de l'élément ciblé.
     * @returns {void}
     */
    detach(selecteur) {
        const noeud = document.querySelector(selecteur);
        if (noeud) detacher(noeud);
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
        const ouvrir = document.querySelector("#checkbox-settings");
        const fermer = document.querySelector("#settings-close");
        const voile  = document.querySelector("#option-panel-overlay");
        if (ouvrir) {
            brancher(ouvrir, 'click', () => {
                Emulator_Core.pauseEmulator();
                animer("#option-panel-overlay, #option-panel", true, 200);
            });
        }
        if (fermer) {
            brancher(fermer, 'click', () => {
                Config_Manager.saveConfiguration();
                Config_Manager.applyConfiguration();
                animer("#option-panel-overlay, #option-panel", false, 200);
                Emulator_Core.resumeEmulator();
            });
        }
        if (voile) {
            brancher(voile, 'click', () => {
                animer("#option-panel-overlay, #option-panel", false, 200);
                Emulator_Core.resumeEmulator();
            });
        }
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
            document.querySelector("#checkbox-sound")?.classList.add("active");
            basculerIcone(document.querySelector("#checkbox-sound"), "fa-volume-mute", "fa-volume-up");
        } else {
            document.querySelector("#checkbox-sound")?.classList.remove("active");
            basculerIcone(document.querySelector("#checkbox-sound"), "fa-volume-up", "fa-volume-mute");
        }

        brancher(document.querySelector("#checkbox-sound"), 'click', async function () {
            if (Config_Manager.soundEnabled) {
                Config_Manager.soundEnabled = false;
                setCookie("sound", false, 365);
                this.classList.remove("active");
                basculerIcone(this, "fa-volume-up", "fa-volume-mute");
            } else {
                await Audio_Output.Resume();
                Config_Manager.soundEnabled = true;
                setCookie("sound", true, 365);
                this.classList.add("active");
                basculerIcone(this, "fa-volume-mute", "fa-volume-up");
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
        const selecteur = document.querySelector("#snapshot");
        if (selecteur) selecteur.value = "none";
        const debug = document.querySelector("#checkbox-debugger");
        if (debug) debug.checked = false;

        brancher(selecteur, 'change', function () {
            this.blur();
            const val = this.value;
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
        // Le sélecteur jQuery d'origine, `":button, :radio, :submit, :checkbox"`,
        // couvrait `<button>` **et** `<input type=button|submit|reset>`, plus les
        // trois types de cases. La traduction littérale l'aurait perdu : on
        // énumère donc les types explicitement plutôt que d'écrire `"button,
        // input"`, qui aurait aussi attrapé les champs de saisie texte.
        const types = ["button", "reset", "submit", "radio", "checkbox"];
        document.querySelectorAll(
            "button, " + types.map((t) => `input[type=${t}]`).join(", ")
        ).forEach((noeud) => brancher(noeud, 'focus', function () { this.blur(); }));
    },

    /**
     * Shows or hides peripheral panels (drive B, tape) based on the current
     * option checkboxes.
     *
     * @returns {void}
     */
    updateDrivePanels() {
        const drivea = document.querySelector("#fieldset-drivea");
        if (drivea) drivea.style.display = '';
        const driveb = document.querySelector("#fieldset-driveb");
        const tape   = document.querySelector("#fieldset-tape");
        if (document.querySelector("#floppy-option")?.checked && driveb) driveb.style.display = '';
        if (document.querySelector("#tape-option")?.checked && tape) tape.style.display = '';
    },

    /**
     * Toggles the cartridge panel visibility based on the active machine type.
     *
     * @param {boolean} show - `true` to reveal the panel, `false` to hide it.
     * @returns {void}
     */
    toggleCartPanel(show) {
        const cart = document.querySelector("#fieldset-cart");
        if (cart) cart.style.display = show ? '' : 'none';
    },

    /**
     * Makes the emulator canvas visible and hides the splash logo.
     *
     * @returns {void}
     */
    showEmulatorScreen() {
        const ecran = document.querySelector("#screen");
        if (ecran) ecran.style.display = '';
        document.querySelectorAll("#logo, #browser-nfo")
            .forEach((noeud) => { noeud.style.display = 'none'; });
    },

    /**
     * Updates Run/Pause, Step, and Step-Over button states to reflect
     * whether the emulator is currently running or paused.
     *
     * @param {boolean} running - `true` if the emulator is actively running.
     * @returns {void}
     */
    setRunningState(running) {
        // `setRunningState` est rappelé à chaque transition : on rebind
        // `#button-run` à chaque fois, donc on retire l'ancien écouteur
        // (équivalent du `.off('click')` jQuery).
        const run = document.querySelector("#button-run");
        const etapes = document.querySelectorAll("#button-step, #button-stepover");
        const autres = document.querySelectorAll("#button-run, #button-reset");

        if (running) {
            etapes.forEach((n) => {
                n.classList.remove("button");
                n.classList.add("disabled-button");
            });
            if (run) {
                run.innerHTML = '<span class="guifx2">2 </span>Pause';
                brancher(run, 'click', function () {
                    if (this.classList.contains("button")) Emulator_Core.pauseEmulator();
                });
            }
            autres.forEach((n) => {
                n.classList.remove("disabled-button");
                n.classList.add("button");
            });
        } else {
            if (run) {
                run.innerHTML = '<span class="guifx2">d </span> Resume';
                brancher(run, 'click', function () {
                    if (this.classList.contains("button")) Emulator_Core.resumeEmulator();
                });
            }
            document.querySelectorAll("#button-run, #button-reset, #button-step, #button-stepover")
                .forEach((n) => {
                    n.classList.remove("disabled-button");
                    n.classList.add("button");
                });
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
     * Restores the emulator configuration from cookies and updates the
     * corresponding radio buttons and checkboxes.
     *
     * Falls back to sane defaults when a cookie value is missing or invalid.
     *
     * @returns {void}
     */
    loadConfigFromCookies() {
        let val;

        // `.checked` (propriété) : l'attribut `checked` ne suffirait pas,
        // l'utilisateur ayant pu modifier la case depuis.
        const cocher = (selecteur) => {
            const radio = document.querySelector(selecteur);
            if (radio) radio.checked = true;
        };

        val = getCookie("brand");
        if (!["awa", "schneider", "amstrad"].includes(val)) val = "amstrad";
        cocher(`input[type=radio][name=brand][value=${val}]`);

        val = getCookie("firmware");
        if (!["english", "french", "spanish"].includes(val)) val = "spanish";
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
     * Reads the current state of all configuration controls and returns it
     * as a plain object.
     *
     * @returns {{ brand: string, firmware: string, monitor: string,
     *             audio: string, crtcType: string, floppyB: boolean,
     *             tape: boolean, ram: boolean }} Current UI configuration.
     */
    readConfigFromUI() {
        const radio = (name) => document.querySelector(`input[type=radio][name=${name}]:checked`)?.value;
        const coche = (sel) => document.querySelector(sel)?.checked;
        return {
            brand    : radio("brand"),
            firmware : radio("firmware"),
            monitor  : radio("monitor"),
            audio    : radio("audio"),
            crtcType : radio("crtc"),
            floppyB  : coche("#floppy-option"),
            tape     : coche("#tape-option"),
            ram      : coche("#ram-option"),
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
        // `:visible` de jQuery ⇔ l'élément a au moins un rectangle de rendu.
        const visible = (sel) => (document.querySelector(sel)?.getClientRects().length ?? 0) > 0;

        if (cfg.floppyB) {
            Floppy_Drive_B.ready = true;
            if (visible("#fieldset-drivea")) {
                const b = document.querySelector("#fieldset-driveb");
                if (b) b.style.display = '';
            }
        } else {
            Floppy_Drive_B.ready = false;
            const b = document.querySelector("#fieldset-driveb");
            if (b) b.style.display = 'none';
        }

        if (cfg.tape) {
            Tape_Recorder.ready = true;
            if (visible("#fieldset-drivea")) {
                const t = document.querySelector("#fieldset-tape");
                if (t) t.style.display = '';
            }
        } else {
            document.querySelector("#tape-stop")?.click();
            Tape_Recorder.ready = false;
            const t = document.querySelector("#fieldset-tape");
            if (t) t.style.display = 'none';
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
        const valeur = machineType === 2 ? 'type1' : (machineType >= 4 ? 'type3' : null);
        if (!valeur) return;
        const radio = document.querySelector(`input[type=radio][name=crtc][value=${valeur}]`);
        if (radio) radio.checked = true;
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

        brancher(document.querySelector('#drivea-input'), 'change', function (e) {
            handleDiskUpload(e.target.files[0], Floppy_Drive_A, 'drivea-filename', 'drivea-eject', 'drivea-programs');
        });

        brancher(document.querySelector('#drivea-eject'), 'click', function () {
            if (Floppy_Drive_A.isDirty) {
                if (confirm("La disquette a été modifiée. Voulez-vous la sauvegarder avant l'éjection ?")) {
                    downloadDisk(Floppy_Drive_A);
                }
            }
            Floppy_Drive_A.diskImage = null;
            Floppy_Drive_A.isDirty   = false;
            const nom = document.querySelector('#drivea-filename');
            if (nom) nom.textContent = 'Vide';
            const liste = document.querySelector('#drivea-programs');
            if (liste) { liste.style.display = 'none'; liste.replaceChildren(); }
            this.classList.remove('button');
            this.classList.add('disabled-button');
            const input = document.querySelector('#drivea-input');
            if (input) input.value = '';
        });

        brancher(document.querySelector('#drivea-new'), 'click', function () {
            mountBlankDSK(Floppy_Drive_A, 'drivea-filename', 'drivea-eject');
        });

        brancher(document.querySelector('#driveb-input'), 'change', function (e) {
            handleDiskUpload(e.target.files[0], Floppy_Drive_B, 'driveb-filename', 'driveb-eject', 'driveb-programs');
        });

        brancher(document.querySelector('#driveb-eject'), 'click', function () {
            if (Floppy_Drive_B.isDirty) {
                if (confirm("La disquette a été modifiée. Voulez-vous la sauvegarder avant l'éjection ?")) {
                    downloadDisk(Floppy_Drive_B);
                }
            }
            Floppy_Drive_B.diskImage = null;
            Floppy_Drive_B.isDirty   = false;
            const nom = document.querySelector('#driveb-filename');
            if (nom) nom.textContent = 'Vide';
            const liste = document.querySelector('#driveb-programs');
            if (liste) { liste.style.display = 'none'; liste.replaceChildren(); }
            this.classList.remove('button');
            this.classList.add('disabled-button');
            const input = document.querySelector('#driveb-input');
            if (input) input.value = '';
        });

        brancher(document.querySelector('#driveb-new'), 'click', function () {
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
        brancher(document.querySelector('#tape-input'), 'change', function () {
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
                const nom = document.querySelector('#tape-filename');
                if (nom) nom.textContent = file.name;
                const eject = document.querySelector('#tape-eject');
                eject?.classList.remove('disabled-button');
                eject?.classList.add('button');
                TapeController.setTapeState(TapeController.STATE_STOP);
                analyzeTape(Tape_Recorder.diskImage);
            };
            reader.readAsArrayBuffer(file);
        });

        brancher(document.querySelector('#tape-eject'), 'click', function () {
            if (this.classList.contains('disabled-button')) return;
            if (typeof TapeController === 'undefined') return;
            TapeController.ejectTape();
            Tape_Recorder.diskImage = null;
            const nom = document.querySelector('#tape-filename');
            if (nom) nom.textContent = 'Aucune cassette';
            const input = document.querySelector('#tape-input');
            if (input) input.value = '';
            this.classList.remove('button');
            this.classList.add('disabled-button');
        });

        brancher(document.querySelector('#tape-new'), 'click', function () {
            if (typeof WAV_Parser === 'undefined' || typeof TapeController === 'undefined') return;
            TapeController.ejectTape();
            Tape_Recorder.diskImage = WAV_Parser.createBlankTape(90);
            const nom = document.querySelector('#tape-filename');
            if (nom) nom.textContent = 'Cassette Vierge (90 min)';
            const eject = document.querySelector('#tape-eject');
            eject?.classList.remove('disabled-button');
            eject?.classList.add('button');
            TapeController.setTapeState(TapeController.STATE_STOP);
        });

        brancher(document.querySelector('#tape-save'), 'click', function () {
            if (typeof Tape_Recorder !== 'undefined' && Tape_Recorder.diskImage) {
                downloadTapeAsWav(Tape_Recorder.diskImage);
            }
        });
    },

    // -------------------------------------------------------------------------
    // Keyboard / AutoType bindings
    // -------------------------------------------------------------------------

    /**
     * Câble les boutons d'envoi et de vidage de la zone Auto-Type, ainsi que le
     * choix du mode.
     *
     *   - `clavier` (défaut) : le listing est frappé touche par touche, le
     *     firmware tokenise et gère lui-même la mémoire ;
     *   - `memoire` : le listing est tokenisé côté PC et écrit tel quel à &0170.
     *     Instantané, mais le programme présent est écrasé.
     *
     * @returns {void}
     */
    bindKeyboard() {
        brancher(document.querySelector('#autotype-send'), 'click', function () {
            const code = document.querySelector('#autotype-area')?.value;
            if (!code) return;
            if (UI_Manager._modeAutotype() === 'memoire') {
                UI_Manager._transfererEnMemoire(code);
                return;
            }
            CPC_INPUT.keyboard.autotype(code + '\r');
        });

        UI_Manager._brancherModesAutotype();

        brancher(document.querySelector('#autotype-clear'), 'click', function () {
            CPC_INPUT.keyboard.cancelAutotype();
            const zone = document.querySelector('#autotype-area');
            if (zone) zone.value = '';
            UI_Manager._noteAutotype('', '');
        });
    },

    /**
     * Mode d'envoi choisi dans la carte Auto-Type.
     * @returns {string} `clavier` (défaut) ou `memoire`.
     */
    _modeAutotype() {
        const coche = document.querySelector('input[name=autotype-mode]:checked');
        return coche ? coche.value : 'clavier';
    },

    /**
     * Écoute les boutons radio du mode et aligne le libellé du bouton.
     * Sans effet sur les pages qui n'ont pas ces contrôles : game.html garde le
     * seul mode clavier, utilisé par l'auto-run.
     * @returns {void}
     */
    _brancherModesAutotype() {
        document.querySelectorAll('input[name=autotype-mode]').forEach(function (radio) {
            brancher(radio, 'change', function () { UI_Manager._majModeAutotype(); });
        });
        UI_Manager._majModeAutotype();
    },

    /**
     * Adapte le libellé du bouton d'envoi au mode choisi.
     * @returns {void}
     */
    _majModeAutotype() {
        const libelle = document.querySelector('#autotype-send-label');
        if (libelle) {
            libelle.textContent = (UI_Manager._modeAutotype() === 'memoire')
                ? 'Transférer en mémoire'
                : 'Injecter dans le CPC';
        }
        UI_Manager._noteAutotype('', '');
    },

    /**
     * Écrit un message sous le bouton Auto-Type (résultat du dernier envoi).
     * @param {string} texte  Message ; chaîne vide pour effacer.
     * @param {string} classe `ok`, `erreur`, ou chaîne vide.
     * @returns {void}
     */
    _noteAutotype(texte, classe) {
        const note = document.querySelector('#autotype-note');
        if (!note) return;
        note.textContent = texte;
        note.className = 'autotype-note' + (classe ? ' ' + classe : '');
    },

    /**
     * Transfère un listing BASIC directement en mémoire (&0170) au lieu de le
     * frapper touche par touche.
     *
     * Le programme présent et ses variables sont écrasés : d'où la confirmation
     * explicite. Rien n'est exécuté automatiquement — l'utilisateur tape RUN ou
     * LIST, ce qui lui laisse le choix et évite de lancer un listing à moitié
     * vérifié.
     *
     * @param {string} source Listing ASCII saisi dans la zone Auto-Type.
     * @returns {void}
     */
    _transfererEnMemoire(source) {
        if (typeof BasicTokenizer === 'undefined' || typeof ROM_Manager === 'undefined') {
            UI_Manager._noteAutotype('Transfert mémoire indisponible.', 'erreur');
            return;
        }

        const avertissement = 'Le transfert mémoire écrase le programme BASIC et ses '
            + 'variables. Continuer ?';
        if (!window.confirm(avertissement)) return;

        const resultat = BasicTokenizer.injecter(
            source,
            Machine_Type,
            function (adresse, valeur) { ROM_Manager.writeMemory(adresse, valeur); },
        );

        if (!resultat.ok) {
            const erreur = resultat.erreurs[0];
            UI_Manager._noteAutotype(
                'Échec' + (erreur.ligne ? ' ligne ' + erreur.ligne : '') + ' : ' + erreur.message,
                'erreur',
            );
            return;
        }

        UI_Manager._noteAutotype(
            resultat.lignes + ' ligne(s), ' + resultat.octets + ' octets — tapez RUN ou LIST',
            'ok',
        );
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
        brancher(document.querySelector('#snapshot-capture'), 'click', function () {
            Snapshot_Manager.takeSnapshot();
        });

        brancher(document.querySelector('#snapshot-input'), 'change', function (e) {
            const file = e.target.files[0];
            if (!file) return;

            const nom = document.querySelector('#snapshot-filename');
            const eject = document.querySelector('#snapshot-eject');
            const liste = document.querySelector('#snapshot-zipselect');
            if (nom) nom.textContent = file.name;
            eject?.classList.remove('disabled-button');

            if (file.name.toLowerCase().endsWith('.zip')) {
                Snapshot_Manager.extractZipEntries(file, snaFiles => {
                    if (!snaFiles || snaFiles.length === 0) {
                        if (nom) nom.textContent = 'Aucun snapshot';
                        eject?.classList.add('disabled-button');
                        return;
                    }
                    Snapshot_Manager.currentZipEntries = snaFiles;
                    if (snaFiles.length > 1 && liste) {
                        liste.replaceChildren();
                        snaFiles.forEach(f => liste.add(new Option(f.name, f.name)));
                        liste.style.display = '';
                        Snapshot_Manager.loadFromZipEntry(snaFiles[0].entry);
                    } else {
                        if (liste) liste.style.display = 'none';
                        Snapshot_Manager.loadFromZipEntry(snaFiles[0].entry);
                    }
                });
            } else {
                if (liste) liste.style.display = 'none';
                const reader = new FileReader();
                reader.onload = event => Snapshot_Manager.loadSnapshot(event.target.result);
                reader.readAsArrayBuffer(file);
            }
        });

        brancher(document.querySelector('#snapshot-zipselect'), 'change', function () {
            const selectedName = this.value;
            const found = Snapshot_Manager.currentZipEntries &&
                Snapshot_Manager.currentZipEntries.find(f => f.name === selectedName);
            if (found) {
                Snapshot_Manager.loadFromZipEntry(found.entry);
                const nom = document.querySelector('#snapshot-filename');
                if (nom) nom.textContent = selectedName;
            }
        });

        brancher(document.querySelector('#snapshot-eject'), 'click', function () {
            if (this.classList.contains('disabled-button')) return;
            const nom = document.querySelector('#snapshot-filename');
            if (nom) nom.textContent = 'Aucun snapshot';
            const input = document.querySelector('#snapshot-input');
            if (input) input.value = '';
            const liste = document.querySelector('#snapshot-zipselect');
            if (liste) { liste.style.display = 'none'; liste.replaceChildren(); }
            this.classList.add('disabled-button');
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
        brancher(document.querySelector('#cart-input'), 'change', function (e) {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = function (event) {
                const data = new Uint8Array(event.target.result);
                window.currentCprPath = `USER/${file.name}`;
                window.files          = window.files || {};
                window.files[window.currentCprPath] = data;
                const nom = document.querySelector('#cart-filename');
                if (nom) nom.textContent = file.name;
                const eject = document.querySelector('#cart-eject');
                eject?.classList.remove('disabled-button');
                eject?.classList.add('button');
                Emulator_Core.hardReset();
            };
            reader.readAsArrayBuffer(file);
        });

        brancher(document.querySelector('#cart-eject'), 'click', function () {
            if (this.classList.contains('disabled-button')) return;
            window.currentCprPath = null;
            const nom = document.querySelector('#cart-filename');
            if (nom) nom.textContent = 'Aucune cartouche';
            this.classList.remove('button');
            this.classList.add('disabled-button');
            const input = document.querySelector('#cart-input');
            if (input) input.value = '';
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
        brancher(document.querySelector('#printer-clear'), 'click', function () {
            if (typeof VirtualPrinter !== 'undefined') VirtualPrinter.clear();
        });

        brancher(document.querySelector('#printer-toggle'), 'click', function () {
            const sortie = document.querySelector('#printer-output');
            const visible = (sortie?.getClientRects().length ?? 0) > 0;
            if (visible) {
                animer('#printer-output', false, 150);
                basculerIcone(this, 'fa-chevron-up', 'fa-chevron-down');
            } else {
                animer('#printer-output', true, 150);
                basculerIcone(this, 'fa-chevron-down', 'fa-chevron-up');
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
        const turbo = document.querySelector('#button-turbo');
        if (!turbo) return;
        brancher(turbo, 'click', function () {
            if (typeof toggleTurbo === 'undefined') return;
            toggleTurbo();
            if (Config_Manager.turboMode) {
                this.classList.add('turbo-on');
                if (Config_Manager.soundEnabled) {
                    Config_Manager.soundEnabled = false;
                    if (typeof setCookie === 'function') setCookie('sound', false, 365);
                    const son = document.querySelector('#checkbox-sound');
                    son?.classList.remove('active');
                    basculerIcone(son, 'fa-volume-up', 'fa-volume-mute');
                }
            } else {
                this.classList.remove('turbo-on');
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
        brancher(document.querySelector('#checkbox-fullscreen'), 'click', function () {
            const isFullscreen = document.fullscreenElement      ||
                               document.mozFullScreenElement   ||
                               document.webkitFullscreenElement;
            if (isFullscreen) {
                const exitFn = document.exitFullscreen ||
                             document.mozCancelFullScreen ||
                             document.webkitExitFullscreen;
                if (exitFn) exitFn.call(document);
                basculerIcone(this, 'fa-compress', 'fa-expand');
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
                    basculerIcone(this, 'fa-expand', 'fa-compress');
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
        brancher(document.querySelector('#volume-slider-ui'), 'input', function () {
            const val = parseInt(this.value, 10);
            const volume = document.querySelector('#sound-volume');
            if (volume) {
                volume.value = val;
                volume.dispatchEvent(new Event('input'));
            }
            if (typeof Config_Manager !== 'undefined' && typeof Config_Manager.setVolume === 'function') {
                Config_Manager.setVolume(val / 100);
            }
        });

        var _joystickOn = true;
        brancher(document.querySelector('#btn-joystick'), 'click', function () {
            _joystickOn = !_joystickOn;
            if (typeof Config_Manager !== 'undefined') Config_Manager.joystickEnabled = _joystickOn;
            const caseJoy = document.querySelector('#checkbox-joystick');
            if (_joystickOn) {
                caseJoy?.classList.add('active');
                this.classList.remove('disabled');
                this.setAttribute('title', 'Joystick clavier (actif)');
            } else {
                caseJoy?.classList.remove('active');
                this.classList.add('disabled');
                this.setAttribute('title', 'Joystick clavier (désactivé)');
            }
        });

        var _soundOn = true;
        brancher(document.querySelector('#btn-sound'), 'click', function () {
            _soundOn = !_soundOn;
            if (typeof Config_Manager !== 'undefined') Config_Manager.soundEnabled = _soundOn;
            const caseSon = document.querySelector('#checkbox-sound');
            if (_soundOn) {
                this.classList.remove('muted');
                basculerIcone(this, 'fa-volume-mute', 'fa-volume-up');
                if (typeof Audio_Output !== 'undefined') Audio_Output.Resume().catch(function () {});
                caseSon?.classList.add('active');
                basculerIcone(caseSon, 'fa-volume-mute', 'fa-volume-up');
            } else {
                this.classList.add('muted');
                basculerIcone(this, 'fa-volume-up', 'fa-volume-mute');
                caseSon?.classList.remove('active');
                basculerIcone(caseSon, 'fa-volume-up', 'fa-volume-mute');
            }
        });

        brancher(document.querySelector('#btn-fullscreen'), 'click', function () {
            const el  = document.getElementById('emulator-area');
            const isF = document.fullscreenElement || document.webkitFullscreenElement;
            if (isF) {
                (document.exitFullscreen || document.webkitExitFullscreen).call(document);
                basculerIcone(this, 'fa-compress', 'fa-expand');
            } else {
                const reqFn = el.requestFullscreen || el.webkitRequestFullscreen;
                if (reqFn) reqFn.call(el).catch(function (e) { console.warn('[Fullscreen]', e.message); });
                basculerIcone(this, 'fa-expand', 'fa-compress');
            }
        });

        brancher(document.querySelector('#checkbox-fullscreen'), 'click', function () {
            document.querySelector('#btn-fullscreen')?.click();
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
        // L'état cible est calculé au moment du clic, pas du branchement.
        const transport = (selecteur, etat) => {
            brancher(document.querySelector(selecteur), 'click', () => {
                TC.setTapeState(typeof etat === 'function' ? etat() : etat);
            });
        };
        const enAvant = (etat) => () => (TC.tapePosition < disk.size - 1 ? etat : TC.STATE_STOP);
        const enArriere = () => (TC.tapePosition > 0 ? TC.STATE_REWIND : TC.STATE_STOP);

        transport('#tape-record',  enAvant(TC.STATE_RECORD));
        transport('#tape-play',    enAvant(TC.STATE_PLAY));
        transport('#tape-rewind',  enArriere);
        transport('#tape-forward', enAvant(TC.STATE_FORWARD));
        transport('#tape-stop',    TC.STATE_STOP);
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
     * @param {string|string[]} [events='click'] - Liste d'événements
     *   séparés par des espaces (par exemple `'click keydown'`). L'écouteur
     *   ne se déclenche qu'une fois, puis se détache.
     * @returns {void}
     */
    bindAudioResume(events) {
        const types = (events || 'click').split(' ').filter(Boolean);
        const premier = async function () {
            for (const type of types) document.removeEventListener(type, premier);
            if (typeof Audio_Output === 'undefined') return;
            if (typeof Config_Manager !== 'undefined' && !Config_Manager.soundEnabled) return;
            if (Audio_Output.isInitialized) {
                if (Audio_Output.audioContext?.state === 'suspended') {
                    try { await Audio_Output.audioContext.resume(); } catch (e) { /* silent */ }
                }
                return;
            }
            try { await Audio_Output.Resume(); } catch (e) { /* silent */ }
        };
        for (const type of types) document.addEventListener(type, premier, { once: true });
    },
};
