"use strict";

/**
 * @module DSK_Parser
 * @description Parser for Amstrad CPC floppy disk images in Standard and Extended DSK formats.
 *
 * Extracted from the monolithic Floppy.js to follow the Single Responsibility Principle:
 *   - DSK_Parser.js     → binary parsing only, no DOM dependency (this file)
 *   - FDC_Controller.js → µPD765 FDC emulation, depends on DSK_Parser
 *   - Floppy_UI.js      → HTML5 upload, AMSDOS catalogue, jQuery bindings
 *
 * Supported formats:
 *   - Standard  ("MV - CPCEMU" / "MV - CPC Disk-File")
 *     Fixed track size encoded in bytes 50–51 of the disk header.
 *   - Extended  ("EXTENDED CPC DSK File" / "EXTENDED Disk-File")
 *     Variable track size encoded per track/side in the header table (offset 52+).
 *
 * Dependencies: `bytesToString`, `read16bitLE`, `Config_Manager.debugMode` (globals).
 * No jQuery or DOM dependency.
 */

/**
 * Global binary file cache shared across all modules.
 * Key = relative path (string), value = Uint8Array.
 * Must remain `var` (not const/let) so that `window.files` is the same object
 * regardless of which script access it first.
 * @type {Object.<string, Uint8Array>}
 */
var files = {};


/**
 * @namespace DSK_Parser
 */
