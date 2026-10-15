/**
 * @file        game.js
 * @description Game page logic — URL parameter parsing, ROM loading, media
 *              insertion and UI management (loading overlay, header buttons,
 *              sound, joystick, fullscreen).
 * @author      Thierry MAIGNAN
 * @project     JS CPC V2 — Amstrad in your browser
 * @depends     Emulator_Core, CPU_Z80, Audio_Output, Config_Manager,
 *              DSK_Parser, SNA_Parser, Floppy_Drive_A, CPC_INPUT
 */

'use strict';

/* -------------------------------------------------------------
   STUB — launch_debugger()
   Required by Emulator_Core; the debugger is disabled on game.html.
   ------------------------------------------------------------- */
function launch_debugger() {
    try {
        if (typeof CPU_Z80 !== 'undefined') CPU_Z80.updateUI();
    } catch (e) { /* silent */ }
}

/* -------------------------------------------------------------
   MEDIA DIRECTORIES BY TYPE
   ------------------------------------------------------------- */
var MEDIA_DIRS = {
    disc: '/DSK/',
    snap: '/SNA/',
    cart: '/CPR/'
};

/* -------------------------------------------------------------
   URL PARAMETER PARSING
   New format    : ?disc=X | ?snap=X | ?cart=X
   Legacy format : ?type=disc&file=X  (backwards compatibility)
   ------------------------------------------------------------- */
(function parseUrlParams() {
    var params = new URLSearchParams(window.location.search);
    var _type, _file;

    if      (params.get('disc')) { _type = 'disc'; _file = params.get('disc'); }
    else if (params.get('snap')) { _type = 'snap'; _file = params.get('snap'); }
    else if (params.get('cart')) { _type = 'cart'; _file = params.get('cart'); }
    else if (params.get('file')) {
        _type = (params.get('type') || 'disc').toLowerCase();
        _file = params.get('file');
    }

    window._urlType  = _type  || null;
    window._urlFile  = _file  || null;
    window._mediaDir = _type  ? (MEDIA_DIRS[_type] || '/DSK/') : null;
    window._fullPath = (_type && _file) ? (window._mediaDir + _file) : null;
}());

/* -- Game name display in the header -------------------------- */
if (window._urlFile) {
    document.getElementById('game-name-display').textContent =
        window._urlFile.replace(/\.[^/.]+$/, '').replace(/[_\-]/g, ' ');
    document.title = 'JS CPC — ' + window._urlFile.replace(/\.[^/.]+$/, '');
} else {
    document.getElementById('game-name-display').textContent = 'Boot CPC';
    document.title = 'JS CPC - Démarrage';
}

/* -------------------------------------------------------------
   HELPERS — progress bar & status
   ------------------------------------------------------------- */

/**
 * Updates the progress bar and its label.
 * @param {number} pct   Percentage (0-100).
 * @param {string} label Displayed text (HTML allowed).
 */
function setLoadingProgress(pct, label) {
    var bar = document.getElementById('loading-bar');
    var lbl = document.getElementById('loading-label');
    if (bar) bar.style.width = Math.min(100, pct) + '%';
    if (lbl) lbl.innerHTML   = label;
}

/**
 * Updates the status pill in the header.
 * @param {string} text  Text to display.
 * @param {string} state CSS class: 'loading' | 'running' | 'error'.
 */
function setStatus(text, state) {
    var pill = document.getElementById('status-pill');
    var span = document.getElementById('status');
    if (span) span.textContent = text;
    if (pill) pill.className   = 'status-pill ' + (state || 'loading');
}

/**
 * Hides the loading overlay and tries to start the audio.
 */
function hideLoadingOverlay() {
    var ov = document.getElementById('loading-overlay');
    if (ov) {
        ov.classList.add('hidden');
        setTimeout(function () { if (ov.parentNode) ov.parentNode.removeChild(ov); }, 600);
    }
    setTimeout(async function () {
        if (typeof Audio_Output   === 'undefined') return;
        if (typeof Config_Manager !== 'undefined' && !Config_Manager.soundEnabled) return;
        try { await Audio_Output.Resume(); } catch (e) { /* silent */ }
    }, 300);
}

