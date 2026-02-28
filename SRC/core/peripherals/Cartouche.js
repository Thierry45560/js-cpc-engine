"use strict";

/**
 * @module CPR_Parser
 * @description Parser for Amstrad CPC+ cartridge files (.CPR, RIFF format).
 *
 * CPR RIFF structure:
 *   Offset 0  : "RIFF" (4 bytes, ASCII)
 *   Offset 4  : file size − 8 (32-bit LE)
 *   Offset 8  : "AMS!" (4 bytes, chunk type)
 *   Offset 12 : optional "fmt " chunk (20 bytes of metadata)
 *   Offset 12 or 32: N × "cbXX" chunks, each containing 16 384 bytes of ROM data
 *                    (XX = decimal ROM index 00–31)
 *
 * Each chunk is loaded directly into ROM_Manager.upperRoms[romIndex].
 */
const CPR_Parser = {

    /**
     * Parses a full CPR file and loads all ROM chunks into ROM_Manager.
     * Validates the RIFF header, file size, and AMS! type signature.
     * Skips the optional "fmt " metadata chunk if present.
     * @param {Uint8Array} data - Raw binary contents of the CPR file.
     * @returns {boolean|undefined} `false` on header validation failure; undefined on success.
     */
    parseFile(data) {
        if (bytesToString(data, 0, 4) !== "RIFF") {
            alert("[CPR Parser] Error: Invalid CPR id"); return false;
        }
        if (read32bitLE(data, 4) + 8 !== data.length) {
            alert("[CPR Parser] Error: Invalid CPR filesize"); return false;
        }
        if (bytesToString(data, 8, 4) !== "AMS!") {
            alert("[CPR Parser] Error: Invalid CPR format"); return false;
        }

        let offset = (bytesToString(data, 12, 4) === "fmt ") ? 20 : 12;

        for (let i = 0; i <= 31; i++) ROM_Manager.upperRoms[i] = null;

        while (offset < data.length) {
            const chunkSize = CPR_Parser.parseCprChunk(data, offset);
            if (chunkSize === false) break;
            offset += chunkSize + 8;
        }
    },

    /**
     * Parses one "cbXX" ROM chunk and registers it in ROM_Manager.upperRoms.
     * Validates the chunk ID prefix, ROM index range (0–31), and fixed size (16 384 bytes).
     * @param {Uint8Array} data   - Full CPR file binary.
     * @param {number}     offset - Byte offset of the chunk header within `data`.
     * @returns {number|false} Payload size (16 384) on success, or `false` on error.
     */
    parseCprChunk(data, offset) {
        const chunkId = bytesToString(data, offset, 4);

        if (chunkId.substring(0, 2) !== "cb") {
            alert("[CPR Parser] Error: Invalid rom chunk"); return false;
        }

        const romIndex = parseInt(chunkId.substring(2, 4), 10);
        if (romIndex < 0 || romIndex > 31) {
            alert("[CPR Parser] Error: Invalid rom id"); return false;
        }

        const romSize = read32bitLE(data, offset + 4);
        if (romSize !== 16384) {
            alert("[CPR Parser] Error: Invalid rom size"); return false;
        }

        const dataStart = offset + 8;
        ROM_Manager.upperRoms[romIndex] = data.subarray(dataStart, dataStart + 16384);
        return romSize;
    }
};


/**
 * @namespace Cart_Drive
 * @description CPC+ cartridge slot descriptor, used by the generic drive/media system.
 * Mapped to the "cart" drive in the UI.
 */
const Cart_Drive = {
    /** Drive identifier used by the UI. @type {string} */
    name:            "cart",
    /** Accepted file extensions. @type {string[]} */
    validExtensions: ["cpr"],
    /** Parser function reference. @type {Function} */
    parserFunc:      CPR_Parser.parseFile,
    /** Currently mounted archive object (zip). @type {Object|null} */
    archiveObj:      null,
    /** Currently mounted disk image. @type {Object|null} */
    diskImage:       null,
};


$(document).ready(function () {
    UI_Manager.bindCartridge();
});
