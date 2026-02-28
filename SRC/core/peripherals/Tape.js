/**
 * @module Tape
 * @description Cassette tape emulation — WAV parsing, tape scanning, transport control.
 *
 * Covers:
 *   - WAV_Parser          — reads and creates PCM 8-bit mono WAV cassette files
 *   - Base64_Utils        — Base64 encode/decode utilities
 *   - TapeBlockScanner    — detects AMSDOS programme blocks in a tape signal
 *   - TapeController      — virtual tape deck (play/record/rewind/forward/stop)
 *   - Tape_Recorder       — cassette drive descriptor
 *   - Tape_Sample_Manager — resampled tape buffer with bit-level read/write access
 *   - writeString()       — WAV RIFF header helper
 *   - downloadTapeAsWav() — smart-trimmed WAV export
 *   - renderTapeBlocks()  — tape block list UI renderer
 *   - TapeController patches (CSS states, motor relay indicator, eject cleanup)
 *   - DOM bindings        — delegated to UI_Manager.bindTape()
 *
 * Global dependencies: jQuery ($), Emulator_Core (via Emulator_Setup.js), UI_Manager
 */

"use strict";

// =============================================================================
// WAV_Parser
// =============================================================================

/**
 * @namespace WAV_Parser
 * @description Parses and creates PCM 8-bit mono WAV files for use as CPC cassette images.
 *
 * Accepted format: PCM, 1 channel, 8 bits per sample, sample rate 8 kHz–125 kHz.
 * The parsed data is resampled to 125 000 Hz (the CPC CPU clock rate) so the emulator
 * can advance the tape by exactly one sample per CPU T-state.
 */
const WAV_Parser = {

    /**
     * Parses a WAV file from a byte array and returns a resampled Tape_Sample_Manager.
     * Validates the full RIFF/WAVE/fmt /data structure before reading any PCM data.
     * @param {Uint8Array} data - Raw WAV file bytes.
     * @returns {Object|false} A Tape_Sample_Manager initialised at 125 kHz, or false on error.
     */
    parseFile(data) {
        if (bytesToString(data, 0, 4) !== "RIFF")
            return this._err("Invalid WAV header");
        if (data.length !== read32bitLE(data, 4) + 8)
            return this._err("Invalid filesize");
        if (bytesToString(data, 8, 4) !== "WAVE")
            return this._err("Invalid format id");
        if (bytesToString(data, 12, 4) !== "fmt ")
            return this._err("Invalid subchunk id");

        const fmtSize = read32bitLE(data, 16);
        if (fmtSize > 65535)             return this._err("Invalid subchunk size. CPCBox accepts only WAV PCM 8-bit mono.");
        if (read16bitLE(data, 20) !== 1) return this._err("Invalid audio format. CPCBox accepts only WAV PCM 8-bit mono.");
        if (read16bitLE(data, 22) !== 1) return this._err("Invalid number of channels. CPCBox accepts only WAV PCM 8-bit mono.");

        const sampleRate = read32bitLE(data, 24);
        if (sampleRate < 8000 || sampleRate > 125000)
            return this._err("Invalid sample rate. CPCBox accepts only sample rates between 8KHz and 125KHz.");
        if (read32bitLE(data, 28) !== sampleRate) return this._err("Invalid byte rate. CPCBox accepts only WAV PCM 8-bit mono.");
        if (read16bitLE(data, 32) !== 1)          return this._err("Invalid block alignment. CPCBox accepts only WAV PCM 8-bit mono.");
        if (read16bitLE(data, 34) !== 8)          return this._err("Invalid sample size. CPCBox accepts only WAV PCM 8-bit mono.");

        const dataChunkOffset = 20 + fmtSize;
        if (data.length < dataChunkOffset + 8) return this._err("Invalid chunk offset. CPCBox accepts only WAV PCM 8-bit mono.");
        if (bytesToString(data, dataChunkOffset, 4) !== "data") return this._err("Invalid data subchunk");

        const dataSize = read32bitLE(data, dataChunkOffset + 4);
        if (data.length !== dataSize + dataChunkOffset + 8) return this._err("Invalid data subchunk size");

        const pcmData = data.subarray(dataChunkOffset + 8);
        if (pcmData.length === 0) return this._err("This WAV file has zero length");

        const tape = Object.create(Tape_Sample_Manager);
        tape.initialize(pcmData, sampleRate, 125_000);
        return tape;
    },

    /**
     * Creates a blank tape filled with silence (PCM value 128 = mid-scale for 8-bit unsigned).
     * The tape is generated at 44100 Hz then resampled to 125 kHz.
     * @param {number} minutes - Tape duration in minutes.
     * @returns {Object} A Tape_Sample_Manager initialised with silent PCM data.
     */
    createBlankTape(minutes) {
        const sampleRate = 44100;
        const pcmData    = new Uint8Array(Math.floor(sampleRate * 60 * minutes)).fill(128);
        const tape       = Object.create(Tape_Sample_Manager);
        tape.initialize(pcmData, sampleRate, 125_000);
        return tape;
    },

    /**
     * Displays an alert with the given error message and returns false.
     * @param {string} msg - Human-readable error description.
     * @returns {false}
     */
    _err(msg) { alert(`[WAV Parser] Error: ${msg}`); return false; }
};


