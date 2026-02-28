/**
 * @module Snapshot
 * @description SNA snapshot format parser/serialiser and snapshot manager.
 *
 * Covers:
 *   - SNA_Parser       — parses .SNA files (v1, v2, v3 / CPC+) and serialises to v2
 *   - Snapshot_Manager — loads SNA from raw files or ZIP archives; handles capture
 *   - DOM bindings     — delegated to UI_Manager.bindSnapshot()
 *
 * SNA format summary:
 *   v1: 256-byte header + 64 KB RAM dump
 *   v2: v1 + Machine_Type field + optional chunks
 *   v3: v2 + FDC / CRTC / ASIC state + extended counters + optional chunks
 *   Chunks follow the RAM at offset 256+dumpSize; only "CPC+" is currently parsed.
 *
 * Global dependencies: Emulator_Core, launch_debugger, JSZip, jQuery ($)
 */

"use strict";

/**
 * @namespace SNA_Parser
 * @description Parses and serialises Amstrad CPC .SNA snapshot files.
 *
 * The SNA file layout:
 *   Offset   0 –   7  Magic "MV - SNA"
 *   Offset  16       Version (1, 2, or 3)
 *   Offset  17 –  45  Z80 CPU registers
 *   Offset  46 –  63  Gate Array palette (selected pen + 17 hardware colour values)
 *   Offset  64        GA ROM config register
 *   Offset  65        Memory banking register
 *   Offset  66        CRTC selected register
 *   Offset  67 –  84  CRTC R0–R17
 *   Offset  85        Selected upper ROM slot
 *   Offset  86 –  88  PPI Port A / B / C
 *   Offset  89        PPI control byte
 *   Offset  90        PSG selected register
 *   Offset  91 – 106  PSG R0–R15
 *   Offset 107 – 108  Dump size in KB (little-endian)
 *   Offset 109        Machine_Type (v2/v3 only)
 *   Offset 256+       RAM dump, then optional chunks
 */
