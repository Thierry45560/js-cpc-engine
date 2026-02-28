"use strict";

/**
 * @module RomLoader
 * @description ROM file loading for the web browser environment.
 *
 * Separation of concerns:
 *   ROM_Manager has no knowledge that a network exists.
 *   ROM data is injected via its neutral API:
 *     - `ROM_Manager.loadLowerRom(data)`
 *     - `ROM_Manager.loadUpperRom(slot, data)`
 *
 *   For a Node.js / Electron / Tauri port, replace this file with a
 *   RomLoader adapted to `fs.readFile`, IPC, etc. — Memory.js is untouched.
 *
 * Batch loading strategy — `fetch` + `Promise.all`:
 *   All ROM files are downloaded in parallel (HTTP/2 multiplexing).
 *   For three 16 KB ROMs at 30 ms each:
 *     Sequential (old): 30 + 30 + 30 = 90 ms
 *     Parallel  (new):  max(30, 30, 30) = 30 ms  (×3 faster)
 *
 *   The legacy `loadRomFile` (XHR) is kept for AppMain.loadInitialRoms()
 *   which requires individual completion callbacks.
 */

// =============================================================================
// ROM catalogue
// =============================================================================

/** Base path for all ROM files. @type {string} */
const ROM_PATH = 'ROM/';

/**
 * Maps ROM identifier strings to ROM_Manager slot numbers.
 * @type {{AMSDOS: number, BASIC: number}}
 */
const ROM_SLOT_MAP = {
    AMSDOS : 7,
    BASIC  : 0,
};

/**
 * Returns the list of ROM file paths to preload for a given machine model and language.
 * @param {string} machineVal - Machine identifier (e.g. `"boot_cpc6128"`).
 * @param {string} lang       - Firmware language: `"english"`, `"french"`, or `"spanish"`.
 * @returns {string[]} Ordered list of file paths.
 */
function getRomListForMachine(machineVal, lang) {
    const p = `${ROM_PATH}${lang}/`;
    switch (machineVal) {
        case 'boot_cpc464':
            return [`${p}464.ROM`, `${p}BASIC1-0.ROM`, `${ROM_PATH}AMSDOS_0.5.ROM`];
        case 'boot_cpc664':
            return [`${p}664.ROM`, `${p}BASIC1-1.ROM`, `${ROM_PATH}AMSDOS_0.5.ROM`];
        case 'boot_464plus':
            return [`${p}464.ROM`, `${p}BASIC1-0.ROM`, `${ROM_PATH}AMSDOS_0.5.ROM`];
        case 'boot_6128plus':
        case 'boot_cpc6128':
        default:
            return [`${p}6128.ROM`, `${p}BASIC1-1.ROM`, `${ROM_PATH}AMSDOS_0.5.ROM`];
    }
}

/**
 * Classifies a ROM file path as lower ROM or an upper ROM slot.
 * Classification is based on the filename:
 *   - Contains "AMSDOS" → upper ROM slot 7
 *   - Contains "BASIC"  → upper ROM slot 0
 *   - Otherwise         → lower ROM (OS)
 * @param {string} path - File path.
 * @returns {'lower' | {slot: number}}
 */
function _classifyRom(path) {
    const file = path.split('/').pop();
    if (file.includes('AMSDOS')) return { slot: ROM_SLOT_MAP.AMSDOS };
    if (file.includes('BASIC'))  return { slot: ROM_SLOT_MAP.BASIC  };
    return 'lower';
}

/**
 * Injects a loaded ROM binary into ROM_Manager using its classification.
 * @param {string}    path - Source file path (used for classification only).
 * @param {Uint8Array} data - Binary ROM contents.
 */
function _injectRom(path, data) {
    const cls = _classifyRom(path);
    if (cls === 'lower') {
        ROM_Manager.loadLowerRom(data);
    } else {
        ROM_Manager.loadUpperRom(cls.slot, data);
    }
}


// =============================================================================
// Individual XHR loader — kept for backward compatibility with AppMain
// =============================================================================

/**
 * Loads a single ROM file via XMLHttpRequest, caches it in `window.files`,
 * injects it into ROM_Manager, then calls `callback`.
 * If the file is already cached, injection and callback happen synchronously.
 * @param {string}   path     - Relative path to the ROM file.
 * @param {Function} callback - Called with no arguments when the file is ready.
 */
function loadRomFile(path, callback) {
    window.files = window.files || {};

    if (window.files[path]) {
        _injectRom(path, window.files[path]);
        callback();
        return;
    }

    const req = new XMLHttpRequest();
    req.open('GET', path, true);
    req.responseType = 'arraybuffer';
    req.onload = function () {
        if (req.status === 200 || req.status === 0) {
            const data = new Uint8Array(req.response);
            window.files[path] = data;
            _injectRom(path, data);
        } else {
            console.error(`[RomLoader] Load failed: ${path} (HTTP ${req.status})`);
        }
        callback();
    };
    req.onerror = function () {
        console.error(`[RomLoader] Network error: ${path}`);
        callback();
    };
    req.send();
}


// =============================================================================
// Parallel batch loader — fetch + Promise.all
// =============================================================================

/**
 * Loads a single ROM file via the Fetch API.
 * Resolves immediately (microtask) if the file is already in `window.files`.
 * Errors are caught and logged; the Promise always resolves so that
 * `Promise.all` in `loadRomFiles` is never rejected by a single failure.
 * @param {string} path - Relative path to the ROM file.
 * @returns {Promise<void>}
 */
function _fetchRomFile(path) {
    window.files = window.files || {};

    if (window.files[path]) {
        _injectRom(path, window.files[path]);
        return Promise.resolve();
    }

    return fetch(path)
        .then(response => {
            if (!response.ok) {
                throw new Error(`[RomLoader] HTTP ${response.status}: ${path}`);
            }
            return response.arrayBuffer();
        })
        .then(buffer => {
            const data = new Uint8Array(buffer);
            window.files[path] = data;
            _injectRom(path, data);
        })
        .catch(err => {
            console.error(`[RomLoader] Could not load: ${path}`, err);
        });
}

/**
 * Downloads all ROM files in `paths` in parallel via `fetch` + `Promise.all`,
 * then calls `onComplete` once every file has been injected into ROM_Manager.
 *
 * Advantage over the legacy sequential approach:
 *   All downloads start simultaneously on a single TCP connection (HTTP/2).
 *   Typical improvement: ×2–×3 faster startup depending on network latency.
 *
 * @param {string[]} paths      - List of ROM file paths to download.
 * @param {Function} onComplete - Called when all files are ready.
 */
function loadRomFiles(paths, onComplete) {
    if (paths.length === 0) {
        onComplete();
        return;
    }

    Promise.all(paths.map(_fetchRomFile))
        .then(onComplete)
        .catch(err => {
            console.error('[RomLoader] Unexpected error in Promise.all', err);
            onComplete();
        });
}