// =============================================================================
// Base64_Utils
// =============================================================================

/**
 * @namespace Base64_Utils
 * @description Provides Base64 validation and decoding for binary file loading.
 */
const Base64_Utils = {

    /**
     * Standard RFC 4648 Base64 alphabet plus the padding character '='.
     * Used both for validation (membership test) and decoding (index lookup).
     * @type {string}
     */
    CHARS: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",

    /**
     * Returns true if every character in the input is a valid Base64 symbol.
     * @param {string} input - String to validate.
     * @returns {boolean}
     */
    isValid(input) {
        for (let i = 0; i < input.length; i++) {
            if (this.CHARS.indexOf(input.charAt(i)) === -1) return false;
        }
        return true;
    },

    /**
     * Decodes a Base64 string into a Uint8Array.
     * Processes 4 Base64 characters at a time → 3 output bytes.
     * Padding characters (index 64 in CHARS) shorten the output by 1 byte each.
     * @param {string} input - Base64-encoded string.
     * @returns {Uint8Array} Decoded binary data.
     */
    decode(input) {
        const chars = this.CHARS;
        const lastIdx       = chars.indexOf(input.charAt(input.length - 1));
        const secondLastIdx = chars.indexOf(input.charAt(input.length - 2));

        let outLen = Math.ceil(3 * input.length / 4);
        if (lastIdx       === 64) outLen--;
        if (secondLastIdx === 64) outLen--;

        const output = new Uint8Array(outLen);
        let   inIdx  = 0;
        let   outIdx = 0;

        while (outIdx < outLen) {
            const e1 = chars.indexOf(input.charAt(inIdx++));
            const e2 = chars.indexOf(input.charAt(inIdx++));
            const e3 = chars.indexOf(input.charAt(inIdx++));
            const e4 = chars.indexOf(input.charAt(inIdx++));

            output[outIdx++] = (e1 << 2) | (e2 >> 4);
            if (e3 !== 64) output[outIdx++] = ((e2 & 15) << 4) | (e3 >> 2);
            if (e4 !== 64) output[outIdx++] = ((e3 &  3) << 6) | e4;
        }
        return output;
    }
};


// =============================================================================
// TapeBlockScanner
// =============================================================================

/**
 * @namespace TapeBlockScanner
 * @description Detects and partially decodes AMSDOS programme blocks in a WAV tape signal.
 *
 * Detection algorithm — transition counting:
 *   The CPC tape signal is a sequence of rapid 0↔255 transitions. Rather than
 *   measuring absolute signal energy (which is sensitive to DC offset), we count
 *   the number of transitions per 50 ms window.
 *   - More than 6 transitions in 50 ms → active signal (block present).
 *   - Fewer than 3 transitions for 6 consecutive windows (≥ 300 ms) → block boundary.
 *
 * AMSDOS header decoding:
 *   Each bit is encoded as 2 half-periods. A bit-0 half-period ≈ pilotHP;
 *   a bit-1 half-period ≈ 2×pilotHP. The pilot tone gives us the reference period.
 *   Block header: first byte = 0x2C, bytes 1–16 = filename (ASCII, padded with spaces).
 *   A sliding-offset scan (8 start positions) compensates for bit-boundary uncertainty.
 */
