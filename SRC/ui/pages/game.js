/**
 * @file        game.js
 * @description Logique de la page de jeu — Lecture des paramètres d'URL,
 *              chargement des ROMs, insertion du média et gestion de l'UI
 *              (overlay de chargement, boutons header, son, joystick, plein écran).
 * @author      Thierry MAIGNAN
 * @project     JS CPC V2 — L'Amstrad dans votre Navigateur
 * @depends     jQuery, Emulator_Core, CPU_Z80, Audio_Output, Config_Manager,
 *              DSK_Parser, SNA_Parser, Floppy_Drive_A, AutoType, Keyboard_Manager
 */

'use strict';

/* ─────────────────────────────────────────────────────────────
   STUB — launch_debugger()
   Requis par Emulator_Core ; le débogueur est désactivé sur game.html.
   ───────────────────────────────────────────────────────────── */
function launch_debugger() {
    try {
        if (typeof CPU_Z80 !== 'undefined') CPU_Z80.updateUI();
    } catch (e) { /* silencieux */ }
}

/* ─────────────────────────────────────────────────────────────
   RÉPERTOIRES PAR TYPE DE MÉDIA
   ───────────────────────────────────────────────────────────── */
var MEDIA_DIRS = {
    disc: '/DSK/',
    snap: '/SNA/',
    cart: '/CPR/'
};

/* ─────────────────────────────────────────────────────────────
   LECTURE DES PARAMÈTRES D'URL
   Nouveau format : ?disc=X | ?snap=X | ?cart=X
   Ancien format  : ?type=disc&file=X  (rétrocompatibilité)
   ───────────────────────────────────────────────────────────── */
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

/* ── Affichage du nom du jeu dans le header ──────────────────── */
if (window._urlFile) {
    document.getElementById('game-name-display').textContent =
        window._urlFile.replace(/\.[^/.]+$/, '').replace(/[_\-]/g, ' ');
    document.title = 'JS CPC — ' + window._urlFile.replace(/\.[^/.]+$/, '');
} else {
    document.getElementById('game-name-display').textContent = 'Boot CPC';
    document.title = 'JS CPC - Démarrage';
}

/* ─────────────────────────────────────────────────────────────
   HELPERS — Barre de progression & statut
   ───────────────────────────────────────────────────────────── */

/**
 * Met à jour la barre de progression et son libellé.
 * @param {number} pct   Pourcentage (0-100).
 * @param {string} label Texte affiché (HTML autorisé).
 */
function setLoadingProgress(pct, label) {
    var bar = document.getElementById('loading-bar');
    var lbl = document.getElementById('loading-label');
    if (bar) bar.style.width = Math.min(100, pct) + '%';
    if (lbl) lbl.innerHTML   = label;
}

/**
 * Met à jour la pastille de statut dans le header.
 * @param {string} text  Texte à afficher.
 * @param {string} state Classe CSS : 'loading' | 'running' | 'error'.
 */
function setStatus(text, state) {
    var pill = document.getElementById('status-pill');
    var span = document.getElementById('status');
    if (span) span.textContent = text;
    if (pill) pill.className   = 'status-pill ' + (state || 'loading');
}

/**
 * Cache l'overlay de chargement et tente de démarrer l'audio.
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
        try { await Audio_Output.Resume(); } catch (e) { /* silencieux */ }
    }, 300);
}

/* ─────────────────────────────────────────────────────────────
   AUDIO — Init au premier geste utilisateur
   ───────────────────────────────────────────────────────────── */
// L'init audio est déclenchée par le clic sur #btn-sound (bindGameHeader)
// ou automatiquement via bindSoundButton() dans Emulator_Setup.js.
// Pas de one('click') séparé : évite la race condition double-init.

/* ─────────────────────────────────────────────────────────────
   CHARGEMENT D'UN FICHIER MÉDIA VIA XHR
   ───────────────────────────────────────────────────────────── */

/**
 * Récupère un fichier binaire et rapporte la progression.
 * @param {string}   url       URL du fichier.
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

/* ─────────────────────────────────────────────────────────────
   INSERTION DU MÉDIA DANS L'ÉMULATEUR
   Appelée après hardReset() + délai d'init.
   ───────────────────────────────────────────────────────────── */

/**
 * Insère le média (DSK, SNA ou CPR) dans l'émulateur.
 * @param {string}    type     'disc' | 'snap' | 'cart'.
 * @param {Uint8Array} data    Contenu binaire du fichier.
 * @param {string}    filename Nom du fichier (sans chemin).
 */
