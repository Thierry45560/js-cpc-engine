/**
 * @module FDC_Controller
 * @description Emulation of the NEC µPD765 Floppy Disk Controller used in the CPC.
 *
 * This module handles FDC command processing, phase transitions (COMMAND → EXECUTE → RESULT),
 * data transfers to/from disk images, and the drive descriptor objects.
 *
 * Load order in index.html:
 *   1. DSK_Parser.js        — disk image structure
 *   2. FDC_Controller.js    — µPD765 logic and drive descriptors  (this file)
 *   3. Floppy_UI.js         — file upload, catalogue, jQuery bindings
 *
 * Dependencies (globals):
 *   DSK_Parser, Config_Manager, CPU_Z80, throwError, toHex8, toHex16, arrayToHexString
 * No direct jQuery or DOM dependency except LED colour via ledElement.style.
 */

"use strict";

/**
 * @namespace Floppy_Controller_FDC
 * @description µPD765 FDC emulation.
 *
 * Communication protocol:
 *   1. CPU writes the opcode byte → IDLE → COMMAND phase.
 *   2. CPU writes cmdLength-1 parameter bytes → FDC builds cmdBuffer.
 *   3. When cmdBuffer is full, exec() is called:
 *      - If dataDirection == DIR_NONE: transition directly to RESULT phase.
 *      - If dataDirection == DIR_READ/WRITE: transition to EXECUTE phase;
 *        CPU exchanges data bytes by reading/writing the data port.
 *   4. When data transfer completes, endCommand() fills resBuffer and enters RESULT.
 *   5. CPU reads resultLength bytes from the data port → IDLE phase.
 *
 * MSR (Main Status Register) — returned by status():
 *   Bit 7: RQM — FDC ready to transfer data (always 1 here)
 *   Bit 6: DIO — direction of transfer (1 = FDC→CPU, 0 = CPU→FDC)
 *   Bit 5: EXM — FDC is in the Execute phase
 *   Bit 4: CB  — FDC command in progress
 */