const TapeBlockScanner = {

    /**
     * Scans a Tape_Sample_Manager and returns a list of detected blocks.
     * Each block is described by its sample position, timestamp, filename, and file type.
     * @param {Object} tape - Tape_Sample_Manager with `.buffer`, `.sampleRatio`, and `.size`.
     * @returns {Array<{samplePos:number, timeS:number, name:string, fileType:string|null}>}
     */
    scan(tape) {
        if (!tape || !tape.buffer || !tape.sampleRatio) {
            console.warn('[TapeBlockScanner] invalid tape object');
            return [];
        }

        const buf     = tape.buffer;
        const ratio   = tape.sampleRatio;
        const srcRate = Math.round(125000 * ratio);

        const WIN        = Math.max(1, Math.floor(srcRate * 0.05));
        const MIN_SIL_W  = Math.ceil(300 / 50);

        const blocks = [];
        let silCount  = MIN_SIL_W;
        let inSilence = true;
        let blockStart = 0;

        for (let w = 0; w < buf.length; w += WIN) {
            const end = Math.min(w + WIN, buf.length);

            let trans = 0;
            let prev  = buf[w] >= 128;
            for (let i = w + 2; i < end; i += 2) {
                const cur = buf[i] >= 128;
                if (cur !== prev) { trans++; prev = cur; }
            }

            const active = trans > 6;

            if (!active) {
                if (!inSilence) {
                    silCount++;
                    if (silCount >= MIN_SIL_W) {
                        blocks.push({ bufStart: blockStart, bufEnd: w });
                        inSilence = true;
                    }
                } else {
                    silCount++;
                }
            } else {
                if (inSilence) {
                    blockStart = w;
                    inSilence  = false;
                    silCount   = 0;
                }
            }
        }
        if (!inSilence) {
            blocks.push({ bufStart: blockStart, bufEnd: buf.length });
        }

        const result = [];

        for (let bi = 0; bi < blocks.length; bi++) {
            const b = blocks[bi];
            const samplePos = Math.round(b.bufStart / ratio);
            const timeS     = b.bufStart / srcRate;
            const decoded   = this._decodeHeader(buf, b.bufStart, b.bufEnd, srcRate);

            result.push({
                samplePos,
                timeS,
                name:     decoded ? decoded.name     : `Block ${bi + 1}`,
                fileType: decoded ? decoded.fileType : null
            });
        }
        return result;
    },

    /**
     * Attempts to decode the AMSDOS header from a block's raw transition data.
     * Uses a sliding-offset approach: tries 8 different bit-boundary starting points
     * to compensate for the uncertainty introduced by the pilot-to-sync transition.
     * Looks for the 0x2C marker byte and extracts the 16-byte filename that follows.
     * @param {Uint8Array} buf     - Full raw PCM buffer.
     * @param {number}     start   - Buffer offset of the block start.
     * @param {number}     end     - Buffer offset of the block end.
     * @param {number}     srcRate - Source sample rate in Hz.
     * @returns {{name:string, fileType:string}|null} Decoded header info, or null on failure.
     */
    _decodeHeader(buf, start, end, srcRate) {
        const scanEnd = Math.min(start + srcRate * 5, end, buf.length);
        const trans = [];
        let prev = buf[start] >= 128;

        for (let i = start; i < scanEnd; i++) {
            const cur = buf[i] >= 128;
            if (cur !== prev) { trans.push(i); prev = cur; }
        }

        if (trans.length < 200) return null;

        let hps = [];
        for (let i = 1; i < 101; i++) hps.push(trans[i] - trans[i-1]);
        hps.sort((a,b) => a-b);
        const pilotHP = hps[50];

        let syncIdx = -1;
        for (let i = 20; i < trans.length - 150; i++) {
            const hp = trans[i] - trans[i-1];
            if (hp > pilotHP * 1.2 || hp < pilotHP * 0.8) {
                syncIdx = i;
                break;
            }
        }

        if (syncIdx === -1) return null;

        const bitThreshold = pilotHP * 0.8;

        for (let offset = 0; offset < 8; offset++) {
            let bytes = [];
            let ti = syncIdx + offset;

            while (bytes.length < 100 && (ti + 16) < trans.length) {
                let byte = 0;
                for (let b = 7; b >= 0; b--) {
                    const hpavg = (trans[ti] - trans[ti-2]) / 2;
                    if (hpavg > bitThreshold) byte |= (1 << b);
                    ti += 2;
                }
                bytes.push(byte);
            }

            for (let i = 0; i < bytes.length - 20; i++) {
                if (bytes[i] === 0x2C) {
                    let name = "";
                    for (let j = 1; j <= 16; j++) {
                        const c = bytes[i+j];
                        if (c >= 32 && c <= 126) {
                            name += String.fromCharCode(c);
                        } else if (c === 0) {
                            break;
                        }
                    }

                    name = name.trim();

                    if (name.length > 0) {
                        const ftIdx       = (i + 19 < bytes.length) ? bytes[i + 19] & 3 : 0;
                        const isProtected = (ftIdx & 0x01);
                        const contentCode = (ftIdx >> 1) & 0x07;
                        const contentTypes = [
                            'BASIC',
                            'Binary',
                            'Screen',
                            'ASCII',
                            'Data',
                            'Type 5',
                            'Type 6',
                            'Type 7'
                        ];

                        let typeLabel = contentTypes[contentCode] || 'Unknown';
                        if (isProtected) typeLabel += ' 🔒';
                        return { name, fileType: typeLabel };
                    }
                }
            }
        }

        return null;
    }
};


