/**
 * @file        cpc-blank.js
 * @description Console de contrôle CPC — Mise à jour des registres Z80,
 *              gestion du débogueur, mode turbo, plein écran, modal settings,
 *              imprimante virtuelle et bindings des boutons de la toolbar.
 * @author      Thierry MAIGNAN
 * @project     JS CPC V2 — L'Amstrad dans votre Navigateur
 * @depends     jQuery, Emulator_Core, CPU_Z80, Audio_Output, Config_Manager,
 *              Tools_Formatters (toHex16), VirtualPrinter
 */

'use strict';

/* ─────────────────────────────────────────────────────────────
   CPU_Z80.updateUI — Mise à jour des registres dans la sidebar
   Séparation volontaire moteur / interface (CPU_Z80_Core.js ne
   contient pas de code UI).
   ───────────────────────────────────────────────────────────── */
if (typeof CPU_Z80 !== 'undefined') {
    CPU_Z80.updateUI = function () {
        // Paires 16 bits
        document.getElementById('regAF').textContent = toHex16(this.r16[3]);
        document.getElementById('regBC').textContent = toHex16(this.r16[0]);
        document.getElementById('regDE').textContent = toHex16(this.r16[1]);
        document.getElementById('regHL').textContent = toHex16(this.r16[2]);
        // Registres d'index
        document.getElementById('regIX').textContent = toHex16(this.idxRegs[0]);
        document.getElementById('regIY').textContent = toHex16(this.idxRegs[1]);
        // Pointeurs
        document.getElementById('regSP').textContent = toHex16(this.regSP);
        document.getElementById('regPC').textContent = toHex16(this.regPC);
        // Flags F : S Z Y H X P/V N C
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
    };
}

/* ─────────────────────────────────────────────────────────────
   launch_debugger — Requis par Emulator_Core
   ───────────────────────────────────────────────────────────── */
function launch_debugger() {
    try {
        if (typeof CPU_Z80 !== 'undefined') CPU_Z80.updateUI();
    } catch (e) { /* silencieux si l'UI n'est pas prête */ }
}

/* ── Rafraîchissement périodique des registres (toutes les 500 ms) ── */
setInterval(function () {
    try {
        if (typeof CPU_Z80 !== 'undefined' && typeof Emulator_Core !== 'undefined') {
            CPU_Z80.updateUI();
        }
    } catch (e) { /* silencieux */ }
}, 500);

/* ─────────────────────────────────────────────────────────────
   MONKEY-PATCH updateFps
   Emulator_Core.updateFps() écrit "Running @ X fps" dans #status.
   On sépare la valeur numérique (→ #fps-counter) du texte de statut.
   ───────────────────────────────────────────────────────────── */
var _origUpdateFps = Emulator_Core.updateFps.bind(Emulator_Core);
Emulator_Core.updateFps = function () {
    _origUpdateFps();
    var m = (typeof statusElement !== 'undefined' && statusElement)
        ? statusElement.innerHTML.match(/(\d+)\s*fps/i)
        : null;
    if (m) {
        document.getElementById('fps-counter').textContent = m[1];
        statusElement.innerHTML = 'Running';
    }
};

/* ─────────────────────────────────────────────────────────────
   AUDIO — Activation au premier clic utilisateur
   ───────────────────────────────────────────────────────────── */
// NOTE : bindSoundButton() (câblé par Emulator_Setup.js) gère déjà l'init
// audio au clic. Ce one('click') supplémentaire créait une race condition
// (double appel concurrent à Audio_Output.init()). Supprimé.

/* ─────────────────────────────────────────────────────────────
   Bindings spécifiques à cpc-blank — câblés ICI car absents
   d'Emulator_Setup.js (turbo, plein écran, imprimante sont
   des fonctionnalités propres à cette page).
   ───────────────────────────────────────────────────────────── */
$(document).ready(function () {
    /* window.files doit exister avant les parsers */
    if (typeof window.files === 'undefined') window.files = {};

    // ── Turbo ─────────────────────────────────────────────────
    UI_Manager.bindTurboButton();

    // ── Plein écran ───────────────────────────────────────────
    UI_Manager.bindFullscreen();

    // ── Imprimante virtuelle ──────────────────────────────────
    UI_Manager.bindPrinter();

    /* ── Vérification JSZip ───────────────────────────────────── */
    if (typeof JSZip === 'undefined') {
        console.warn('⚠️ JSZip non disponible — les fichiers ZIP ne seront pas supportés');
    }

    /* ── Volume (initVolumeSlider gère l'écouteur natif) ──────── */
    if (typeof Config_Manager !== 'undefined' &&
        typeof Config_Manager.initVolumeSlider === 'function') {
        Config_Manager.initVolumeSlider();
    }
}); // fin document.ready
