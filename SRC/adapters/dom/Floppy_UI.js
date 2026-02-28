/**
 * @file Floppy_UI.js
 * @module Floppy_UI
 *
 * DOM-facing floppy drive UI for the JS CPC emulator.
 * Handles DSK image uploads, AMSDOS directory display, blank disk creation,
 * disk saving (download), and AutoRun target heuristics.
 *
 * Load order in index.html:
 *   1. DSK_Parser.js      — binary DSK parsing
 *   2. FDC_Controller.js  — µPD765 + Floppy_Drive_A / Floppy_Drive_B
 *   3. Floppy_UI.js       — this file: upload + DOM bindings
 *
 * External globals consumed:
 *   DSK_Parser, Floppy_Drive_A, Floppy_Drive_B,
 *   Emulator_Core, TapeController, AutoType (optional), window.files, jQuery ($)
 */

"use strict";

// ---------------------------------------------------------------------------
// Blank disk generation and mounting
// ---------------------------------------------------------------------------

/**
 * Generates a standard blank AMSDOS DSK image in memory.
 *
 * Format: 80 tracks, 1 side, 9 sectors × 512 bytes per track.
 * Sector IDs follow the AMSDOS convention: 0xC1–0xC9.
 * All data bytes are initialised to 0xE5 (standard CP/M empty byte).
 *
 * Layout:
 *   - Bytes   0–255 : DSK file header ("MV - CPCEMU Disk-File…")
 *   - Bytes 256–end : sequential track blocks, each 256 (track header)
 *                     + 9 × 512 (sector data) = 4 864 bytes
 *
 * @returns {Uint8Array} Raw DSK image buffer.
 */
function createBlankDSK() {
    const TRACKS       = 80;
    const SIDES        = 1;
    const SECTORS      = 9;
    const SECTOR_BYTES = 512;
    const TRACK_HDR    = 256;
    const TRACK_DATA   = SECTORS * SECTOR_BYTES;
    const TRACK_TOTAL  = TRACK_HDR + TRACK_DATA;
    const DSK_HDR      = 256;

    const buf = new Uint8Array(DSK_HDR + TRACKS * TRACK_TOTAL);
    const dv  = new DataView(buf.buffer);

    const dskSig = 'MV - CPCEMU Disk-File\r\nDisk-Info\r\n';
    for (let i = 0; i < dskSig.length; i++) buf[i] = dskSig.charCodeAt(i);
    const creator = 'JS CPC        ';
    for (let i = 0; i < creator.length; i++) buf[34 + i] = creator.charCodeAt(i);
    buf[48] = TRACKS;
    buf[49] = SIDES;
    dv.setUint16(50, TRACK_TOTAL, true);

    for (let t = 0; t < TRACKS; t++) {
        const to     = DSK_HDR + t * TRACK_TOTAL;
        const trkSig = 'Track-Info\r\n\x00';
        for (let i = 0; i < 13; i++) buf[to + i] = trkSig.charCodeAt(i);

        buf[to + 16] = t;   // track number
        buf[to + 17] = 0;   // side number
        buf[to + 20] = 2;   // sector size code (2 = 512 bytes)
        buf[to + 21] = SECTORS;
        buf[to + 22] = SECTORS;
        buf[to + 23] = 0x4E; // gap length

        for (let s = 0; s < SECTORS; s++) {
            const si = to + 24 + s * 8;
            buf[si]     = t;
            buf[si + 1] = 0;
            buf[si + 2] = 0xC1 + s; // AMSDOS sector ID (C1–C9)
            buf[si + 3] = 2;
            buf[si + 4] = 0;
            buf[si + 5] = 0;
            dv.setUint16(si + 6, SECTOR_BYTES, true);
        }

        buf.fill(0xE5, to + TRACK_HDR, to + TRACK_TOTAL);
    }
    return buf;
}

/**
 * Prompts the user for a disk name, generates a blank DSK image,
 * and mounts it on the given drive object.
 *
 * @param {Object} drive       - Emulator drive descriptor (Floppy_Drive_A or _B).
 * @param {string} filenameLbl - DOM element ID that displays the disk name.
 * @param {string} ejectId     - DOM element ID of the eject button.
 * @returns {void}
 */