// =============================================================================
// TapeController
// =============================================================================

/**
 * @namespace TapeController
 * @description Virtual cassette deck — manages transport states, tape position,
 * bit I/O, and the motor relay interface between the CPC PPI and the WAV buffer.
 *
 * State machine:
 *   STATE_EMPTY   — no tape inserted; all transport buttons disabled
 *   STATE_STOP    — tape present, deck stopped
 *   STATE_PLAY    — reading tape bits into PPI Port A bit 6 on every CPU tick
 *   STATE_RECORD  — writing PPI Port C bit 5 to the tape buffer on every CPU tick
 *   STATE_REWIND  — advancing position backwards by 8 samples per tick
 *   STATE_FORWARD — advancing position forwards by 8 samples per tick
 *
 * Motor relay:
 *   The CPC motor relay is controlled by PPI Port C bit 4. While the relay is open
 *   (motorRelay = false), the tape does not advance even if PLAY or RECORD is active.
 */
const TapeController = {

    /** @type {number} State constant — no tape inserted. */
    STATE_EMPTY:   0,
    /** @type {number} State constant — recording to tape. */
    STATE_RECORD:  1,
    /** @type {number} State constant — playing tape. */
    STATE_PLAY:    2,
    /** @type {number} State constant — rewinding at 8× speed. */
    STATE_REWIND:  3,
    /** @type {number} State constant — fast-forwarding at 8× speed. */
    STATE_FORWARD: 4,
    /** @type {number} State constant — deck stopped with tape present. */
    STATE_STOP:    5,

    /** @type {null} Reserved for backward-compatibility; not used. */
    _bus: null,

    /** @type {Function|null} Injected getter — returns the current PPI Port C byte. */
    _getPpiPortC: null,

    /**
     * Wires dependencies from the central bus.
     * @param {Object} bus - Dependency container.
     * @param {Function} [bus.getPpiPortC] - Returns PPI Port C byte.
     */
    link(bus) {
        if (bus.getPpiPortC) this._getPpiPortC = bus.getPpiPortC;
    },

    /**
     * True while the motor relay is closed (PPI Port C bit 4 = 1).
     * Tape advancement only occurs when both this flag and the tape state are active.
     * @type {boolean}
     */
    motorRelay:   false,

    /**
     * Last bit value read from the tape buffer, exposed to PPI Port A bit 6.
     * Reset to 0 when the motor is off or the deck is not in PLAY state.
     * @type {number}
     */
    tapeBitOut:   0,

    /**
     * Displayed counter value (0–999), updated every 2^18 samples (~2 seconds at 125 kHz).
     * Cached to avoid unnecessary DOM updates.
     * @type {number|null}
     */
    psgCounter:   null,

    /**
     * Current tape position in Tape_Sample_Manager sample units (0 to size-1).
     * @type {number|null}
     */
    tapePosition: null,

    /**
     * Current deck transport state (STATE_* constant).
     * @type {number|null}
     */
    tapeState:    null,

    /**
     * Initialises the tape deck to empty state with the motor relay open.
     * Called once during emulator startup.
     */
    init() {
        this.resetTape();
        this.motorRelay = false;
        this.setTapeState(this.STATE_EMPTY);
    },

    /**
     * Resets motor relay to off. Called by Emulator_Core.reset().
     */
    reset() {
        this.setMotorRelay(0);
    },

    /**
     * Advances the tape by one 125 kHz sample or fast-winds by 8 samples,
     * depending on the current state. Called every 8 T-states by Emulator_Core.
     * Motor relay must be closed for PLAY and RECORD to advance the tape.
     */
    tick() {
        switch (this.tapeState) {
            case this.STATE_RECORD:
                if (this.motorRelay) {
                    Tape_Recorder.diskImage.tapeWriteBlock(this.tapePosition, this.readTapeBit());
                    this.advanceTape();
                }
                break;

            case this.STATE_PLAY:
                if (this.motorRelay) {
                    this.tapeBitOut = Tape_Recorder.diskImage.tapeReadBlock(this.tapePosition);
                    this.advanceTape();
                }
                break;

            case this.STATE_REWIND:
                for (let i = 0; i < 8; i++) this.rewindTape();
                break;

            case this.STATE_FORWARD:
                for (let i = 0; i < 8; i++) this.advanceTape();
                break;
        }
    },

    /**
     * Rewinds the tape to position 0 and refreshes the counter display.
     */
    resetTape() {
        this.tapePosition = 0;
        this.updateTapeUI();
    },

    /**
     * Advances the tape position by one sample.
     * Transitions to STATE_STOP if the end of tape is reached.
     */
    advanceTape() {
        if (this.tapePosition < Tape_Recorder.diskImage.size - 1) {
            this.tapePosition++;
            this.updateTapeUI();
        } else {
            this.setTapeState(this.STATE_STOP);
        }
    },

    /**
     * Decrements the tape position by one sample.
     * Transitions to STATE_STOP if the beginning of tape is reached.
     */
    rewindTape() {
        if (this.tapePosition > 0) {
            this.tapePosition--;
            this.updateTapeUI();
        } else {
            this.setTapeState(this.STATE_STOP);
        }
    },

    /**
     * Updates the tape counter display element.
     * The displayed value is tapePosition >> 18, clamped to 0–999.
     * Skips DOM updates when the displayed value has not changed.
     */
    updateTapeUI() {
        const displayVal = this.tapePosition >>> 18;
        if (this.psgCounter !== displayVal) {
            this.psgCounter = displayVal;
            Tape_Recorder.counterElement.innerHTML = toDecimal3(displayVal % 1000);
        }
    },

    /**
     * Reads the current microphone bit from PPI Port C bit 5.
     * This is the signal written to the tape during recording.
     * @returns {number} 0 or 1.
     */
    readTapeBit() {
        return (this._getPpiPortC() >>> 5) & 1;
    },

    /**
     * Opens or closes the motor relay (driven by PPI Port C bit 4).
     * When the relay opens, tapeBitOut is cleared to 0.
     * The counter element colour changes to reflect the motor state.
     * @param {number} state - 1 to close the relay (motor on), 0 to open it.
     */
    setMotorRelay(state) {
        if (state === 1) {
            if (!this.motorRelay) {
                this.motorRelay = true;
                Tape_Recorder.counterElement.style.color = "darkred";
            }
        } else {
            if (this.motorRelay) {
                this.tapeBitOut = 0;
                this.motorRelay = false;
                Tape_Recorder.counterElement.style.color = "dimgray";
            }
        }
    },

    /**
     * Ejects the currently loaded tape, resets the position to 0, and
     * transitions the deck to STATE_EMPTY.
     */
    ejectTape() {
        this.setTapeState(this.STATE_EMPTY);
        this.resetTape();
    },

    /**
     * Transitions the deck to a new state, updating UI button styles accordingly.
     * Has no effect if the requested state is already the current state.
     * On the first tape insertion (EMPTY→STOP), delegates button binding to UI_Manager.
     * @param {number} newState - Target state (STATE_* constant).
     */
    setTapeState(newState) {
        if (newState === this.tapeState) return;

        const TC = TapeController;

        switch (newState) {

            case this.STATE_EMPTY:
                this.tapeBitOut = 0;
                $("#tape-record, #tape-play, #tape-rewind, #tape-forward, #tape-stop")
                    .removeClass("button toggled-button")
                    .addClass("disabled-button")
                    .off("click");
                break;

            case this.STATE_RECORD:
                $("#tape-play, #tape-rewind, #tape-forward").removeClass("toggled-button");
                $("#tape-record").addClass("toggled-button");
                break;

            case this.STATE_PLAY:
                $("#tape-record, #tape-rewind, #tape-forward").removeClass("toggled-button");
                $("#tape-play").addClass("toggled-button");
                break;

            case this.STATE_REWIND:
                this.tapeBitOut = 0;
                $("#tape-record, #tape-play, #tape-forward").removeClass("toggled-button");
                $("#tape-rewind").addClass("toggled-button");
                break;

            case this.STATE_FORWARD:
                this.tapeBitOut = 0;
                $("#tape-record, #tape-rewind, #tape-play").removeClass("toggled-button");
                $("#tape-forward").addClass("toggled-button");
                break;

            case this.STATE_STOP:
                this.tapeBitOut = 0;
                $("#tape-record, #tape-play, #tape-rewind, #tape-forward, #tape-stop")
                    .removeClass("disabled-button toggled-button")
                    .addClass("button");

                if (this.tapeState === this.STATE_EMPTY) {
                    const disk = Tape_Recorder.diskImage;
                    UI_Manager.bindTapeTransport(TC, disk);
                }
                break;
        }

        this.tapeState = newState;
    },
};


