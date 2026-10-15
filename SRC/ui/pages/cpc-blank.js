/**
 * @file        cpc-blank.js
 * @description CPC control console — Z80 register updates, debugger handling,
 *              turbo mode, fullscreen, settings modal, virtual printer and
 *              toolbar button bindings.
 * @author      Thierry MAIGNAN
 * @project     JS CPC V2 — Amstrad in your browser
 * @depends     Emulator_Core, CPU_Z80, Audio_Output, Config_Manager,
 *              Tools_Formatters (toHex16), VirtualPrinter
 */

'use strict';

/* -------------------------------------------------------------
   CPU_Z80.updateUI — register updates in the sidebar.
   Deliberate engine / UI separation (CPU_Z80_Core.js holds no UI).
   ------------------------------------------------------------- */
if (typeof CPU_Z80 !== 'undefined') {
    CPU_Z80.updateUI = function () {
        // 16-bit register pairs
        document.getElementById('regAF').textContent = toHex16(this.r16[3]);
        document.getElementById('regBC').textContent = toHex16(this.r16[0]);
        document.getElementById('regDE').textContent = toHex16(this.r16[1]);
        document.getElementById('regHL').textContent = toHex16(this.r16[2]);
        // Index registers
        document.getElementById('regIX').textContent = toHex16(this.idxRegs[0]);
        document.getElementById('regIY').textContent = toHex16(this.idxRegs[1]);
        // Pointers
        document.getElementById('regSP').textContent = toHex16(this.regSP);
        document.getElementById('regPC').textContent = toHex16(this.regPC);
        // Flags F: S Z Y H X P/V N C
        var f = this.r8[6];
        document.getElementById('z80_flags').textContent =
            (f & 0x80 ? 'S' : '-') +
            (f & 0x40 ? 'Z' : '-') +
            (f & 0x20 ? 'Y' : '-') +
            (f & 0x10 ? 'H' : '-') +
            (f & 0x08 ? 'X' : '-') +
            (f & 0x04 ? 'P' : '-') +
            (f & 0x02 ? 'N' : '-') +
            (f & 0x01 ? 'C' : '-');
        // Redraw the "Code at @PC" panel
        CodeAtPC.maj(this.regPC);
    };
}

/* -------------------------------------------------------------
   Code at @PC — execution history + look-ahead window

   A list of 9 lines "address | bytes | mnemonic", from top to bottom:
     - the last 4 instructions ACTUALLY executed, oldest to most recent;
     - the instruction at PC;
     - the next 4.

   The history is NOT derived from the address: "PC - n" is wrong as soon
   as a JR, a CALL or a RET moves the flow. It comes from the Z80 core's
   built-in history (`CPU_Z80.activerHistorique()`).

   The disassembly and the DOM writes happen at the REGISTER REFRESH RATE
   (after a step, and every 500 ms), and only when the window moved:
   while paused, `maj()` returns immediately.
   ------------------------------------------------------------- */
var CodeAtPC = (function () {
    'use strict';

    /** Number of past instructions displayed (the last 4 executed). */
    var HISTORIQUE_TAILLE = 4;

    /** Number of instructions displayed from PC (PC included). */
    var FENETRE_AVANT = 5;

    /**
     * Signature of the currently displayed window. As long as it does not
     * change, `maj()` returns immediately: no disassembly, no DOM write.
     * @type {string|null}
     */
    var fenetreCle = null;

    /** Reads a memory byte for the disassembler. */
    function lire(a) { return ROM_Manager.readMemory(a); }

    /**
     * Renders one disassembly line.
     * @param {number} adresse - Line address.
     * @param {{octets: string, texte: string}} ligne - Disassembler line.
     * @param {string} classe - CSS class of the line.
     * @returns {string} HTML fragment.
     */
    function ligneHtml(adresse, ligne, classe) {
        return '<div class="disasm-ligne ' + classe + '">' +
                '<span class="disasm-adresse">' + toHex16(adresse) + '</span>' +
                '<span class="disasm-octets">' + (ligne.octets || '') + '</span>' +
                '<span class="disasm-texte">' + ligne.texte + '</span>' +
                '</div>';
    }

    /**
     * Signature of the displayed window: PC then the executed addresses.
     * Two consecutive calls without a new instruction produce the same
     * signature.
     * @param {number} pc - Current PC value.
     * @returns {string}
     */
    function signature(pc) {
        var cle = pc + ':';
        for (var i = 0; i < CPU_Z80.historiqueRemplis; i++) {
            cle += CPU_Z80.adresseExecutee(i) + ',';
        }
        return cle;
    }

    /**
     * Redraws the panel, but ONLY when its window changed.
     *
     * Called at the same rate as the register refresh (after a step, and
     * every 500 ms), NEVER on every CPU cycle.
     *
     * @param {number} adresse - Current PC value.
     * @returns {void}
     */
    function maj(adresse) {
        var cible = document.getElementById('z80_disasm');
        if (!cible || typeof Z80Disassembler === 'undefined') return;

        var pc = adresse & 0xFFFF;

        var cle = signature(pc);
        if (cle === fenetreCle) return;
        fenetreCle = cle;

        var html = '';

        // -- The last 4 executed instructions, in chronological order.
        //    They are shown as-is: on a tight loop (JR -2) the same address
        //    legitimately appears both in the history and at PC.
        for (var i = 0; i < CPU_Z80.historiqueRemplis; i++) {
            var passee = CPU_Z80.adresseExecutee(i);
            html += ligneHtml(passee,
                Z80Disassembler.desassembler(lire, passee, 1)[0],
                'disasm-hist');
        }

        // -- Separator: the past above, what comes next below.
        if (html !== '') html += '<div class="disasm-sep"></div>';

        // -- From PC: the current one (highlighted), then the following ones.
        var avant = Z80Disassembler.desassembler(lire, pc, FENETRE_AVANT);
        for (var j = 0; j < avant.length; j++) {
            html += ligneHtml(avant[j].adresse, avant[j],
                j === 0 ? 'disasm-courante' : 'disasm-suite');
        }

        cible.innerHTML = html;
    }

    /**
     * Arms the core history and invalidates the display on every reset.
     * A reset (Reset button, machine change, SNA load) starts from a fresh PC,
     * so the panel must forget its signature.
     * @returns {void}
     */
    function armer() {
        if (typeof CPU_Z80 === 'undefined' || typeof CPU_Z80.activerHistorique !== 'function') return;

        CPU_Z80.activerHistorique(HISTORIQUE_TAILLE);

        var resetOrigine = CPU_Z80.reset.bind(CPU_Z80);
        CPU_Z80.reset = function () {
            fenetreCle = null;
            return resetOrigine();
        };
    }

    return { maj: maj, armer: armer };
})();