function mountBlankDSK(drive, filenameLbl, ejectId) {
    let name = prompt("Nom de la nouvelle disquette :", "ma_disquette");
    if (name === null) return;
    if (!name.toLowerCase().endsWith(".dsk")) name += ".dsk";

    const dskData = createBlankDSK();
    drive.diskImage      = DSK_Parser.parseFile(dskData);
    drive.writeProtected = false;
    drive.MediaIn        = true;
    drive.isDirty        = false;
    drive.fileName       = name;

    $(`#${filenameLbl}`).text(name + " (Vierge)");
    $(`#${ejectId}`).removeClass('disabled-button').addClass('button');
}


// ---------------------------------------------------------------------------
// Disk saving (download)
// ---------------------------------------------------------------------------

/**
 * Serialises the current in-memory DSK image back to the standard CPCEMU
 * format and triggers a browser download.
 *
 * The produced binary mirrors the MV-CPCEMU Disk-File structure:
 *   - 256-byte file header
 *   - One 256-byte track header per track, followed by sector data
 *
 * After the download the drive's dirty flag is cleared.
 *
 * @param {Object} drive - Emulator drive descriptor with a valid `diskImage`.
 * @returns {void}
 */
function downloadDisk(drive) {
    if (!drive.diskImage) return;

    const dsk       = drive.diskImage;
    const TRACKS    = dsk.numTracks;
    const SIDES     = dsk.numSides;
    const trackSize = 256 + (9 * 512);
    const totalSize = 256 + (TRACKS * SIDES * trackSize);

    const buf = new Uint8Array(totalSize);
    const dv  = new DataView(buf.buffer);

    const sig = "MV - CPCEMU Disk-File\r\nDisk-Info\r\n";
    for (let i = 0; i < sig.length; i++) buf[i] = sig.charCodeAt(i);
    buf[48] = TRACKS;
    buf[49] = SIDES;
    dv.setUint16(50, trackSize, true);

    let offset = 256;
    for (let t = 0; t < TRACKS; t++) {
        for (let s = 0; s < SIDES; s++) {
            const track   = dsk.trackData[t][s];
            if (!track) continue;

            const tOffset = offset;
            const tSig    = "Track-Info\r\n";
            for (let i = 0; i < tSig.length; i++) buf[tOffset + i] = tSig.charCodeAt(i);

            buf[tOffset + 16] = t;
            buf[tOffset + 17] = s;
            buf[tOffset + 20] = 2;
            buf[tOffset + 21] = track.sectors.length;
            buf[tOffset + 22] = 0x4E;

            track.sectors.forEach((sec, idx) => {
                const si = tOffset + 24 + (idx * 8);
                buf[si]     = sec.trackId;
                buf[si + 1] = sec.sideId;
                buf[si + 2] = sec.id;
                buf[si + 3] = sec.size;
                buf[si + 4] = sec.st1;
                buf[si + 5] = sec.st2;
                dv.setUint16(si + 6, 512, true);
                buf.set(sec.data[0], tOffset + 256 + (idx * 512));
            });
            offset += trackSize;
        }
    }

    const blob = new Blob([buf], { type: "application/octet-stream" });
    const url  = window.URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = drive.fileName;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
    drive.isDirty = false;
}


// ---------------------------------------------------------------------------
// Upload and directory display
// ---------------------------------------------------------------------------

/**
 * Reads a DSK file chosen by the user, parses it, mounts it on the given
 * drive, refreshes the on-screen directory listing, and optionally triggers
 * AutoRun if the corresponding UI option is checked.
 *
 * @param {File}   file      - File object selected via an <input type="file">.
 * @param {Object} drive     - Emulator drive descriptor.
 * @param {string} labelId   - DOM element ID displaying the disk file name.
 * @param {string} ejectId   - DOM element ID of the eject button.
 * @param {string} displayId - DOM element ID of the directory listing container.
 * @returns {void}
 */
function handleDiskUpload(file, drive, labelId, ejectId, displayId) {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        const data       = new Uint8Array(e.target.result);
        const parsedDisk = DSK_Parser.parseFile(data);
        if (!parsedDisk) return;

        drive.diskImage = parsedDisk;
        $(`#${labelId}`).text(file.name);
        $(`#${ejectId}`).removeClass('disabled-button').addClass('button');

        const fileList = DSK_Parser.getDirectory(drive.diskImage);
        updateDiskDisplay(drive, displayId);

        if ($('#autorun-option').is(':checked')) {
            const target = getAutoRunTarget(fileList, file.name);
            if (target) {
                console.log(`[Floppy] AutoRun → ${target}`);
                setTimeout(function () {
                    if (window.AutoType) {
                        window.AutoType.inject(`RUN"${target}\r`);
                    } else {
                        console.error('[Floppy] AutoType not available');
                    }
                }, 1000);
            }
        }
    };
    reader.readAsArrayBuffer(file);
}