// =============================================================================
// Drive descriptor
// =============================================================================

/**
 * @namespace Tape_Recorder
 * @description Virtual cassette drive descriptor.
 * Follows the same interface pattern as the floppy drive descriptors so the
 * shared file-loading infrastructure can handle WAV files uniformly.
 */
const Tape_Recorder = {
    /** @type {string} Drive identifier used in UI elements. */
    name:            "tape",
    /** @type {string[]} Accepted file extensions. */
    validExtensions: ["wav"],
    /** @type {Function} Parser function — WAV_Parser.parseFile. */
    parserFunc:      WAV_Parser.parseFile,
    /** @type {boolean} Drive ready flag — false until a WAV file is loaded. */
    ready:           false,
    /** @type {Object|null} Archive wrapper for zip-enclosed WAV files. */
    archiveObj:      null,
    /**
     * Parsed tape image — a Tape_Sample_Manager instance with tapeReadBlock/tapeWriteBlock.
     * @type {Object|null}
     */
    diskImage:       null,
    /** @type {HTMLElement|null} DOM element displaying the tape position counter. */
    counterElement:  null,
};


// =============================================================================
// WAV export helper
// =============================================================================

/**
 * Writes an ASCII string into a DataView at the given byte offset.
 * Used to write RIFF/WAVE/fmt /data chunk identifiers into the WAV header.
 * @param {DataView} view   - Target DataView (backed by the header ArrayBuffer).
 * @param {number}   offset - Byte offset at which to begin writing.
 * @param {string}   string - ASCII string to write.
 */