CodeAtPC.armer();

/* -------------------------------------------------------------
   launch_debugger — required by Emulator_Core
   ------------------------------------------------------------- */
function launch_debugger() {
    try {
        if (typeof CPU_Z80 !== 'undefined') CPU_Z80.updateUI();
    } catch (e) { /* silent when the UI is not ready */ }
}

/* -- Periodic register refresh (every 500 ms) ----------------------- */
setInterval(function () {
    try {
        if (typeof CPU_Z80 !== 'undefined' && typeof Emulator_Core !== 'undefined') {
            CPU_Z80.updateUI();
        }
    } catch (e) { /* silent */ }
}, 500);

/* -------------------------------------------------------------
   MONKEY-PATCH updateFps
   Emulator_Core.updateFps() writes "Running @ X fps" into #status.
   The numeric value is moved to #fps-counter, away from the status text.
   ------------------------------------------------------------- */
var _origUpdateFps = Emulator_Core.updateFps.bind(Emulator_Core);
Emulator_Core.updateFps = function () {
    _origUpdateFps();
    var m = (typeof window.statusElement !== 'undefined' && window.statusElement)
        ? window.statusElement.innerHTML.match(/(\d+)\s*fps/i)
        : null;
    if (m) {
        document.getElementById('fps-counter').textContent = m[1];
        window.statusElement.innerHTML = 'Running';
    }
};

/* -------------------------------------------------------------
   AUDIO — activation on the first user click
   ------------------------------------------------------------- */
// NOTE: bindSoundButton() (wired by Emulator_Setup.js) already handles the
// audio init on click; no extra handler is bound here.

/* -------------------------------------------------------------
   cpc-blank specific bindings — wired HERE because they are absent
   from Emulator_Setup.js (turbo, fullscreen and printer are specific
   to this page).
   ------------------------------------------------------------- */
(function () {
    function demarrer() {
        /* window.files must exist before the parsers run */
        if (typeof window.files === 'undefined') window.files = {};

        // -- Turbo -------------------------------------------------
        UI_Manager.bindTurboButton();

        // -- Fullscreen ----------------------------------------------
        UI_Manager.bindFullscreen();

        // -- Virtual printer -----------------------------------------
        // The card is permanently visible; `clear()` empties its content
        // without hiding the peripheral.
        UI_Manager.bindPrinter();
        // Shows the waiting message, so the empty area reads as a wired
        // parallel port.
        if (typeof VirtualPrinter !== 'undefined') VirtualPrinter.init();

        /* -- JSZip check -------------------------------------------- */
        if (typeof JSZip === 'undefined') {
            console.warn('⚠️ JSZip not available — ZIP files will not be supported');
        }

        /* -- Volume (initVolumeSlider wires the native listener) ---- */
        if (typeof Config_Manager !== 'undefined' &&
            typeof Config_Manager.initVolumeSlider === 'function') {
            Config_Manager.initVolumeSlider();
        }
    };

    // Replacement for `$(document).ready(fn)`.
    // `demarrer` is declared inside the IIFE, so the guard is placed here too.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', demarrer, { once: true });
    } else {
        demarrer();
    }
})();