const Floppy_Controller_FDC = {

    /**
     * Command parameter buffer — holds the opcode and up to 7 parameter bytes
     * written by the CPU during the COMMAND phase.
     * @type {Uint8Array}
     */
    cmdBuffer: new Uint8Array(8),

    /**
     * Result byte buffer — holds up to 7 status bytes returned to the CPU
     * during the RESULT phase.
     * @type {Uint8Array}
     */
    resBuffer: new Uint8Array(7),

    /** @type {number} Data transfer direction constant — FDC writes data to the disk. */
    DIR_WRITE: 0,
    /** @type {number} Data transfer direction constant — FDC reads data from the disk. */
    DIR_READ:  1,
    /** @type {number} Data transfer direction constant — no data phase (command is immediate). */
    DIR_NONE:  2,

    /** @type {number} Drive state — idle, no seek pending. */
    FDC_IDLE:        0,
    /** @type {number} Drive state — seek command issued; drive stepping toward target track. */
    FDC_SEEKING:     1,
    /** @type {number} Drive state — recalibrate command issued; stepping back to track 0. */
    FDC_RECALIBRATE: 2,
    /** @type {number} Drive state — seek/recalibrate failed (drive not ready). */
    FDC_ERROR:       3,

    /** @type {number} FDC phase — waiting for a command opcode byte. */
    PHASE_IDLE:    0,
    /** @type {number} FDC phase — receiving command parameter bytes. */
    PHASE_COMMAND: 1,
    /** @type {number} FDC phase — exchanging data bytes with the CPU. */
    PHASE_EXECUTE: 2,
    /** @type {number} FDC phase — returning result bytes to the CPU. */
    PHASE_RESULT:  3,

    /**
     * cmdBuffer field indices.
     * @type {number}
     */
    CMD_IDX_UNIT: 0, /** bits 1–0 = drive id, bit 2 = head */
    CMD_IDX_C:    1, /** cylinder number */
    CMD_IDX_H:    2, /** head address */
    CMD_IDX_R:    3, /** sector ID (R field) */
    CMD_IDX_N:    4, /** sector size code */
    CMD_IDX_EOT:  5, /** end of track — last sector number in a multi-sector transfer */
    CMD_IDX_GPL:  6, /** gap length */
    CMD_IDX_DTL:  7, /** data length (used when N=0) */
    CMD_IDX_NCN:  1, /** new cylinder number (seek/recalibrate) — aliases CMD_IDX_C */

    /**
     * resBuffer field indices for the 7-byte R/W result.
     * @type {number}
     */
    RES_IDX_ST0: 0, /** Status Register 0 */
    RES_IDX_ST1: 1, /** Status Register 1 */
    RES_IDX_ST2: 2, /** Status Register 2 */
    RES_IDX_C:   3, /** Cylinder number at end of operation */
    RES_IDX_H:   4, /** Head at end of operation */
    RES_IDX_R:   5, /** Sector ID at end of operation */
    RES_IDX_N:   6, /** Sector size code at end of operation */
    RES_IDX_ST3: 0, /** Status Register 3 (sense drive status result, overlaps ST0 slot) */
    RES_IDX_PCN: 1, /** Present Cylinder Number (sense interrupt result) */

    /** @type {number} ST0 — Status Register 0 scratch value. */
    st0: 0,
    /** @type {number} ST1 — Status Register 1 scratch value. */
    st1: 0,
    /** @type {number} ST2 — Status Register 2 scratch value. */
    st2: 0,
    /** @type {number} Currently addressed head (0 or 1). */
    selectedHead:    0,
    /** @type {number} Currently selected drive (0 = A, 1 = B). */
    selectedDrive:   0,
    /** @type {number} Non-DMA mode flag from the SPECIFY command (bit 0 of byte 2). */
    nonDmaMode:      0,
    /** @type {number} Head load time in milliseconds (from SPECIFY command). */
    headLoadTime:    0,
    /** @type {number} Head unload time in milliseconds (from SPECIFY command). */
    headUnloadTime:  0,
    /** @type {number} Step rate in milliseconds per track (from SPECIFY command). */
    stepRate:        0,
    /** @type {Object|null} The currently active command descriptor object. */
    fdcCurrentCommand: null,
    /** @type {number} Number of bytes remaining in the current sector data transfer. */
    bytesToRead:     0,
    /** @type {number} SK (Skip) flag from the command opcode — skip sectors with errors. */
    fdc_sk:          0,
    /** @type {number} MFM flag from the command opcode (always 1 for CPC). */
    fdc_mfm:         0,
    /** @type {number} MT (Multi-Track) flag from the command opcode. */
    fdc_mt:          0,
    /** @type {Object|null} Track data object for the currently addressed track and head. */
    currentTrackData:  null,
    /** @type {Object|null} Sector descriptor for the sector currently being transferred. */
    currentSectorData: null,
    /** @type {Object|null} Reference to the active Floppy_Drive_A or Floppy_Drive_B object. */
    activeDrive:     null,
    /** @type {string} Accumulated debug log string for the current command (debug mode only). */
    debugMessage:    "",
    /** @type {number} Read/write position within cmdBuffer or resBuffer in the current phase. */
    fdcBufferIndex:  0,
    /** @type {number} 1 when the current read/write operation targets deleted-data sectors. */
    isDeletedData:   0,
    /** @type {boolean} True while the drive motor is spinning. */
    motorOn:         false,
    /** @type {number} Current FDC communication phase (PHASE_* constant). */
    fdcPhase:        0,
    /** @type {number} Current drive seek state (FDC_* constant). */
    driveState:      0,
    /** @type {number} Last value placed on the data bus (returned when no phase matches). */
    dataRegister:    0xFF,

    /**
     * Refreshes the FDC debugger UI panel with the current phase, command name,
     * motor state, and drive track positions.
     */
    updateUI() {
        const phaseLabels = {
            [this.PHASE_IDLE]:    "inactive",
            [this.PHASE_COMMAND]: "command",
            [this.PHASE_EXECUTE]: "execute",
            [this.PHASE_RESULT]:  "result",
        };
        $("#fdc_phase").val(phaseLabels[this.fdcPhase] ?? "");
        $("#fdc_command").val(
            this.fdcPhase === this.PHASE_IDLE ? "" : this.fdcCurrentCommand.getOpName()
        );
        this.motorOn
            ? $("#fdc_motor").attr("checked", "checked")
            : $("#fdc_motor").removeAttr("checked");
        $("#drivea_track").text(Floppy_Drive_A.trackId);
        $("#driveb_track").text(Floppy_Drive_B.trackId);
    },

    /**
     * Resets the FDC and both drive descriptors to power-on state.
     * Extinguishes activity LEDs and parks both drives at track 0.
     */
    reset() {
        this.st0 = this.st1 = this.st2 = 0;
        this.selectedHead = this.selectedDrive = 0;
        this.nonDmaMode   = this.headLoadTime = this.headUnloadTime = this.stepRate = 0;
        this.fdcCurrentCommand = null;
        this.bytesToRead       = 0;
        this.fdc_sk = this.fdc_mfm = this.fdc_mt = 0;
        this.currentTrackData  = null;
        this.currentSectorData = null;
        this.activeDrive       = Floppy_Drive_A;
        this.debugMessage      = "";
        this.fdcBufferIndex    = 0;
        this.isDeletedData     = 0;
        this.motorOn           = false;
        this.fdcPhase          = this.PHASE_IDLE;
        this.driveState        = this.FDC_IDLE;
        this.dataRegister      = 0xFF;

        for (const drive of [Floppy_Drive_A, Floppy_Drive_B]) {
            drive.trackId          = 0;
            drive.currentSectorIdx = 0;
            drive.activityLed      = false;
            drive.ledElement.style.backgroundColor = "#400";
        }
    },

    /**
     * Handles Z80 IN instructions targeting the FDC port range.
     * Address bits decode as:
     *   0x100 → Main Status Register
     *   0x101 → Data Register (read)
     * @param {number} port - 16-bit I/O port address.
     * @returns {number|null} Byte read, or null if address is not decoded.
     */
    readPort(port) {
        switch (port & 0x581) {
            case 0x100: return this.status();
            case 0x101: return this.read();
        }
        return null;
    },

    /**
     * Handles Z80 OUT instructions targeting the FDC port range.
     * Address bits decode as:
     *   0x000/0x001 → Motor control register
     *   0x101       → Data Register (write)
     * @param {number} port  - 16-bit I/O port address.
     * @param {number} value - 8-bit value to write.
     */
    writePort(port, value) {
        switch (port & 0x581) {
            case 0x000:
            case 0x001:
                this.writeMotorControl(value);
                break;
            case 0x101:
                this.write(value);
                break;
        }
    },

    /**
     * Reads one byte from the FDC data port.
     * In EXECUTE phase with a read command: calls exec() to fetch the next sector byte.
     * In RESULT phase: returns the next result byte and transitions to IDLE when done.
     * @returns {number} The current value on the FDC data bus.
     */
    read() {
        switch (this.fdcPhase) {
            case this.PHASE_EXECUTE:
                if (this.fdcCurrentCommand.dataDirection === this.DIR_READ) {
                    this.dataRegister = this.fdcCurrentCommand.exec();
                }
                break;

            case this.PHASE_RESULT: {
                const byte = this.resBuffer[this.fdcBufferIndex++];
                if (this.fdcBufferIndex === this.fdcCurrentCommand.resultLength) {
                    this.setFdcPhase(this.PHASE_IDLE);
                }
                this.dataRegister = byte;
                break;
            }
        }
        return this.dataRegister;
    },

    /**
     * Writes one byte to the FDC data port.
     * In IDLE phase: interprets the byte as a command opcode.
     * In COMMAND phase: accumulates parameter bytes into cmdBuffer.
     * In EXECUTE phase with a write command: passes the byte to exec() for sector writing.
     * @param {number} value - 8-bit value written by the CPU.
     */
    write(value) {
        this.dataRegister = value;

        switch (this.fdcPhase) {
            case this.PHASE_IDLE:
                this.startFdcCommand(value);
                this.processFdcCommand();
                break;

            case this.PHASE_COMMAND:
                this.cmdBuffer[this.fdcBufferIndex++] = value;
                this.processFdcCommand();
                break;

            case this.PHASE_EXECUTE:
                if (this.fdcCurrentCommand.dataDirection === this.DIR_WRITE) {
                    this.fdcCurrentCommand.exec(value);
                }
                break;
        }
    },

    /**
     * Checks whether all command bytes have been received and, if so, dispatches exec().
     * After exec(), transitions to EXECUTE or RESULT depending on the data direction.
     * Commands with resultLength == 0 go directly to IDLE.
     */
    processFdcCommand() {
        if (this.fdcBufferIndex !== this.fdcCurrentCommand.cmdLength) return;

        this.fdcCurrentCommand.exec();

        if (this.fdcCurrentCommand.resultLength === 0) {
            this.setFdcPhase(this.PHASE_IDLE);
        } else if (this.fdcPhase !== this.PHASE_RESULT) {
            this.setFdcPhase(
                this.fdcCurrentCommand.dataDirection === this.DIR_NONE
                    ? this.PHASE_RESULT
                    : this.PHASE_EXECUTE
            );
        }
    },

    /**
     * Returns the Main Status Register (MSR) byte.
     * The MSR is polled by the CPU to determine when the FDC is ready for the next transfer.
     * Bit 7 (RQM) is always set; other bits reflect the current phase.
     * @returns {number} MSR value.
     */
    status() {
        let msr = 0x80;
        switch (this.fdcPhase) {
            case this.PHASE_COMMAND:
                msr |= 0x10;
                break;
            case this.PHASE_EXECUTE:
                msr |= 0x30;
                if (this.fdcCurrentCommand.dataDirection === this.DIR_READ) msr |= 0x40;
                break;
            case this.PHASE_RESULT:
                msr |= 0x50;
                break;
        }
        return msr;
    },

    /**
     * Processes a write to the motor control port.
     * Bit 0 of the written value enables (1) or disables (0) the drive motor.
     * @param {number} value - Value written to the motor control register.
     */
    writeMotorControl(value) {
        this.motorOn = (value & 1) === 1;
        if (Config_Manager.debugMode) {
            console.log(`[FDC] @0x${toHex16(CPU_Z80.regPC)} Motor → ${this.motorOn}`);
        }
    },

    /**
     * Scans the sectors of the current track for a sector matching the command's
     * C/H/R/N fields. The scan starts from currentSectorIdx and wraps around.
     * Handles weak-sector copy selection by cycling through the data copies.
     * On success: populates st1/st2 from the sector descriptor flags.
     * On failure: returns false (caller sets ST1 bit 2 "No Data").
     * @returns {Object|boolean} Matching sector descriptor, or false if not found.
     */
    findSector() {
        const sectors    = this.currentTrackData.sectors;
        const numSectors = sectors.length;
        const startIdx   = this.activeDrive.currentSectorIdx;

        do {
            const sector = sectors[this.activeDrive.currentSectorIdx];
            this.activeDrive.currentSectorIdx =
                (this.activeDrive.currentSectorIdx + 1) % numSectors;

            if (
                sector.sideId === this.cmdBuffer[this.CMD_IDX_H] &&
                sector.id     === this.cmdBuffer[this.CMD_IDX_R] &&
                sector.size   === this.cmdBuffer[this.CMD_IDX_N]
            ) {
                if (sector.data.length > 1 && Config_Manager.debugMode) {
                    console.log(`[FDC] Weak sector - weakIdx = ${sector.readOffset}`);
                }
                sector.readOffset = (sector.readOffset + 1) % sector.data.length;
                this.st1 = sector.st1 & 0xA5;
                this.st2 = sector.st2 & 0x61;
                if (this.isDeletedData) this.st2 ^= 0x40;
                return sector;
            }
        } while (this.activeDrive.currentSectorIdx !== startIdx);

        this.activeDrive.currentSectorIdx = 0;
        return false;
    },

    /**
     * Prepares for a sector read or write by locating the target sector and
     * initialising bytesToRead and fdcBufferIndex.
     * If the sector is not found, sets ST1 bit 2 (No Data) and calls endCommand().
     */
    setupReadWrite() {
        this.currentSectorData = this.findSector();
        if (!this.currentSectorData) {
            this.st1 |= 0x04;
            this.endCommand(this.st1, this.st2);
            return;
        }
        this.bytesToRead = this.currentSectorData.data[0].length;
        this.fdcBufferIndex = 0;
    },

    /**
     * Validates that the addressed drive and head are accessible, motor is on,
     * and a valid disk image is present. On success, loads currentTrackData.
     * @returns {boolean} True if the drive is ready and the motor is on.
     */
    checkDrive() {
        this.selectedHead  = (this.cmdBuffer[this.CMD_IDX_UNIT] >>> 2) & 1;
        this.selectedDrive =  this.cmdBuffer[this.CMD_IDX_UNIT] & 3;
        this.st0           =  this.cmdBuffer[this.CMD_IDX_UNIT] & 7;

        this.activeDrive = (this.selectedDrive & 1) === 0 ? Floppy_Drive_A : Floppy_Drive_B;

        const drive = this.activeDrive;
        const diskReady =
            drive.diskImage !== null &&
            drive.ready &&
            (drive.diskImage.numSides === 1 && this.selectedHead === 0 ||
             drive.diskImage.numSides > 1);

        if (!diskReady) return false;

        this.currentTrackData =
            drive.diskImage.trackData[drive.trackId][this.selectedHead];

        return this.motorOn;
    },

    /**
     * Finalises a command by populating resBuffer with status registers and the
     * final C/H/R/N position, then transitions to the RESULT phase.
     * If st1 or st2 is non-zero, sets ST0 bit 6 (Abnormal Termination).
     * @param {number} st1 - Final ST1 value.
     * @param {number} st2 - Final ST2 value.
     */
    endCommand(st1, st2) {
        if (st1 !== 0 || st2 !== 0) this.st0 |= 0x40;

        this.resBuffer[this.RES_IDX_ST0] = this.st0;
        this.resBuffer[this.RES_IDX_ST1] = st1;
        this.resBuffer[this.RES_IDX_ST2] = st2;
        this.resBuffer[this.RES_IDX_C]   = this.cmdBuffer[this.CMD_IDX_C];
        this.resBuffer[this.RES_IDX_H]   = this.cmdBuffer[this.CMD_IDX_H];
        this.resBuffer[this.RES_IDX_R]   = this.cmdBuffer[this.CMD_IDX_R];
        this.resBuffer[this.RES_IDX_N]   = this.cmdBuffer[this.CMD_IDX_N];
        this.setFdcPhase(this.PHASE_RESULT);
    },

    /**
     * Transitions to a new FDC phase, updating the activity LED and resetting fdcBufferIndex.
     * In debug mode, accumulates command/parameter/result information into debugMessage.
     * @param {number} newPhase - Target phase (PHASE_* constant).
     */
    setFdcPhase(newPhase) {
        if (Config_Manager.debugMode) {
            if (newPhase === this.PHASE_COMMAND) {
                this.debugMessage =
                    `[FDC] @0x${toHex16(CPU_Z80.regPC)} Cmd: ${this.fdcCurrentCommand.getOpName()}`;
            } else if (this.fdcPhase === this.PHASE_COMMAND) {
                this.debugMessage +=
                    ` Track:${this.activeDrive.trackId}` +
                    ` Sector:${this.activeDrive.currentSectorIdx}`;
                if (this.fdcCurrentCommand.cmdLength > 0) {
                    const params = this.cmdBuffer.slice(0, this.fdcCurrentCommand.cmdLength);
                    this.debugMessage += ` Params:${arrayToHexString(params)}`;
                }
            }
            if (newPhase === this.PHASE_RESULT) {
                const results = this.resBuffer.slice(0, this.fdcCurrentCommand.resultLength);
                this.debugMessage += ` Results:${arrayToHexString(results)}`;
            } else if (newPhase === this.PHASE_IDLE && this.debugMessage !== undefined) {
                console.log(`${this.debugMessage} @0x${toHex16(CPU_Z80.regPC)}`);
            }
        }

        if (newPhase === this.PHASE_EXECUTE) {
            if (!this.activeDrive.activityLed) {
                this.activeDrive.activityLed = true;
                this.activeDrive.ledElement.style.backgroundColor = "#f00";
            }
        } else if (this.fdcPhase === this.PHASE_EXECUTE && this.activeDrive.activityLed) {
            this.activeDrive.activityLed = false;
            this.activeDrive.ledElement.style.backgroundColor = "#400";
        }

        this.fdcPhase       = newPhase;
        this.fdcBufferIndex = 0;
    },

    /**
     * Decodes the command opcode byte, selects the matching command descriptor, and
     * extracts the MT/MFM/SK modifier bits. Transitions to the COMMAND phase.
     * Unknown opcodes fall back to cmdInvalid (returns ST0 = 0x80).
     * @param {number} opByte - First byte of the FDC command (includes MT/MFM/SK bits).
     */
    startFdcCommand(opByte) {
        const opcode = opByte & 0x1F;

        const commandMap = {
            0x02: this.cmdReadTrack,
            0x03: this.cmdSpecify,
            0x04: this.cmdSenseDriveStatus,
            0x05: this.cmdWriteData,
            0x06: this.cmdReadData,
            0x07: this.cmdRecalibrate,
            0x09: this.cmdWriteDeletedData,
            0x0A: this.cmdReadId,
            0x0C: this.cmdReadDeletedData,
            0x0D: this.cmdFormatTrack,
            0x0F: this.cmdSeek,
            0x11: this.cmdScanEqual,
            0x19: this.cmdScanLowOrEqual,
            0x1D: this.cmdScanHighOrEqual,
        };

        if (opcode === 0x08) {
            this.fdcCurrentCommand = this.cmdSenseInterruptStatus;
        } else {
            this.fdcCurrentCommand = commandMap[opcode] ?? this.cmdInvalid;
        }

        if (this.fdcCurrentCommand !== this.cmdInvalid) {
            this.fdc_mt  = opByte >>> 7;
            this.fdc_mfm = (opByte >>> 6) & 1;
            this.fdc_sk  = (opByte >>> 5) & 1;
        }

        if (opcode === 0x05 || opcode === 0x06) this.isDeletedData = false;
        if (opcode === 0x09 || opcode === 0x0C) this.isDeletedData = true;

        this.fdcBufferIndex = 0;
        this.setFdcPhase(this.PHASE_COMMAND);
    },

    // ==========================================================================
    // Command descriptor objects
    // ==========================================================================

    /**
     * READ DATA (opcode 0x06) — reads sectors sequentially from the current track.
     * COMMAND phase: validates the drive, locates the first sector.
     * EXECUTE phase: returns bytes from the sector data array one at a time.
     * Advances to the next sector (incrementing R) when the current one is exhausted.
     * Sets ST1 bit 7 (End of Cylinder) when R reaches EOT.
     */
    cmdReadData: {
        getOpName:    () => "read_data (0x06)",
        cmdLength:     8,
        resultLength:  7,
        dataDirection: 0,

        exec() {
            const fdc = Floppy_Controller_FDC;
            switch (fdc.fdcPhase) {
                case fdc.PHASE_COMMAND:
                    if (!fdc.checkDrive()) { fdc.st0 |= 0x48; fdc.endCommand(0x00, 0x00); return; }
                    if (fdc.currentTrackData === undefined || fdc.currentTrackData === null) {
                        if (Config_Manager.debugMode) console.log("[FDC] Track not found!");
                        fdc.endCommand(0x05, 0x01);
                    } else {
                        fdc.setupReadWrite();
                    }
                    break;

                case fdc.PHASE_EXECUTE: {
                    const byte = fdc.currentSectorData.data[fdc.currentSectorData.readOffset][fdc.fdcBufferIndex];
                    fdc.fdcBufferIndex++;
                    fdc.activeDrive.isDirty = true;
                    if (fdc.fdcBufferIndex === fdc.bytesToRead) {
                        if (fdc.cmdBuffer[fdc.CMD_IDX_R] === fdc.cmdBuffer[fdc.CMD_IDX_EOT] && fdc.st1 === 0) {
                            fdc.st1 = 0x80;
                        }
                        if (fdc.st1 !== 0 || fdc.st2 !== 0) {
                            fdc.endCommand(fdc.st1, fdc.st2);
                        } else {
                            fdc.cmdBuffer[fdc.CMD_IDX_R] = (fdc.cmdBuffer[fdc.CMD_IDX_R] + 1) & 0xFF;
                            fdc.setupReadWrite();
                        }
                    }
                    return byte;
                }

                default:
                    throwError("Error - exec_cmd_read_data() - Invalid state");
            }
        },
    },

    /**
     * READ DELETED DATA (opcode 0x0C) — identical to READ DATA but targets
     * sectors marked as deleted. exec is aliased to cmdReadData.exec after init.
     */
    cmdReadDeletedData: {
        getOpName:    () => "read_del_data (0x0c)",
        cmdLength:     8,
        resultLength:  7,
        dataDirection: 0,
        exec: null,
    },

    /**
     * WRITE DATA (opcode 0x05) — writes sectors sequentially to the current track.
     * COMMAND phase: validates the drive and checks write-protect status.
     * EXECUTE phase: receives bytes from the CPU and stores them in the sector data array.
     */
    cmdWriteData: {
        getOpName:    () => "write_data (0x05)",
        cmdLength:     8,
        resultLength:  7,
        dataDirection: 0,

        exec(value) {
            const fdc = Floppy_Controller_FDC;
            switch (fdc.fdcPhase) {
                case fdc.PHASE_COMMAND:
                    if (!fdc.checkDrive()) { fdc.st0 |= 0x48; fdc.endCommand(0x00, 0x00); return; }
                    if (fdc.activeDrive.writeProtected) { fdc.endCommand(0x02, 0x00); return; }
                    if (fdc.currentTrackData === null) {
                        fdc.endCommand(0x05, 0x01);
                    } else {
                        fdc.setupReadWrite();
                    }
                    break;

                case fdc.PHASE_EXECUTE:
                    fdc.currentSectorData.data[fdc.currentSectorData.readOffset][fdc.fdcBufferIndex] = value;
                    fdc.fdcBufferIndex++;
                    if (fdc.fdcBufferIndex === fdc.bytesToRead) {
                        if (fdc.cmdBuffer[fdc.CMD_IDX_R] === fdc.cmdBuffer[fdc.CMD_IDX_EOT] && fdc.st1 === 0) {
                            fdc.st1 = 0x80;
                        }
                        if (fdc.st1 !== 0 || fdc.st2 !== 0) {
                            fdc.endCommand(fdc.st1, fdc.st2);
                        } else {
                            fdc.cmdBuffer[fdc.CMD_IDX_R] = (fdc.cmdBuffer[fdc.CMD_IDX_R] + 1) & 0xFF;
                            fdc.setupReadWrite();
                        }
                    }
                    break;
            }
        },
    },

    /**
     * WRITE DELETED DATA (opcode 0x09) — identical to WRITE DATA but marks sectors
     * as deleted. exec is aliased to cmdWriteData.exec after init.
     */
    cmdWriteDeletedData: {
        getOpName:    () => "write_del_data (0x09)",
        cmdLength:     8,
        resultLength:  7,
        dataDirection: 0,
        exec: null,
    },

    /**
     * READ TRACK (opcode 0x02) — reads all sectors of a track in physical order.
     * Not yet implemented; throws an error if called.
     */
    cmdReadTrack: {
        getOpName:    () => "read_track (0x02)",
        cmdLength:     8,
        resultLength:  7,
        dataDirection: 0,

        exec() {
            throwError("Error - exec_cmd_read_track() - Not implemented yet");
            Floppy_Controller_FDC.checkDrive();
            Floppy_Controller_FDC.endCommand(0, 0);
        },
    },

    /**
     * READ ID (opcode 0x0A) — returns the ID fields of the next sector header
     * encountered on the current track. Advances currentSectorIdx.
     * Returns ST1=0x05 if the track has no sectors.
     */
    cmdReadId: {
        getOpName:    () => "read_id (0x0a)",
        cmdLength:     1,
        resultLength:  7,
        dataDirection: 0,

        exec() {
            const fdc = Floppy_Controller_FDC;
            let st1;
            if (fdc.checkDrive()) {
                const numSectors = fdc.currentTrackData?.sectors.length ?? 0;
                if (numSectors === 0) {
                    st1 = 0x05;
                } else {
                    const sector = fdc.currentTrackData.sectors[fdc.activeDrive.currentSectorIdx];
                    fdc.activeDrive.currentSectorIdx =
                        (fdc.activeDrive.currentSectorIdx + 1) % numSectors;
                    fdc.cmdBuffer[fdc.CMD_IDX_C] = sector.trackId;
                    fdc.cmdBuffer[fdc.CMD_IDX_H] = sector.sideId;
                    fdc.cmdBuffer[fdc.CMD_IDX_R] = sector.id;
                    fdc.cmdBuffer[fdc.CMD_IDX_N] = sector.size;
                    st1 = 0x00;
                }
            } else {
                fdc.st0 |= 0x08;
                st1 = 0x05;
            }
            fdc.endCommand(st1, 0x00);
        },
    },

    /**
     * FORMAT TRACK (opcode 0x0D) — writes format headers to all sectors of a track.
     * Returns ST1 bit 1 (Write Protected) if the drive is write-protected.
     * Full formatting is not implemented.
     */
    cmdFormatTrack: {
        getOpName:    () => "format_track (0x0d)",
        cmdLength:     5,
        resultLength:  7,
        dataDirection: 0,

        exec() {
            Floppy_Controller_FDC.checkDrive();
            if (!Floppy_Controller_FDC.activeDrive.MediaIn) {
                throwError("Error - exec_cmd_format_track() - Not implemented yet");
            }
            Floppy_Controller_FDC.endCommand(0x02, 0x00);
        },
    },

    /**
     * SCAN EQUAL (opcode 0x11) — compares sectors against CPU-supplied data.
     * Not implemented; throws an error.
     */
    cmdScanEqual: {
        getOpName: () => "scan_eq (0x11)",
        cmdLength: 8, resultLength: 7, dataDirection: 0,
        exec() { throwError("Error - exec_cmd_scan_eq() - Not implemented yet"); Floppy_Controller_FDC.checkDrive(); Floppy_Controller_FDC.endCommand(0, 0); },
    },

    /**
     * SCAN LOW OR EQUAL (opcode 0x19) — compares sectors; matches if disk ≤ CPU data.
     * Not implemented; throws an error.
     */
    cmdScanLowOrEqual: {
        getOpName: () => "scan_low_or_eq (0x19)",
        cmdLength: 8, resultLength: 7, dataDirection: 0,
        exec() { throwError("Error - exec_cmd_scan_low_or_eq() - Not implemented yet"); Floppy_Controller_FDC.checkDrive(); Floppy_Controller_FDC.endCommand(0, 0); },
    },

    /**
     * SCAN HIGH OR EQUAL (opcode 0x1D) — compares sectors; matches if disk ≥ CPU data.
     * Not implemented; throws an error.
     */
    cmdScanHighOrEqual: {
        getOpName: () => "scan_high_or_eq (0x1d)",
        cmdLength: 8, resultLength: 7, dataDirection: 0,
        exec() { throwError("Error - exec_cmd_scan_high_or_eq() - Not implemented yet"); Floppy_Controller_FDC.checkDrive(); Floppy_Controller_FDC.endCommand(0, 0); },
    },

    /**
     * RECALIBRATE (opcode 0x07) — steps the drive head back to track 0.
     * Decrements trackId by up to 77 steps (the maximum for 80-track drives).
     * Sets driveState to FDC_RECALIBRATE if not yet at track 0, or FDC_SEEKING otherwise.
     */
    cmdRecalibrate: {
        getOpName: () => "recalib (0x07)",
        cmdLength: 1, resultLength: 0, dataDirection: 0,
        exec() {
            const fdc = Floppy_Controller_FDC;
            if (fdc.checkDrive()) {
                fdc.activeDrive.trackId = Math.max(fdc.activeDrive.trackId - 77, 0);
                fdc.activeDrive.currentSectorIdx = 0;
                fdc.driveState = fdc.activeDrive.trackId > 0 ? fdc.FDC_RECALIBRATE : fdc.FDC_SEEKING;
            } else {
                fdc.driveState = fdc.FDC_ERROR;
            }
        },
    },

    /**
     * SENSE INTERRUPT STATUS (opcode 0x08) — returns the interrupt cause after a seek
     * or recalibrate operation. Clears driveState after reading.
     * ST0 bits reflect the seek result; PCN (Present Cylinder Number) = current trackId.
     */
    cmdSenseInterruptStatus: {
        getOpName: () => "sense_int_status (0x08)",
        cmdLength: 0, resultLength: 2, dataDirection: 0,
        exec() {
            const fdc = Floppy_Controller_FDC;
            fdc.st0 = (fdc.selectedHead << 2) | fdc.selectedDrive;
            switch (fdc.driveState) {
                case fdc.FDC_SEEKING:     fdc.st0 |= 0x20; break;
                case fdc.FDC_RECALIBRATE: fdc.st0 |= 0x70; break;
                case fdc.FDC_ERROR:       fdc.st0 |= 0x48; break;
                default:                  fdc.st0  = 0x80;  break;
            }
            fdc.driveState = fdc.FDC_IDLE;
            fdc.resBuffer[fdc.RES_IDX_ST0] = fdc.st0;
            fdc.resBuffer[fdc.RES_IDX_PCN] = fdc.activeDrive.trackId;
        },
    },

    /**
     * SPECIFY (opcode 0x03) — programs the FDC timing parameters.
     * Byte 0: bits 7–4 = head unload time, bits 3–0 = step rate.
     * Byte 1: bits 7–1 = head load time, bit 0 = non-DMA mode flag.
     */
    cmdSpecify: {
        getOpName: () => "specify (0x03)",
        cmdLength: 2, resultLength: 0, dataDirection: 0,
        exec() {
            const fdc = Floppy_Controller_FDC;
            fdc.headUnloadTime = (fdc.cmdBuffer[0] >>> 4) & 0x0F;
            fdc.stepRate       =  fdc.cmdBuffer[0] & 0x0F;
            fdc.headLoadTime   = (fdc.cmdBuffer[1] >>> 1) & 0x7F;
            fdc.nonDmaMode     =  fdc.cmdBuffer[1] & 1;
        },
    },

    /**
     * SENSE DRIVE STATUS (opcode 0x04) — returns ST3 describing the physical state
     * of the addressed drive (ready, write-protect, track 0, two-sided, etc.).
     */
    cmdSenseDriveStatus: {
        getOpName: () => "sense_drive_status (0x04)",
        cmdLength: 1, resultLength: 1, dataDirection: 0,
        exec() {
            const fdc   = Floppy_Controller_FDC;
            const ready = fdc.checkDrive();
            const drive = fdc.activeDrive;
            let   st3   = fdc.st0;

            if (drive.ready) {
                st3 |= (drive.writeProtected << 7) | (ready << 5);
                if (drive.diskImage !== null) {
                    st3 |=
                        (drive.MediaIn << 6) |
                        ((drive.trackId === 0 ? 1 : 0) << 4) |
                        ((drive.diskImage.numSides > 1 ? 1 : 0) << 3);
                }
            }
            fdc.resBuffer[fdc.RES_IDX_ST3] = st3;
        },
    },

    /**
     * SEEK (opcode 0x0F) — moves the drive head to the track specified in CMD_IDX_NCN.
     * Clamps to the last available track in the disk image.
     * Sets driveState to FDC_SEEKING on success, FDC_ERROR if the drive is not ready.
     */
    cmdSeek: {
        getOpName: () => "seek (0x0f)",
        cmdLength: 2, resultLength: 0, dataDirection: 0,
        exec() {
            const fdc = Floppy_Controller_FDC;
            if (fdc.checkDrive()) {
                fdc.activeDrive.trackId = Math.min(
                    fdc.cmdBuffer[fdc.CMD_IDX_NCN],
                    fdc.activeDrive.diskImage.numTracks - 1
                );
                fdc.activeDrive.currentSectorIdx = 0;
                fdc.driveState = fdc.FDC_SEEKING;
            } else {
                fdc.driveState = fdc.FDC_ERROR;
            }
        },
    },

    /**
     * INVALID (any unrecognised opcode) — returns ST0 = 0x80 (Invalid Command).
     */
    cmdInvalid: {
        getOpName: () => "invalid_op",
        cmdLength: 0, resultLength: 1, dataDirection: 0,
        exec() {
            Floppy_Controller_FDC.resBuffer[Floppy_Controller_FDC.RES_IDX_ST0] = 0x80;
        },
    },
};