function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}


// =============================================================================
// WAV export
// =============================================================================

/**
 * Exports the current Tape_Recorder contents as a downloadable WAV file.
 * Intelligently trims trailing silence: scans from the end of the buffer to find
 * the last non-silent sample (value outside 127–129), then appends a 2-second
 * margin before cutting. The output is always PCM 8-bit mono at 44100 Hz.
 * @param {Object} tapeData - Tape_Sample_Manager with a `.buffer` property.
 */
function downloadTapeAsWav(tapeData) {
    if (!tapeData || !tapeData.buffer) {
        alert('No tape loaded or invalid data.');
        return;
    }

    const rawData = tapeData.buffer;

    let lastSampleIndex = rawData.length - 1;
    let foundData = false;
    while (lastSampleIndex > 44) {
        const s = rawData[lastSampleIndex];
        if (s < 127 || s > 129) { foundData = true; break; }
        lastSampleIndex--;
    }

    if (!foundData) {
        if (!confirm('Warning: the tape appears to be empty (all silence). Download anyway?')) {
            return;
        }
        lastSampleIndex = 44100 * 5;
    }

    const sampleRate = 44100;
    let cutIndex = Math.min(lastSampleIndex + sampleRate * 2, rawData.length);
    const trimmedData = rawData.subarray(0, cutIndex);

    const wavHeader = new Uint8Array(44);
    const view      = new DataView(wavHeader.buffer);
    const totalSize = 36 + trimmedData.length;

    writeString(view,  0, 'RIFF');
    view.setUint32(4, totalSize, true);
    writeString(view,  8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16,         true);
    view.setUint16(20,  1,         true);
    view.setUint16(22,  1,         true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true);
    view.setUint16(32,  1,         true);
    view.setUint16(34,  8,         true);
    writeString(view, 36, 'data');
    view.setUint32(40, trimmedData.length, true);

    const blob      = new Blob([wavHeader, trimmedData], { type: 'audio/wav' });
    const url       = URL.createObjectURL(blob);
    const date      = new Date();
    const timestamp = `${date.getHours()}h${String(date.getMinutes()).padStart(2,'0')}`;
    const filename  = `cpc_tape_${timestamp}.wav`;

    const a = document.createElement('a');
    a.style.display = 'none';
    a.href          = url;
    a.download      = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); document.body.removeChild(a); }, 100);
}


// =============================================================================
// Tape block UI
// =============================================================================

/**
 * Cache of detected tape blocks for the currently loaded tape.
 * Updated by analyzeTape(); used by renderTapeBlocks() and the navigation patches.
 * @type {Array<{samplePos:number, timeS:number, name:string, fileType:string|null}>}
 */
let _tapeBlocks = [];

/**
 * Renders the list of detected tape blocks into the #tape-programs container.
 * Each row shows a sequence number, filename, file type, and MM:SS timestamp.
 * Clicking a row repositions the tape directly to that block.
 * @param {Array} blocks - Block list returned by TapeBlockScanner.scan().
 */