const SNA_Parser = {

    /**
     * Parses a SNA file and restores the full emulator state.
     * Validates the magic string and version, then restores CPU registers,
     * Gate Array, CRTC, Memory, PPI, PSG, and RAM in sequence.
     * For v3, also restores FDC, CRTC counters, sync flags, and Gate Array state.
     * Optional chunks (e.g. "CPC+") are parsed at the end.
     * @param {Uint8Array} data - Full SNA file bytes.
     */
    parseFile(data) {
        if (bytesToString(data, 0, 8) !== "MV - SNA") {
            alert("[SNA Parser] Error: Invalid SNA id");
        }

        const version = data[16];
        if (version !== 1 && version !== 2 && version !== 3) {
            alert("[SNA Parser] Error: Invalid snapshot version");
        }

        if ((version === 2 && data[109] > 3) || (version === 3 && data[109] > 6)) {
            alert(`[SNA Parser] Error: CPC model unrecognized in snapshot v${version}`);
        } else {
            Machine_Type = (version === 2 || version === 3) ? data[109] : 2;
        }

        // Z80 registers — layout r8: [C=0, B=1, E=2, D=3, L=4, H=5, F=6, A=7]
        CPU_Z80.r8[6] = data[17]; // F
        CPU_Z80.r8[7] = data[18]; // A
        CPU_Z80.r8[0] = data[19]; // C
        CPU_Z80.r8[1] = data[20]; // B
        CPU_Z80.r8[2] = data[21]; // E
        CPU_Z80.r8[3] = data[22]; // D
        CPU_Z80.r8[4] = data[23]; // L
        CPU_Z80.r8[5] = data[24]; // H
        CPU_Z80.regR  = data[25];
        CPU_Z80.regI  = data[26];
        CPU_Z80.iff1  = data[27];
        CPU_Z80.iff2  = data[28];
        CPU_Z80.idxRegs[0] = read16bitLE(data, 29); // IX
        CPU_Z80.idxRegs[1] = read16bitLE(data, 31); // IY
        CPU_Z80.regSP       = read16bitLE(data, 33);
        CPU_Z80.regPC       = read16bitLE(data, 35);
        CPU_Z80.regIM       = data[37];

        // Alternate register set — same layout as r8
        CPU_Z80.alt8[6] = data[38]; // F'
        CPU_Z80.alt8[7] = data[39]; // A'
        CPU_Z80.alt8[0] = data[40]; // C'
        CPU_Z80.alt8[1] = data[41]; // B'
        CPU_Z80.alt8[2] = data[42]; // E'
        CPU_Z80.alt8[3] = data[43]; // D'
        CPU_Z80.alt8[4] = data[44]; // L'
        CPU_Z80.alt8[5] = data[45]; // H'

        // Gate Array — palette
        Palette_Colors.selectedPen = data[46];
        for (let i = 0; i <= 16; i++) Palette_Colors.setHardwareColor(i, data[47 + i]);
        ROM_Manager.updateRomConfig(data[64]);
        Palette_Colors.applyPaletteMode();

        // Memory banking
        Memory_Manager.updateBanking(data[65]);

        // CRTC — write all R0–R17 through the CRTC write path to trigger side effects
        for (let i = 0; i <= 17; i++) { CRTC_Manager.select(i); CRTC_Manager.write(data[67 + i]); }
        CRTC_Manager.selectedRegister = data[66];
        CRTC_Manager.r4_vt    = CRTC_Manager.registers[4];
        CRTC_Manager.r5_vta   = CRTC_Manager.registers[5];
        CRTC_Manager.r9_mra   = CRTC_Manager.registers[9];

        // ROMs and PPI
        ROM_Manager.selectedUpperRom = data[85];
        PPI_8255.portA = data[86];
        PPI_8255.portB = data[87];
        PPI_8255.portC = data[88];

        if (data[89] >>> 7) {
            PPI_8255.writeControlPPI(data[89]);
        } else {
            PPI_8255.dirA = 0; PPI_8255.dirB = 1;
            PPI_8255.dirCLower = 0; PPI_8255.dirCUpper = 0;
            PPI_8255.modeA = 0; PPI_8255.modeB = 0;
        }

        // PSG AY-3-8910
        for (let i = 0; i <= 15; i++) {
            PSG_Sound_AY38910.selectRegisterPSG(i);
            PSG_Sound_AY38910.writeRegisterPSG(data[91 + i]);
        }
        PSG_Sound_AY38910.selectRegisterPSG(data[90]);

        // RAM dump
        const dumpSizeKb = read16bitLE(data, 107);
        if (dumpSizeKb % 64 !== 0 || dumpSizeKb < 64 || dumpSizeKb > 576) {
            alert("[SNA Parser] Error: Invalid dumpsize");
        }
        const ramBytes = 1024 * dumpSizeKb;
        for (let i = 0; i < ramBytes; i++) Memory_Manager.ramData[i] = data[256 + i];

        // v3 extended state — FDC, CRTC counters, sync flags, Gate Array
        if (version === 3) {
            Floppy_Controller_FDC.motorOn    = data[156] !== 0;
            Floppy_Drive_A.trackId           = data[157];
            Floppy_Drive_B.trackId           = data[158];

            CRTC_Manager.hcc_counter  = data[169];
            CRTC_Manager.vcc          = data[171];
            CRTC_Manager.vlc_crtc     = data[172];
            CRTC_Manager.vtac_counter = data[173];
            CRTC_Manager.hsyncCounter = data[174];
            Palette_Colors.hsyncCounter = CRTC_Manager.hsyncCounter;
            CRTC_Manager.vsc_counter  = data[175];

            const syncFlags = data[176];
            CRTC_Manager.vsyncActive  = Palette_Colors.vsyncActive  = !!(syncFlags & 1);
            CRTC_Manager.hsyncActive  = Palette_Colors.hsyncActive  = !!(syncFlags & 2);
            CRTC_Manager.vblankActive = !!(syncFlags & 0x80);
            if (CRTC_Manager.vsyncActive) Palette_Colors.interruptDelay = 2 - data[178];

            // Recompute the current CRTC address from the restored register values
            CRTC_Manager.startAddress = ((CRTC_Manager.registers[12] & 63) << 8 | CRTC_Manager.registers[13])
                                       + CRTC_Manager.vcc * CRTC_Manager.registers[1];
            CRTC_Manager.maRow        = CRTC_Manager.startAddress + CRTC_Manager.hcc_counter;

            Palette_Colors.scanlineCounter = data[179];
            Palette_Colors.gaIntStatus     = data[181];
        }

        // Optional chunks following the RAM dump
        let chunkOffset = 256 + ramBytes;
        while (chunkOffset < data.length) {
            chunkOffset += this.parseSnaChunk(data, chunkOffset);
        }
    },

    /**
     * Serialises the current emulator state to a SNA v2 byte stream.
     * Produces a 256-byte header followed by either 64 KB or 128 KB of RAM.
     * The layout mirrors parseFile() — same offsets, opposite direction.
     * Pauses the emulator before reading to ensure a consistent state.
     * @returns {Uint8Array|null} SNA file bytes, or null if serialisation failed.
     */
    saveFile() {
        try {
            const dumpSizeKb  = (Memory_Manager.ramData.length >= 131072) ? 128 : 64;
            const dumpSizeB   = dumpSizeKb * 1024;
            const sna         = new Uint8Array(256 + dumpSizeB);
            const dv          = new DataView(sna.buffer);

            // Signature and version
            const sig = "MV - SNA";
            for (let i = 0; i < 8; i++) sna[i] = sig.charCodeAt(i);
            sna[16] = 2;

            // Z80 registers
            sna[17] = CPU_Z80.r8[6]; sna[18] = CPU_Z80.r8[7];
            sna[19] = CPU_Z80.r8[0]; sna[20] = CPU_Z80.r8[1];
            sna[21] = CPU_Z80.r8[2]; sna[22] = CPU_Z80.r8[3];
            sna[23] = CPU_Z80.r8[4]; sna[24] = CPU_Z80.r8[5];
            sna[25] = CPU_Z80.regR   & 0xFF;
            sna[26] = CPU_Z80.regI   & 0xFF;
            sna[27] = CPU_Z80.iff1   & 0xFF;
            sna[28] = CPU_Z80.iff2   & 0xFF;
            dv.setUint16(29, CPU_Z80.idxRegs[0], true);
            dv.setUint16(31, CPU_Z80.idxRegs[1], true);
            dv.setUint16(33, CPU_Z80.regSP,       true);
            dv.setUint16(35, CPU_Z80.regPC,       true);
            sna[37] = CPU_Z80.regIM  & 0xFF;

            // Alternate registers
            sna[38] = CPU_Z80.alt8[6]; sna[39] = CPU_Z80.alt8[7];
            sna[40] = CPU_Z80.alt8[0]; sna[41] = CPU_Z80.alt8[1];
            sna[42] = CPU_Z80.alt8[2]; sna[43] = CPU_Z80.alt8[3];
            sna[44] = CPU_Z80.alt8[4]; sna[45] = CPU_Z80.alt8[5];

            // Gate Array — selected pen and hardware colour values
            sna[46] = Palette_Colors.selectedPen & 0xFF;
            for (let i = 0; i <= 16; i++) {
                sna[47 + i] = Palette_Colors.hwColorValues[i] & 0xFF;
            }

            // GA ROM config and memory banking registers
            sna[64] = (ROM_Manager.romConfig !== undefined)
                ? (ROM_Manager.romConfig & 0xFF) : 0x00;
            sna[65] = (Memory_Manager.bankingReg !== undefined)
                ? (Memory_Manager.bankingReg & 0xFF) : 0x00;

            // CRTC registers
            sna[66] = CRTC_Manager.selectedRegister & 0xFF;
            for (let i = 0; i <= 17; i++) {
                sna[67 + i] = (CRTC_Manager.registers[i] !== undefined)
                    ? (CRTC_Manager.registers[i] & 0xFF) : 0;
            }

            // ROMs and PPI
            sna[85] = ROM_Manager.selectedUpperRom & 0xFF;
            sna[86] = PPI_8255.portA & 0xFF;
            sna[87] = PPI_8255.portB & 0xFF;
            sna[88] = PPI_8255.portC & 0xFF;

            // PPI control byte — bit 7=1: mode control word
            // Format: 1 [modeA:2] [dirA] [dirCUpper] [modeB] [dirCLower] [dirB]
            if (PPI_8255.controlByte !== undefined) {
                sna[89] = PPI_8255.controlByte & 0xFF;
            } else {
                sna[89] = 0x80
                    | ((PPI_8255.modeA      & 0x03) << 5)
                    | ((PPI_8255.dirA       & 0x01) << 4)
                    | ((PPI_8255.dirCUpper  & 0x01) << 3)
                    | ((PPI_8255.modeB      & 0x01) << 2)
                    | ((PPI_8255.dirCLower  & 0x01) << 1)
                    |  (PPI_8255.dirB       & 0x01);
            }

            // PSG AY-3-8910
            sna[90] = PSG_Sound_AY38910.selectedRegister & 0xFF;
            for (let i = 0; i <= 15; i++) {
                sna[91 + i] = (PSG_Sound_AY38910.registers !== undefined
                               && PSG_Sound_AY38910.registers[i] !== undefined)
                    ? (PSG_Sound_AY38910.registers[i] & 0xFF) : 0;
            }

            // Dump size and machine type
            dv.setUint16(107, dumpSizeKb, true);
            sna[109] = (typeof Machine_Type !== 'undefined') ? (Machine_Type & 0xFF) : 2;

            // RAM dump
            sna.set(Memory_Manager.ramData.subarray(0, dumpSizeB), 256);

            return sna;

        } catch (err) {
            console.error('[SNA_Parser.saveFile] Error:', err);
            alert('Error capturing snapshot: ' + err.message);
            return null;
        }
    },

    /**
     * Parses one optional SNA chunk starting at `offset` in `data`.
     * Currently only the "CPC+" chunk is handled; unknown chunks are logged and skipped.
     *
     * "CPC+" chunk layout:
     *   2048 bytes   — ASIC palette (4-bit pairs packed into bytes)
     *   16 × 40 bytes — sprite attribute blocks (5 words × 4 bytes each)
     *   96 bytes     — ASIC palette registers 0x2400–0x245F
     *   6 bytes      — ASIC general registers 0x2800–0x2805
     *   2 bytes      — ASIC ROM select + 1 padding byte
     *   8 bytes      — registers 0x2808–0x280F (skipped)
     *   12 bytes     — DMA channel registers (3 × 3 bytes + 1 padding)
     *   3 bytes      — DMA channel padding
     *   1 byte       — ASIC DMA status/control
     *   21 bytes     — DMA channel runtime state (3 × 7 bytes)
     *   1 byte       — ASIC lock state (0 = unlocked)
     *   1 byte       — ASIC unlock state machine position
     *
     * @param {Uint8Array} data   - Full SNA file bytes.
     * @param {number}     offset - Byte offset of the chunk header in data.
     * @returns {number} Total bytes consumed: chunk payload size + 8 (header).
     */
    parseSnaChunk(data, offset) {
        const chunkId   = bytesToString(data, offset, 4);
        const chunkSize = read32bitLE(data, offset + 4);
        let   pos       = offset + 8;

        if (chunkId === "CPC+") {
            for (let i = 0; i < 2048; i++) {
                ASIC_Manager.write(2 * i,     data[pos] >>> 4);
                ASIC_Manager.write(2 * i + 1, data[pos] & 0x0F);
                pos++;
            }

            let asicAddr = 0x2000;
            for (let s = 0; s < 16; s++) {
                for (let w = 0; w < 5; w++) {
                    ASIC_Manager.write(asicAddr,     data[pos]);
                    ASIC_Manager.write(asicAddr + 1, data[pos + 1]);
                    ASIC_Manager.write(asicAddr + 2, data[pos + 2]);
                    ASIC_Manager.write(asicAddr + 3, data[pos + 3]);
                    asicAddr += 8; pos += 8;
                }
            }

            for (let addr = 0x2400; addr <= 0x245F; addr++) {
                ASIC_Manager.write(addr, data[pos]);
                Palette_Colors.applyQueuedColor();
                pos++;
            }
            for (let addr = 0x2800; addr <= 0x2805; addr++) {
                ASIC_Manager.write(addr, data[pos]);
                pos++;
            }

            ROM_Manager.selectAsicRom(data[pos]); pos += 2;

            for (let addr = 0x2808; addr <= 0x280F; addr++) pos++;

            let dmaBase = 0x2C00;
            for (let ch = 0; ch < 3; ch++) {
                ASIC_Manager.write(dmaBase,     data[pos]);
                ASIC_Manager.write(dmaBase + 1, data[pos + 1]);
                ASIC_Manager.write(dmaBase + 2, data[pos + 2]);
                dmaBase += 4; pos += 4;
            }
            pos += 3;

            ASIC_DMA_Controller.statusControl = data[pos]; pos++;
            for (let ch = 0; ch <= 2; ch++) {
                ASIC_DMA_Controller.channels[ch].loopCount        = read16bitLE(data, pos);
                ASIC_DMA_Controller.channels[ch].loopStart        = read16bitLE(data, pos + 2);
                ASIC_DMA_Controller.channels[ch].pauseValue       = read16bitLE(data, pos + 4);
                ASIC_DMA_Controller.channels[ch].prescalerCurrent = data[pos + 6];
                pos += 7;
            }
            pos++;

            ASIC_Manager.asicLocked = (data[pos] === 0); pos++;
            if (data[pos] <= 16) ASIC_Manager.asicUnlockState = Math.max(0, data[pos] - 2);

        } else {
            console.log(`[SNA Parser] Unknown chunk: "${chunkId}"`);
        }

        return chunkSize + 8;
    },

    /**
     * Reads the AMSDOS CP/M directory from a parsed DSK image and returns
     * a list of visible files (non-deleted, non-system, extent 0 only).
     * Scans sector IDs 0xC1–0xC4 on track 0 side 0.
     * Each directory entry is 32 bytes; bytes 1–8 = name, 9–11 = extension.
     * Bit 7 of extension byte 1 = read-only; bit 7 of extension byte 2 = system (hidden).
     * @param {Object} dsk - Parsed DSK object with trackData[track][side].sectors.
     * @returns {Array<{name:string, type:string}>} List of visible file entries.
     */
    getDirectory(dsk) {
        if (!dsk || !dsk.trackData || !dsk.trackData[0] || !dsk.trackData[0][0]) return [];

        const track0   = dsk.trackData[0][0];
        const sectors  = track0.sectors;
        const fileList = {};

        sectors.forEach(sector => {
            if (sector.id >= 0xC1 && sector.id <= 0xC4) {
                const data = sector.data[0];
                for (let i = 0; i < data.length; i += 32) {
                    const user = data[i];
                    if (user > 15) continue;

                    const isSystemFile = (data[i + 10] & 0x80) !== 0;
                    if (isSystemFile) continue;

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
        return Object.values(fileList);
    },
};


// =============================================================================
// Snapshot_Manager
// =============================================================================

/**
 * @namespace Snapshot_Manager
 * @description High-level snapshot operations: capture, load, eject, and ZIP extraction.
 */
const Snapshot_Manager = {

    /**
     * Byte array of the currently active snapshot, or null if none.
     * @type {Uint8Array|null}
     */
    currentSnapshot:   null,

    /**
     * List of .SNA entries extracted from the most recently opened ZIP archive.
     * @type {Array<{name:string, entry:Object}>|null}
     */
    currentZipEntries: null,

    /**
     * Captures the current emulator state, serialises it to SNA v2, and triggers
     * a browser download with a timestamped filename (cpc_HHMMSS.sna).
     * The emulator is paused during serialisation for state consistency.
     */
    takeSnapshot() {
        if (typeof Emulator_Core === 'undefined') {
            alert('Emulator not available.');
            return;
        }

        Emulator_Core.pauseEmulator();
        const snaData = SNA_Parser.saveFile();
        Emulator_Core.resumeEmulator();

        if (!snaData) return;

        const now      = new Date();
        const hh       = String(now.getHours())  .padStart(2, '0');
        const mm       = String(now.getMinutes()).padStart(2, '0');
        const ss       = String(now.getSeconds()).padStart(2, '0');
        const filename = `cpc_${hh}${mm}${ss}.sna`;

        const blob = new Blob([snaData], { type: 'application/octet-stream' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.style.display = 'none';
        a.href          = url;
        a.download      = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            URL.revokeObjectURL(url);
            document.body.removeChild(a);
        }, 100);

        $('#snapshot-filename').text(filename);
        this.currentSnapshot = snaData;

        console.log(`[Snapshot] Saved: ${filename} (${snaData.length} bytes)`);
    },

    /**
     * Loads and applies a SNA snapshot into the running emulator.
     * Performs a full emulator reset before applying the snapshot state.
     * After loading, resumes emulation or launches the debugger depending on the
     * #checkbox-debugger UI setting.
     * @param {ArrayBuffer|Uint8Array} arrayBuffer - Raw SNA file data.
     * @returns {boolean} True if the snapshot was loaded successfully.
     */
    loadSnapshot(arrayBuffer) {
        try {
            if (typeof SNA_Parser === 'undefined') {
                console.error('[Snapshot] SNA_Parser not available');
                alert("Error: snapshot parser is not available.");
                return false;
            }

            const data = (arrayBuffer instanceof ArrayBuffer)
                ? new Uint8Array(arrayBuffer)
                : arrayBuffer;

            if (typeof Emulator_Core !== 'undefined') {
                Emulator_Core.pauseEmulator();
                Emulator_Core.reset();
            }

            SNA_Parser.parseFile(data);
            this.currentSnapshot = data;

            if (typeof Emulator_Core !== 'undefined') {
                if ($('#checkbox-debugger').is(':checked')) {
                    if (typeof launch_debugger === 'function') launch_debugger();
                } else {
                    Emulator_Core.resumeEmulator();
                }
            }
            return true;

        } catch (error) {
            console.error('[Snapshot] Load error:', error);
            alert('Error loading snapshot: ' + error.message);
            return false;
        }
    },

    /**
     * Clears references to the active snapshot and its ZIP entries.
     */
    ejectSnapshot() {
        this.currentSnapshot   = null;
        this.currentZipEntries = null;
    },

    /**
     * Reads a ZIP file using JSZip and calls back with the list of .SNA entries it contains.
     * @param {File}     zipFile  - ZIP file selected by the user.
     * @param {Function} callback - Receives Array<{name, entry}> on success, or null on failure.
     */
    extractZipEntries(zipFile, callback) {
        if (typeof JSZip === 'undefined') {
            console.error('[Snapshot] JSZip not available');
            alert("Error: JSZip library is not loaded.");
            return;
        }

        JSZip.loadAsync(zipFile).then(zip => {
            const snaFiles = [];
            zip.forEach((relativePath, zipEntry) => {
                if (!zipEntry.dir && relativePath.toLowerCase().endsWith('.sna')) {
                    snaFiles.push({ name: relativePath, entry: zipEntry });
                }
            });

            if (snaFiles.length === 0) {
                alert("No .SNA files found in the ZIP archive.");
                callback(null);
                return;
            }
            callback(snaFiles);

        }).catch(error => {
            console.error('[Snapshot] ZIP extraction error:', error);
            alert("Error extracting ZIP: " + error.message);
            callback(null);
        });
    },

    /**
     * Loads a SNA file from a JSZip entry object.
     * @param {Object} zipEntry - JSZip ZipObject for the .SNA file.
     */
    loadFromZipEntry(zipEntry) {
        zipEntry.async('arraybuffer').then(arrayBuffer => {
            this.loadSnapshot(arrayBuffer);
        }).catch(error => {
            console.error('[Snapshot] ZIP entry read error:', error);
            alert('Error reading file from ZIP: ' + error.message);
        });
    }
};


// =============================================================================
// DOM bindings
// =============================================================================

$(document).ready(function () {
    UI_Manager.bindSnapshot();
});