// Post-init: resolve DIR_* constants and alias shared exec implementations.
Floppy_Controller_FDC.cmdReadData.dataDirection        = Floppy_Controller_FDC.DIR_READ;
Floppy_Controller_FDC.cmdReadDeletedData.dataDirection = Floppy_Controller_FDC.DIR_READ;
Floppy_Controller_FDC.cmdReadDeletedData.exec          = Floppy_Controller_FDC.cmdReadData.exec;
Floppy_Controller_FDC.cmdWriteData.dataDirection       = Floppy_Controller_FDC.DIR_WRITE;
Floppy_Controller_FDC.cmdWriteDeletedData.dataDirection= Floppy_Controller_FDC.DIR_WRITE;
Floppy_Controller_FDC.cmdWriteDeletedData.exec         = Floppy_Controller_FDC.cmdWriteData.exec;
Floppy_Controller_FDC.cmdReadTrack.dataDirection       = Floppy_Controller_FDC.DIR_READ;
Floppy_Controller_FDC.cmdReadId.dataDirection          = Floppy_Controller_FDC.DIR_NONE;
Floppy_Controller_FDC.cmdFormatTrack.dataDirection     = Floppy_Controller_FDC.DIR_WRITE;
Floppy_Controller_FDC.cmdScanEqual.dataDirection       = Floppy_Controller_FDC.DIR_WRITE;
Floppy_Controller_FDC.cmdScanLowOrEqual.dataDirection  = Floppy_Controller_FDC.DIR_WRITE;
Floppy_Controller_FDC.cmdScanHighOrEqual.dataDirection = Floppy_Controller_FDC.DIR_WRITE;
Floppy_Controller_FDC.cmdRecalibrate.dataDirection     = Floppy_Controller_FDC.DIR_NONE;
Floppy_Controller_FDC.cmdSenseInterruptStatus.dataDirection = Floppy_Controller_FDC.DIR_NONE;
Floppy_Controller_FDC.cmdSpecify.dataDirection         = Floppy_Controller_FDC.DIR_NONE;
Floppy_Controller_FDC.cmdSenseDriveStatus.dataDirection= Floppy_Controller_FDC.DIR_NONE;
Floppy_Controller_FDC.cmdSeek.dataDirection            = Floppy_Controller_FDC.DIR_NONE;
Floppy_Controller_FDC.cmdInvalid.dataDirection         = Floppy_Controller_FDC.DIR_NONE;