/* -------------------------------------------------------------
   AUDIO — init on the first user gesture
   ------------------------------------------------------------- */
// Audio init is triggered by a click on #btn-sound (bindGameHeader) or
// automatically through bindSoundButton() in Emulator_Setup.js.

/* -------------------------------------------------------------
   MEDIA FILE LOADING VIA XHR
   ------------------------------------------------------------- */

/**
 * Fetches a binary file and reports the progress.
 * @param {string}   url       File URL.
 * @param {Function} onSuccess Callback(Uint8Array).
 * @param {Function} onError   Callback(errorMessage).
 */
function fetchMedia(url, onSuccess, onError) {
    var xhr          = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';

    xhr.onprogress = function (e) {
        if (e.lengthComputable) {
            var pct = 60 + Math.round((e.loaded / e.total) * 30);
            setLoadingProgress(pct, 'Chargement du média : <span>' + Math.round(e.loaded / 1024) + ' Ko</span>');
        }
    };

    xhr.onload = function () {
        if (xhr.status === 200 || xhr.status === 0) {
            onSuccess(new Uint8Array(xhr.response));
        } else {
            onError('HTTP ' + xhr.status + ' lors du chargement de ' + url);
        }
    };

    xhr.onerror = function () {
        onError('Impossible de charger : ' + url);
    };

    xhr.send();
}

/* -------------------------------------------------------------
   MEDIA INSERTION INTO THE EMULATOR
   Called after hardReset() + init delay.
   ------------------------------------------------------------- */

/**
 * Inserts the media (DSK, SNA or CPR) into the emulator.
 * @param {string}    type     'disc' | 'snap' | 'cart'.
 * @param {Uint8Array} data    File binary content.
 * @param {string}    filename File name (without path).
 */
function insertMedia(type, data, filename) {
    setLoadingProgress(95, 'Insertion du média...');

    try {
        if (type === 'snap') {
            /* -- Snapshot .SNA ------------------------------------ */
            if (typeof SNA_Parser  === 'undefined') throw new Error('SNA_Parser unavailable');
            if (typeof Emulator_Core !== 'undefined') {
                Emulator_Core.pauseEmulator();
                Emulator_Core.reset();
            }
            SNA_Parser.parseFile(data);
            if (typeof Emulator_Core !== 'undefined') Emulator_Core.resumeEmulator();

        } else if (type === 'cart') {
            /* -- Cartridge .CPR (CPC+) ---------------------------- */
            var cprPath = 'AUTOLOAD/' + filename;
            window.files          = window.files || {};
            window.files[cprPath] = data;
            window.currentCprPath = cprPath;
            if (typeof Emulator_Core !== 'undefined') Emulator_Core.hardReset();

        } else {
            /* -- Disk .DSK ---------------------------------------- */
            if (typeof Floppy_Drive_A === 'undefined') throw new Error('Floppy_Drive_A unavailable');
            if (typeof DSK_Parser     === 'undefined') throw new Error('DSK_Parser unavailable');

            Floppy_Drive_A.diskImage = DSK_Parser.parseFile(data);

            // Sync the legacy UI
            var lblDrivea = document.getElementById('drivea-filename');
            if (lblDrivea) lblDrivea.textContent = filename;
            var ejectDrivea = document.getElementById('drivea-eject');
            if (ejectDrivea) {
                ejectDrivea.classList.remove('disabled-button');
                ejectDrivea.classList.add('button');
            }

            // Flash the Drive A LED
            var led = document.getElementById('drivea-led');
            if (led) {
                led.classList.add('active');
                setTimeout(function () { led.classList.remove('active'); }, 1000);
            }

            // -- AUTO-RUN -----------------------------------------
            var autoRunTarget = null;
            if (document.querySelector('#autorun-option')?.checked) {
                try {
                    var fileList   = DSK_Parser.getDirectory(Floppy_Drive_A.diskImage);
                    autoRunTarget  = (typeof getAutoRunTarget === 'function')
                        ? getAutoRunTarget(fileList, filename)
                        : null;
                    if (autoRunTarget) {
                        console.log('[game.js] AutoRun → ' + autoRunTarget);
                    } else {
                        console.warn('[game.js] AutoRun: no target found in the catalogue');
                    }
                } catch (e) {
                    console.warn('[game.js] AutoRun: catalogue scan error', e);
                }
            }

            setLoadingProgress(90, 'Attente du prompt BASIC...');
            setTimeout(function () {
                setLoadingProgress(98, 'Auto-Run...');
                if (autoRunTarget &&
                    typeof CPC_INPUT !== 'undefined' &&
                    CPC_INPUT.keyboard) {
                    CPC_INPUT.keyboard.autotype('RUN"' + autoRunTarget + '\r');
                }
                setTimeout(function () {
                    hideLoadingOverlay();
                    setStatus('En cours', 'running');
                }, 600);
            }, 2000);

            return; // The overlay is handled in the setTimeout above
        }

        // Snap / Cart / Boot: overlay closed quickly
        setLoadingProgress(100, 'Démarrage...');
        setTimeout(function () {
            hideLoadingOverlay();
            setStatus('En cours', 'running');
        }, 400);

    } catch (err) {
        console.error('[game.js] insertMedia error:', err);
        setLoadingProgress(100, '⚠ ' + err.message);
        setStatus('Erreur', 'error');
        setTimeout(hideLoadingOverlay, 2000);
    }
}