function renderTapeBlocks(blocks) {
    _tapeBlocks = blocks || [];
    const $el   = $('#tape-programs');

    if (!_tapeBlocks.length) {
        $el.html('<div class="tape-analyzing">No blocks detected</div>').show();
        return;
    }

    const rows = _tapeBlocks.map((b, idx) => {
        const mm        = String(Math.floor(b.timeS / 60)).padStart(2, '0');
        const ss        = String(Math.floor(b.timeS % 60)).padStart(2, '0');
        const typeLabel = b.fileType
            ? `<span class="prog-type">${b.fileType}</span>` : '';
        return `<div class="tape-prog-item" data-pos="${b.samplePos}" data-idx="${idx}">` +
               `<span class="prog-idx">${idx + 1}</span>` +
               `<span class="prog-name">${b.name}</span>` +
               typeLabel +
               `<span class="prog-time">${mm}:${ss}</span>` +
               `</div>`;
    }).join('');

    $el.html(rows).show();

    $el.find('.tape-prog-item').off('click').on('click', function () {
        const pos = parseInt($(this).data('pos'), 10);
        TapeController.tapePosition = pos;
        TapeController.updateTapeUI();
        highlightTapeBlock(pos);
    });
}

/**
 * Highlights the block item in #tape-programs that corresponds to the given position.
 * Selects the last block whose samplePos is ≤ the current position.
 * @param {number} pos - Current tape position in 125 kHz samples.
 */
function highlightTapeBlock(pos) {
    $('#tape-programs .tape-prog-item').removeClass('active');
    let best = -1;
    for (let i = _tapeBlocks.length - 1; i >= 0; i--) {
        if (_tapeBlocks[i].samplePos <= pos) { best = i; break; }
    }
    if (best >= 0) {
        $(`#tape-programs .tape-prog-item[data-idx="${best}"]`).addClass('active');
    }
}

/**
 * Asynchronously scans a tape for blocks using a 60 ms setTimeout to avoid
 * blocking the UI thread during the analysis pass.
 * Displays a spinner while analysis is in progress.
 * @param {Object} tape - Tape_Sample_Manager to scan.
 */
function analyzeTape(tape) {
    if (!tape || !tape.buffer || tape.size < 1000) {
        renderTapeBlocks([]);
        return;
    }
    $('#tape-programs')
        .html('<div class="tape-analyzing"><i class="fas fa-spinner fa-spin"></i> Analyzing…</div>')
        .show();

    setTimeout(function () {
        const blocks = TapeBlockScanner.scan(tape);
        renderTapeBlocks(blocks);
    }, 60);
}

/**
 * Empties the block cache and hides the #tape-programs container.
 * Called when a tape is ejected.
 */
function resetTapeDisplay() {
    _tapeBlocks = [];
    $('#tape-programs').hide().empty();
}

/**
 * Overrides the rewind and fast-forward buttons with smart block navigation
 * when blocks have been detected, falling back to continuous tape movement otherwise.
 * Rewind jumps to the previous block (> 500 samples before current position);
 * forward jumps to the next block (> 500 samples after current position).
 */
function rebindTapeNavigation() {

    $('#tape-rewind').off('click').on('click', function () {
        if (_tapeBlocks.length) {
            const cur  = TapeController.tapePosition;
            let   prev = null;
            for (let i = _tapeBlocks.length - 1; i >= 0; i--) {
                if (_tapeBlocks[i].samplePos < cur - 500) { prev = _tapeBlocks[i].samplePos; break; }
            }
            if (prev !== null) {
                TapeController.tapePosition = prev;
                TapeController.updateTapeUI();
                highlightTapeBlock(prev);
                return;
            }
        }
        const pos = TapeController.tapePosition;
        TapeController.setTapeState(pos > 0 ? TapeController.STATE_REWIND : TapeController.STATE_STOP);
    });

    $('#tape-forward').off('click').on('click', function () {
        if (_tapeBlocks.length) {
            const cur  = TapeController.tapePosition;
            const next = _tapeBlocks.find(b => b.samplePos > cur + 500);
            if (next) {
                TapeController.tapePosition = next.samplePos;
                TapeController.updateTapeUI();
                highlightTapeBlock(next.samplePos);
                return;
            }
        }
        const disk = Tape_Recorder.diskImage;
        TapeController.setTapeState(
            disk && TapeController.tapePosition < disk.size - 1
                ? TapeController.STATE_FORWARD
                : TapeController.STATE_STOP
        );
    });
}


// =============================================================================
// TapeController patches
// =============================================================================

/**
 * Applies three monkey-patches to TapeController to enrich its methods
 * with UI side-effects without replacing the core logic.
 *
 * Patch 1 — setTapeState: adds semantic CSS classes (recording/playing/rewinding/forwarding)
 *   to the transport buttons after the original state transition.
 *
 * Patch 2 — setMotorRelay: updates a #tape-motor-status element with 'ON'/'OFF' text
 *   and toggles the 'motor-on' CSS class.
 *
 * Patch 3 — ejectTape: calls resetTapeDisplay() to clear the block list after ejection.
 */