// =============================================================================
// Drive descriptors
// =============================================================================

/**
 * @namespace Floppy_Drive_A
 * @description Descriptor for floppy drive A (unit 0). Enabled by default.
 */
const Floppy_Drive_A = {
    /** @type {string} Drive identifier used in UI elements. */
    name:             "drivea",
    /** @type {string[]} Accepted file extensions for disk image uploads. */
    validExtensions:  ["dsk", "edsk"],
    /** @type {Function} Parser function used to decode disk image files. */
    parserFunc:       DSK_Parser.parseFile,
    /** @type {Object|null} Archive object for zip-wrapped disk images. */
    archiveObj:       null,
    /** @type {Object|null} Parsed disk image object returned by DSK_Parser. */
    diskImage:        null,
    /** @type {number} Current physical track position (0–based). */
    trackId:          0,
    /** @type {number} Index of the next sector to be read by READ ID (rotational position). */
    currentSectorIdx: 0,
    /** @type {boolean} True when a disk is physically inserted in the drive. */
    MediaIn:          true,
    /** @type {boolean} True when the drive is powered and ready for commands. */
    ready:            true,
    /** @type {boolean} True when the disk's write-protect tab is engaged. */
    writeProtected:   false,
    /** @type {boolean} True while the activity LED is lit (FDC in execute phase). */
    activityLed:      false,
    /** @type {HTMLElement|null} DOM element whose background colour represents the LED state. */
    ledElement:       null,
    /** @type {boolean} True if any sector has been written since the disk image was loaded. */
    isDirty:          false,
    /** @type {string} Default filename used when saving the disk image. */
    fileName:         "disk.dsk"
};

/**
 * @namespace Floppy_Drive_B
 * @description Descriptor for floppy drive B (unit 1). Disabled by default (ready = false).
 */
const Floppy_Drive_B = {
    name:             "driveb",
    validExtensions:  ["dsk", "edsk"],
    parserFunc:       DSK_Parser.parseFile,
    archiveObj:       null,
    diskImage:        null,
    trackId:          0,
    currentSectorIdx: 0,
    MediaIn:          true,
    ready:            false,
    writeProtected:   false,
    activityLed:      false,
    ledElement:       null,
    isDirty:          false,
    fileName:         "disk.dsk"
};