/* -------------------------------------------------------------
   MAIN SEQUENCE — DOM ready
   ------------------------------------------------------------- */
(function () {
    function demarrer() {

    /* -- 1. Global initialisation ------------------------------ */
    if (typeof window.files === 'undefined') window.files = {};

    /* -- 2. Detach the legacy buttons -------------------------- */
        // Detach the generic handlers; the reset handler is rebound here.
        // `UI_Manager.detach()` keeps the listener reference in UI_DOM.js
        // so that it can be removed.
        UI_Manager.detach('#button-run');
        UI_Manager.detach('#button-step');
        UI_Manager.detach('#button-stepover');
        UI_Manager.detach('#button-turbo');
        UI_Manager.detach('#checkbox-settings');
        UI_Manager.detach('#option-panel-overlay');
        UI_Manager.detach('#settings-close');

        var boutonReset = document.getElementById('button-reset');
        UI_Manager.detach('#button-reset');
        if (boutonReset) {
            boutonReset.addEventListener('click', function () {
        if (typeof Emulator_Core !== 'undefined') Emulator_Core.hardReset();
    });
        }

    // Legacy volume slider
    if (typeof Config_Manager !== 'undefined' && typeof Config_Manager.initVolumeSlider === 'function') {
        Config_Manager.initVolumeSlider();
    }

    // Legacy drives
    if (typeof attachDriveEvents === 'function') {
        try { attachDriveEvents(Floppy_Drive_B); } catch (e) { /* optional */ }
        try { attachDriveEvents(Tape_Recorder);  } catch (e) { /* optional */ }
    }

    /* -- 3. Real header buttons ------------------------------- */
    // Bindings moved to UI_DOM.js -> UI_Manager.bindGameHeader()
    UI_Manager.bindGameHeader();

    // Status pill sync (updated by Video_System.js)
    var _lastStatus = '';
    setInterval(function () {
            var s = document.getElementById('status')?.textContent;
        if (s && s !== _lastStatus) {
            _lastStatus = s;
            var stateClass = 'loading';
            if (s === 'Running' || s === 'En cours') stateClass = 'running';
            else if (s.toLowerCase().indexOf('erreur') >= 0) stateClass = 'error';
            else if (s === 'Prêt')                           stateClass = 'running';
                var pilule = document.getElementById('status-pill');
                if (pilule) pilule.className = 'status-pill ' + stateClass;
        }
    }, 300);

    /* -- 4. ROM loading ---------------------------------------- */
    var ROM_PATH   = 'ROM/';
    var lang       = (typeof getCookie === 'function') ? getCookie('firmware') : null;
    if (lang !== 'english' && lang !== 'french' && lang !== 'spanish') lang = 'english';

    /**
     * Returns the list of ROMs to load for the given model and language.
     * @param {string} machine  Boot identifier (e.g. 'boot_cpc6128').
     * @param {string} l        Language ('english' | 'french' | 'spanish').
     * @returns {string[]}
     */
    function getRoms(machine, l) {
        var p = ROM_PATH + l + '/';
        switch (machine) {
            case 'boot_cpc464':
            case 'boot_464plus':  return [p + '464.ROM',  p + 'BASIC1-0.ROM', ROM_PATH + 'AMSDOS_0.5.ROM'];
            case 'boot_cpc664':   return [p + '664.ROM',  p + 'BASIC1-1.ROM', ROM_PATH + 'AMSDOS_0.5.ROM'];
            case 'boot_6128plus':
            case 'boot_cpc6128':
            default:              return [p + '6128.ROM', p + 'BASIC1-1.ROM', ROM_PATH + 'AMSDOS_0.5.ROM'];
        }
    }

    var machineVal = (window._urlType === 'cart') ? 'boot_6128plus' : 'boot_cpc6128';
        if (window._urlType === 'cart') {
            var selecteurMachine = document.getElementById('snapshot');
            if (selecteurMachine) {
                selecteurMachine.value = 'boot_6128plus';
                selecteurMachine.dispatchEvent(new Event('change'));
            }
        }

    var romList    = getRoms(machineVal, lang);
    var romsLoaded = 0;

    setLoadingProgress(5, 'Chargement des ROMs...');
    setStatus('Chargement ROMs...', 'loading');

    function loadRom(path, cb) {
        var xhr          = new XMLHttpRequest();
        xhr.open('GET', path, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload  = function () {
            if (xhr.status === 200 || xhr.status === 0) {
                window.files[path] = new Uint8Array(xhr.response);
            }
            cb();
        };
        xhr.onerror = function () { cb(); };
        xhr.send();
    }

    function onRomLoaded() {
        romsLoaded++;
        var pct = Math.round((romsLoaded / romList.length) * 50);
        setLoadingProgress(pct, 'ROM ' + romsLoaded + '/' + romList.length + ' chargée...');

        if (romsLoaded >= romList.length) {
            setLoadingProgress(55, 'Démarrage du Z80...');
            setStatus('Démarrage...', 'loading');

            Emulator_Core.hardReset();

            /* -- 5. Media loading & insertion --------------------- */
            if (window._fullPath) {
                setLoadingProgress(60, 'Chargement : <span>' + window._urlFile + '</span>');
                fetchMedia(
                    window._fullPath,
                    function (data) {
                        setTimeout(function () {
                            insertMedia(window._urlType, data, window._urlFile);
                        }, 800);
                    },
                    function (errMsg) {
                        console.error('[game.js] Media error:', errMsg);
                        setLoadingProgress(100, '⚠ ' + errMsg);
                        setStatus('Erreur média', 'error');
                        setTimeout(function () {
                            hideLoadingOverlay();
                            setStatus('Boot BASIC', 'running');
                        }, 2500);
                    }
                );
            } else {
                // No file -> standard BASIC boot
                setTimeout(function () {
                    hideLoadingOverlay();
                    setStatus('Prêt', 'running');
                }, 1200);
            }
        }
    }

    for (var i = 0; i < romList.length; i++) {
        loadRom(romList[i], onRomLoaded);
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