function insertMedia(type, data, filename) {
    setLoadingProgress(95, 'Insertion du média...');

    try {
        if (type === 'snap') {
            /* ── Snapshot .SNA ──────────────────────────────────── */
            if (typeof SNA_Parser  === 'undefined') throw new Error('SNA_Parser non disponible');
            if (typeof Emulator_Core !== 'undefined') {
                Emulator_Core.pauseEmulator();
                Emulator_Core.reset();
            }
            SNA_Parser.parseFile(data);
            if (typeof Emulator_Core !== 'undefined') Emulator_Core.resumeEmulator();

        } else if (type === 'cart') {
            /* ── Cartouche .CPR (CPC+) ──────────────────────────── */
            var cprPath = 'AUTOLOAD/' + filename;
            window.files          = window.files || {};
            window.files[cprPath] = data;
            window.currentCprPath = cprPath;
            if (typeof Emulator_Core !== 'undefined') Emulator_Core.hardReset();

        } else {
            /* ── Disquette .DSK ─────────────────────────────────── */
            if (typeof Floppy_Drive_A === 'undefined') throw new Error('Floppy_Drive_A non disponible');
            if (typeof DSK_Parser     === 'undefined') throw new Error('DSK_Parser non disponible');

            Floppy_Drive_A.diskImage = DSK_Parser.parseFile(data);

            // Synchronise l'UI fantôme
            $('#drivea-filename').text(filename);
            $('#drivea-eject').removeClass('disabled-button').addClass('button');

            // Flash LED Drive A
            var led = document.getElementById('drivea-led');
            if (led) {
                led.classList.add('active');
                setTimeout(function () { led.classList.remove('active'); }, 1000);
            }

            // ── AUTO-RUN ─────────────────────────────────────────
            var autoRunTarget = null;
            if ($('#autorun-option').is(':checked')) {
                try {
                    var fileList   = DSK_Parser.getDirectory(Floppy_Drive_A.diskImage);
                    autoRunTarget  = (typeof getAutoRunTarget === 'function')
                        ? getAutoRunTarget(fileList, filename)
                        : null;
                    if (autoRunTarget) {
                        console.log('[game.js] AutoRun → ' + autoRunTarget);
                    } else {
                        console.warn('[game.js] AutoRun : aucune cible trouvée dans le catalogue');
                    }
                } catch (e) {
                    console.warn('[game.js] AutoRun : erreur scan catalogue', e);
                }
            }

            setLoadingProgress(90, 'Attente du prompt BASIC...');
            setTimeout(function () {
                setLoadingProgress(98, 'Auto-Run...');
                if (autoRunTarget &&
                    typeof AutoType          !== 'undefined' &&
                    typeof Keyboard_Manager  !== 'undefined') {
                    AutoType.inject('RUN"' + autoRunTarget + '\r');
                }
                setTimeout(function () {
                    hideLoadingOverlay();
                    setStatus('En cours', 'running');
                }, 600);
            }, 2000);

            return; // L'overlay est géré dans le setTimeout ci-dessus
        }

        // Snap / Cart / Boot : overlay fermé rapidement
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

/* ─────────────────────────────────────────────────────────────
   SÉQUENCE PRINCIPALE — document.ready
   ───────────────────────────────────────────────────────────── */
$(document).ready(function () {

    /* ── 1. Initialisation des globaux ───────────────────────── */
    if (typeof window.files === 'undefined') window.files = {};

    /* ── 2. Neutralisation des boutons fantômes ─────────────── */
    // Détachement des handlers génériques — le reset est rebindé via UI_Manager
    $('#button-reset').off('click').on('click', function () {
        if (typeof Emulator_Core !== 'undefined') Emulator_Core.hardReset();
    });
    $('#button-run').off('click');
    $('#button-step').off('click');
    $('#button-stepover').off('click');
    $('#button-turbo').off('click');
    $('#checkbox-settings').off('click');
    $('#option-panel-overlay').off('click');
    $('#settings-close').off('click');

    // Volume slider fantôme
    if (typeof Config_Manager !== 'undefined' && typeof Config_Manager.initVolumeSlider === 'function') {
        Config_Manager.initVolumeSlider();
    }

    // Drives fantômes
    if (typeof attachDriveEvents === 'function') {
        try { attachDriveEvents(Floppy_Drive_B); } catch (e) { /* optionnel */ }
        try { attachDriveEvents(Tape_Recorder);  } catch (e) { /* optionnel */ }
    }

    /* ── 3. Boutons du header RÉEL ───────────────────────────── */
    // Bindings déplacés dans UI_DOM.js → UI_Manager.bindGameHeader()
    UI_Manager.bindGameHeader();

    // Synchronisation de la pastille de statut (mis à jour par Video_System.js)
    var _lastStatus = '';
    setInterval(function () {
        var s = $('#status').text();
        if (s && s !== _lastStatus) {
            _lastStatus = s;
            var stateClass = 'loading';
            if (s === 'Running' || s === 'En cours') stateClass = 'running';
            else if (s.toLowerCase().indexOf('erreur') >= 0) stateClass = 'error';
            else if (s === 'Prêt')                           stateClass = 'running';
            $('#status-pill').attr('class', 'status-pill ' + stateClass);
        }
    }, 300);

    /* ── 4. Chargement des ROMs ──────────────────────────────── */
    var ROM_PATH   = 'ROM/';
    var lang       = (typeof getCookie === 'function') ? getCookie('firmware') : null;
    if (lang !== 'english' && lang !== 'french' && lang !== 'spanish') lang = 'english';

    /**
     * Retourne la liste des ROMs à charger selon le modèle et la langue.
     * @param {string} machine  Identifiant boot (ex: 'boot_cpc6128').
     * @param {string} l        Langue ('english' | 'french' | 'spanish').
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
    if (window._urlType === 'cart') $('#snapshot').val('boot_6128plus').trigger('change');

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

            /* ── 5. Chargement & insertion du média ─────────────── */
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
                        console.error('[game.js] Erreur média :', errMsg);
                        setLoadingProgress(100, '⚠ ' + errMsg);
                        setStatus('Erreur média', 'error');
                        setTimeout(function () {
                            hideLoadingOverlay();
                            setStatus('Boot BASIC', 'running');
                        }, 2500);
                    }
                );
            } else {
                // Pas de fichier → boot BASIC standard
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

}); // fin document.ready