/**
 * Renders the AMSDOS directory of a mounted disk inside a DOM container.
 * Hides the container when no disk is inserted or the directory is empty.
 *
 * @param {Object} drive       - Emulator drive descriptor.
 * @param {string} containerId - DOM element ID of the directory listing container.
 * @returns {void}
 */
function updateDiskDisplay(drive, containerId) {
    const $container = $(`#${containerId}`);
    if (!drive.diskImage) { $container.hide(); return; }

    const fileList = DSK_Parser.getDirectory(drive.diskImage);

    if (fileList.length === 0) {
        $container.html('<div class="tape-analyzing">Catalogue vide ou inconnu</div>').show();
        return;
    }

    const html = fileList.map(f => `
        <div class="tape-prog-item">
            <i class="fas fa-file-code" style="font-size:10px; opacity:0.6"></i>
            <span class="prog-name">${f.name}</span>
            <span class="prog-type" style="background:#444">${f.type}</span>
        </div>
    `).join('');

    $container.html(html).show();
}


// ---------------------------------------------------------------------------
// AutoRun heuristics
// ---------------------------------------------------------------------------

/**
 * Determines which file on a DSK should be launched automatically.
 *
 * Priority order (highest to lowest):
 *   1. Special-case: file named 'AAAAA' → returns 'PRINCE.BAS'
 *   2. Special-case: file named '(*'    → returns 'DISC'
 *   3. File named exactly 'DISC'
 *   4. File whose base name matches the DSK filename, extension .BAS
 *   5. Same match, extension .BIN
 *   6. Same match, no extension
 *   7. File whose base name starts with the first 4 chars of the DSK name, ext .BAS
 *   8. Same prefix match, no extension
 *   9. Same prefix match, ext .BIN
 *  10. Only one .BAS file on disk
 *  11. Only one .BIN file on disk
 *  12. Only one file on disk at all
 *
 * @param {Object[]} files       - Directory entries from DSK_Parser.getDirectory().
 * @param {string}   dskFilename - File name of the loaded DSK (used for prefix matching).
 * @returns {string|null} Name of the file to auto-run, or null if undetermined.
 */
function getAutoRunTarget(files, dskFilename) {
    if (!files || files.length === 0) return null;

    const dskBase    = dskFilename.split('.')[0].toUpperCase().substring(0, 8);
    const dskPrefix4 = dskBase.substring(0, 4);

    const list = files.map(f => {
        const parts = f.name.toUpperCase().split('.');
        return { full: f.name.toUpperCase(), name: parts[0], ext: parts[1] || '' };
    });

	const prince     = list.find(f => f.name === 'AAAAA');
    if (prince )     return 'PRINCE.BAS';
	const rainbow    = list.find(f => f.name === '(*');
    if (rainbow)     return 'DISC';
    const disc       = list.find(f => f.name === 'DISC');
    if (disc)        return disc.name;
    const exactBas   = list.find(f => f.name === dskBase && f.ext === 'BAS');
    if (exactBas)    return exactBas.name;
    const exactBin   = list.find(f => f.name === dskBase && f.ext === 'BIN');
    if (exactBin)    return exactBin.name;
    const exactNoExt = list.find(f => f.name === dskBase && f.ext === '');
    if (exactNoExt)  return exactNoExt.name;
    const prefBas    = list.find(f => f.name.startsWith(dskPrefix4) && f.ext === 'BAS');
    if (prefBas)     return prefBas.name;
    const prefNoExt  = list.find(f => f.name.startsWith(dskPrefix4) && f.ext === '');
    if (prefNoExt)   return prefNoExt.name;
    const prefBin    = list.find(f => f.name.startsWith(dskPrefix4) && f.ext === 'BIN');
    if (prefBin)     return prefBin.name;

    const onlyBas = list.filter(f => f.ext === 'BAS');
    if (onlyBas.length === 1) return onlyBas[0].name;
    const onlyBin = list.filter(f => f.ext === 'BIN');
    if (onlyBin.length === 1) return onlyBin[0].name;
    if (list.length === 1)    return list[0].name;

    return null;
}


// ---------------------------------------------------------------------------
// DOM initialisation — delegates to UI_Manager
// ---------------------------------------------------------------------------

$(document).ready(function () {
    UI_Manager.bindFloppyDrives();
});