(function patchTapeController() {
    if (typeof TapeController === 'undefined') {
        console.warn('[Tape.js] TapeController not available — patches skipped');
        return;
    }

    const _origSetTapeState = TapeController.setTapeState.bind(TapeController);
    TapeController.setTapeState = function (newState) {
        _origSetTapeState(newState);

        $('#tape-record, #tape-play, #tape-rewind, #tape-forward')
            .removeClass('recording playing rewinding forwarding');

        switch (newState) {
            case TapeController.STATE_RECORD:  $('#tape-record') .addClass('recording');  break;
            case TapeController.STATE_PLAY:    $('#tape-play')   .addClass('playing');    break;
            case TapeController.STATE_REWIND:  $('#tape-rewind') .addClass('rewinding');  break;
            case TapeController.STATE_FORWARD: $('#tape-forward').addClass('forwarding'); break;
        }
    };

    const _origSetMotorRelay = TapeController.setMotorRelay.bind(TapeController);
    TapeController.setMotorRelay = function (state) {
        _origSetMotorRelay(state);
        const el = document.getElementById('tape-motor-status');
        if (el) {
            el.textContent = state === 1 ? 'ON' : 'OFF';
            el.classList.toggle('motor-on', state === 1);
        }
    };

    const _origEjectTape = TapeController.ejectTape.bind(TapeController);
    TapeController.ejectTape = function () {
        _origEjectTape();
        resetTapeDisplay();
    };

})();


// =============================================================================
// Tape_Sample_Manager
// =============================================================================

/**
 * @namespace Tape_Sample_Manager
 * @description Resampled tape buffer providing bit-level read/write access.
 *
 * The WAV source can be at any rate between 8 kHz and 125 kHz. Tape_Sample_Manager
 * stores the raw buffer alongside a sampleRatio (sourceRate / 125000), so that
 * every access translates a 125 kHz index into the correct source buffer offset
 * with a single multiply-and-floor — no resampled copy is needed.
 *
 * Bit encoding: the MSB (bit 7) of each 8-bit PCM sample represents the pulse state.
 * Samples ≥ 128 → bit 1 (high); samples < 128 → bit 0 (low).
 */
const Tape_Sample_Manager = {

    /** @type {Uint8Array|null} Raw PCM data at the source sample rate. */
    buffer     : null,
    /**
     * Ratio of source sample rate to 125 000 Hz.
     * Access formula: sourceIndex = Math.floor(tapeIndex * sampleRatio)
     * @type {number|null}
     */
    sampleRatio: null,
    /**
     * Total tape length in 125 kHz units (= Math.floor(buffer.length / sampleRatio)).
     * @type {number|null}
     */
    size       : null,

    /**
     * Initialises the sample manager with a PCM buffer and computes the sample ratio.
     * @param {Uint8Array} data       - Raw 8-bit unsigned PCM data at sourceRate.
     * @param {number}     sourceRate - Sample rate of the source buffer in Hz.
     * @param {number}     targetRate - Target emulation rate in Hz (always 125 000).
     */
    initialize(data, sourceRate, targetRate) {
        this.buffer      = data;
        this.sampleRatio = sourceRate / targetRate;
        this.size        = Math.floor(data.length / this.sampleRatio);
    },

    /**
     * Returns the pulse bit (MSB) of the sample at the given 125 kHz index.
     * @param {number} index - Tape position in 125 kHz samples.
     * @returns {number} 0 or 1.
     */
    getPulseBit(index) {
        return this.buffer[Math.floor(index * this.sampleRatio)] >>> 7;
    },

    /**
     * Writes a pulse bit to the tape buffer at the given 125 kHz index.
     * bitValue 1 → 255 (full positive); bitValue 0 → 0 (full negative).
     * @param {number} index    - Tape position in 125 kHz samples.
     * @param {number} bitValue - 0 or 1.
     */
    setPulseBit(index, bitValue) {
        this.buffer[Math.floor(index * this.sampleRatio)] = bitValue === 1 ? 255 : 0;
    },

    /**
     * Alias for getPulseBit — compatibility interface used by TapeController.
     * @param {number} index - Tape position.
     * @returns {number} 0 or 1.
     */
    tapeReadBlock (index)         { return this.getPulseBit(index);         },

    /**
     * Alias for setPulseBit — compatibility interface used by TapeController.
     * @param {number} index    - Tape position.
     * @param {number} bitVal   - 0 or 1.
     */
    tapeWriteBlock(index, bitVal) { return this.setPulseBit(index, bitVal); }
};


// =============================================================================
// DOM bindings
// =============================================================================

$(document).ready(function () {
    UI_Manager.bindTape();
});