const DSK_Parser = {

    /**
     * Parses a complete DSK file into an in-memory disk structure.
     *
     * The returned object mirrors the physical layout of the disk:
     *   `trackData[trackNumber][sideNumber]` → track descriptor with sector array.
     *
     * @param {Uint8Array} data - Raw binary contents of the DSK file.
     * @returns {{creatorName:string, numTracks:number, numSides:number, trackData:Array}|null}
     *   Disk descriptor object, or `null` on fatal header errors.
     */
    parseFile(data) {
        const header = bytesToString(data, 0, 34);
        let isExtended;

        if (header.startsWith("MV - CPCEMU") || header.startsWith("MV - CPC Disk-File")) {
            isExtended = false;
        } else if (header.startsWith("EXTENDED CPC DSK File") || header.startsWith("EXTENDED Disk-File")) {
            isExtended = true;
        } else {
            alert("[DSK Parser] Error: Invalid DSK id");
            return null;
        }

        const dsk = {
            creatorName: bytesToString(data, 34, 20),
            numTracks  : data[48],
            numSides   : data[49],
            trackData  : []
        };

        if (dsk.numTracks === 0) { alert("[DSK Parser] Error: Invalid DSK Trackcount"); return null; }
        if (dsk.numSides  === 0) { alert("[DSK Parser] Error: Invalid DSK Sidecount");  return null; }

        let offset    = 256;
        let fixedSize = isExtended ? 0 : read16bitLE(data, 50);

        for (let track = 0; track < dsk.numTracks; track++) {
            dsk.trackData[track] = [];

            for (let side = 0; side < dsk.numSides; side++) {
                const trackSize = isExtended
                    ? (data[track * dsk.numSides + side + 52] << 8)
                    : fixedSize;

                if (trackSize !== 0) {
                    const parsed = DSK_Parser.parseTrack(data, isExtended, offset);
                    if (parsed === false) return dsk;
                    dsk.trackData[track][side] = parsed;
                }
                offset += trackSize;
            }
        }
        return dsk;
    },

    /**
     * Parses a single Track-Info block.
     *
     * Each track block starts with the 12-byte magic "Track-Info\r\n".
     * The sector descriptor table follows at offset +24, with 8 bytes per sector.
     * Actual sector data begins at offset +256 (or +512 for tracks with >29 sectors).
     *
     * @param {Uint8Array} data       - Full DSK binary.
     * @param {boolean}    isExtended - True for Extended DSK format.
     * @param {number}     offset     - Byte offset of the Track-Info block.
     * @returns {{trackNumber?:number, sideNumber?:number, sectorSize?:number,
     *            numSectors:number, gap3Length:number, sectors:Array}|false}
     *   Track descriptor, or `false` if the magic signature is missing.
     */
    parseTrack(data, isExtended, offset) {
        if (bytesToString(data, offset, 12) !== "Track-Info\r\n") {
            return false;
        }

        const track = {};
        if (isExtended) {
            track.trackNumber = data[offset + 18];
            track.sideNumber  = data[offset + 19];
        } else {
            track.sectorSize = data[offset + 20] & 7;
        }
        track.numSectors = data[offset + 22];
        track.gap3Length = data[offset + 23];

        const declaredSectors = data[offset + 21];
        track.sectors = new Array(declaredSectors);

        let dataOffset = offset + (declaredSectors > 29 ? 512 : 256);

        for (let s = 0; s < declaredSectors; s++) {
            const sectorInfoOffset = offset + 24 + 8 * s;
            track.sectors[s] = DSK_Parser.parseSector(data, isExtended, sectorInfoOffset, dataOffset);

            dataOffset += isExtended
                ? track.sectors[s].data[0].length * track.sectors[s].data.length
                : Math.pow(2, 7 + track.sectorSize);
        }
        return track;
    },

    /**
     * Parses an 8-byte sector descriptor and extracts the associated sector data.
     *
     * In Extended DSK format, the declared size field (bytes 6–7 of the descriptor)
     * can indicate multiple "weak" copies of the same sector — a copy-protection technique
     * where successive reads return different data. Each copy is stored as a separate entry
     * in `sector.data`.
     *
     * @param {Uint8Array} data        - Full DSK binary.
     * @param {boolean}    isExtended  - True for Extended DSK format.
     * @param {number}     infoOffset  - Byte offset of the 8-byte sector descriptor.
     * @param {number}     dataOffset  - Byte offset of the sector payload in the track block.
     * @returns {{readOffset:number, trackId:number, sideId:number, id:number,
     *            size:number, st1:number, st2:number, data:Uint8Array[]}} Sector descriptor.
     */
    parseSector(data, isExtended, infoOffset, dataOffset) {
        const sector = {
            readOffset: 0,
            trackId   : data[infoOffset],
            sideId    : data[infoOffset + 1],
            id        : data[infoOffset + 2],
            size      : data[infoOffset + 3],
            st1       : data[infoOffset + 4],
            st2       : data[infoOffset + 5]
        };

        let sectorBytes = Math.pow(2, 7 + (sector.size & 7));
        let numCopies   = 1;

        if (isExtended) {
            const declaredSize = read16bitLE(data, infoOffset + 6);
            if (declaredSize === 0) {
                if (Config_Manager.debugMode) {
                    console.log(`[DSK Parser] Warning: No data in Track#${sector.trackId} Sector 0x${toHex8(sector.id)}`);
                }
            } else if (declaredSize % sectorBytes === 0) {
                numCopies = declaredSize / sectorBytes;
                if (numCopies !== 1 && Config_Manager.debugMode) {
                    console.log(`[DSK Parser] Warning: Track#${sector.trackId} Sector 0x${toHex8(sector.id)} has ${numCopies} weak copies`);
                }
            } else {
                sectorBytes = declaredSize;
            }
        }

        sector.data = new Array(numCopies);
        for (let c = 0; c < numCopies; c++) {
            const start = dataOffset + c * sectorBytes;
            sector.data[c] = data.slice(start, start + sectorBytes);
        }

        return sector;
    },

    /**
     * Scans the AMSDOS directory on a parsed DSK image.
     *
     * Tries three standard sector ID ranges in order:
     *   - Data format:   sectors 0xC1–0xC9 on track 0, side 0
     *   - System format: sectors 0x41–0x49 on track 0, side 0
     *   - IBM format:    sectors 0x01–0x09 on track 0, side 0
     *
     * Each 32-byte directory entry contains an 8.3 filename.
     * Only entries with extent = 0 and a non-empty name are returned
     * (to avoid duplicate entries for multi-extent files).
     *
     * @param {Object} dsk - Disk descriptor returned by {@link DSK_Parser.parseFile}.
     * @returns {{name:string, type:string}[]} List of file entries on the disk.
     */
    getDirectory(dsk) {
        if (!dsk || !dsk.trackData) return [];

        const fileList = {};

        const formats = [
            { trk: 0, min: 0xC1, max: 0xC9 },
            { trk: 0, min: 0x41, max: 0x49 },
            { trk: 0, min: 0x01, max: 0x09 },
        ];

        for (const fmt of formats) {
            const track = (dsk.trackData[fmt.trk]) ? dsk.trackData[fmt.trk][0] : null;
            if (!track) continue;

            track.sectors.forEach(sector => {
                if (sector.id >= fmt.min && sector.id <= fmt.max) {
                    const data = sector.data[0];
                    if (!data) return;

                    for (let i = 0; i < data.length; i += 32) {
                        const user = data[i];
                        if (user > 15) continue;
                        if ((data[i + 10] & 0x80) !== 0) continue;

                        let name = "";
                        for (let j = 1; j <= 8; j++) {
                            const c = data[i + j] & 0x7F;
                            if (c > 32) name += String.fromCharCode(c);
                        }

                        let ext = "";
                        for (let j = 9; j <= 11; j++) {
                            const c = data[i + j] & 0x7F;
                            if (c > 32) ext += String.fromCharCode(c);
                        }

                        const fullName = name + "." + ext;
                        const extent   = data[i + 12];

                        if (extent === 0 && name.trim().length > 0) {
                            fileList[fullName] = {
                                name: fullName,
                                type: this.guessFileType(ext)
                            };
                        }
                    }
                }
            });

            if (Object.keys(fileList).length > 0) break;
        }

        return Object.values(fileList);
    },

    /**
     * Infers a human-readable file type label from a three-character extension.
     * @param {string} ext - File extension (case-insensitive).
     * @returns {string} Type label: "BASIC", "Binary", "Image", or "File".
     */
    guessFileType(ext) {
        const e = ext.toUpperCase();
        if (e === 'BAS') return 'BASIC';
        if (e === 'BIN') return 'Binary';
        if (e === 'SCR' || e === 'WIN') return 'Image';
        return 'File';
    },
};
