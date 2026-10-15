"use strict";

/**
 * @file Keyboard.js
 * @module CPC_INPUT
 *
 * Amstrad CPC keyboard matrix emulation, input expansion and AutoType.
 *
 * Hardware model: the CPC keyboard is a 10-row × 8-bit matrix, active-low
 * (a bit at 0 means the key is pressed). The row is selected by bits 3:0 of
 * PPI port C and read through PSG register R14 (port A input).
 */

const CPC_INPUT = (() => {
    const {
        CPC_KEYBOARD_MAPS,
        CPC_MODIFIER_KEYS,
        CPC_MODIFIER_NAMES,
        detectLayoutFromNavigatorLanguage,
    } = CPC_KEY_MAP_DATA;

    class Keyboard {
        constructor() {
            /** CPC matrix: active-low, 10 rows × 8 keys. */
            this.matrix = new Uint8Array(10).fill(0xFF);
            this._getSelectedRow = () => 0;
            this._getJoystickEnabled = () => false;
            this.layout = detectLayoutFromNavigatorLanguage();
            this.layoutMap = CPC_KEYBOARD_MAPS[this.layout];
            /** Character → position table of the loaded firmware, same as AutoType. */
            this._characterMaps = null;
            this.modifiers = { shift: false, ctrl: false, alt: false, capsLock: false };
            /** Positions held per `event.code`; one key may drive several matrix points. */
            this._pressedPositions = new Map();
            this._autoType = null;
            this._onFrame = () => this._autoType?.onFrame();
            this._boundKeyDown = (event) => this.keydownEvent(event);
            this._boundKeyUp = (event) => this.keyupEvent(event);
            this._boundBlur = () => this.releaseAll();
            /** Releases pending physical keys when focus enters a host input field. */
            this._boundFocusIn = () => { if (this._isHostInputFocused()) this._flushPhysicalKeys(); };
            this._listenersAttached = false;
        }

        link(bus) {
            if (bus.getSelectedRow) this._getSelectedRow = bus.getSelectedRow;
            if (bus.getJoystickEnabled) this._getJoystickEnabled = bus.getJoystickEnabled;
        }

        /**
         * Sets one matrix point directly (raw mode). Single write point for
         * physical keystrokes, AutoType and joystick.
         *
         * @param {number}  line      Matrix row, 0-9.
         * @param {number}  bit       Bit index in the row, 0-7.
         * @param {boolean} isPressed `true` presses the key (bit cleared to 0).
         * @returns {void}
         */
        setKeyState(line, bit, isPressed) {
            if (line < 0 || line > 9 || bit < 0 || bit > 7) return;
            if (isPressed) this.matrix[line] &= ~(1 << bit);
            else this.matrix[line] |= (1 << bit);
        }

        /** Press one CPC matrix key (bit 0 means pressed). */
        pressKey(line, bit) { this.setKeyState(line, bit, true); }

        /** Release one CPC matrix key. */
        releaseKey(line, bit) { this.setKeyState(line, bit, false); }

        /**
         * Releases every pressed key and restores the idle matrix state without
         * touching the injection queue. The character being injected is put back
         * at the head of the queue instead of being lost.
         *
         * @returns {void}
         */
        releaseAll() {
            this._autoType?.releaseCurrent();
            this.matrix.fill(0xFF);
            for (const name of Object.keys(this.modifiers)) this.modifiers[name] = false;
            this._pressedPositions.clear();
        }

        /** Release all physical and injected keys, restoring active-low idle state. */
        reset() {
            this._autoType?.cancel();
            this.releaseAll();
        }

        /** Return the hardware matrix (10 bytes, active-low). */
        getMatrix() { return this.matrix; }

        /**
         * Appends a string to the FIFO injection queue.
         * @param {string} text Text to type, for example `RUN"DISC\n`.
         * @returns {void}
         */
        typeString(text) { this._autoType?.typeString(text); }

        /** Advances injection by one emulated frame. */
        tick() { this._autoType?.tick(); }

        /** Queue text for frame-synchronised CPC key injection. */
        autotype(text) { this.typeString(text); }

        /** Cancel queued text and release the whole keyboard immediately. */
        cancelAutotype() {
            this._autoType?.cancel();
            this.matrix.fill(0xFF);
            for (const name of Object.keys(this.modifiers)) this.modifiers[name] = false;
            this._pressedPositions.clear();
        }

        /** True while queued text or a press/release cycle remains. */
        isAutotyping() { return this._autoType?.isAutotyping() ?? false; }

        /** Called by the emulation loop once per frame. */
        onFrame() { this._onFrame(); }

        init() {
            this.reset();
            if (this._listenersAttached) return;
            document.addEventListener('keydown', this._boundKeyDown);
            document.addEventListener('keyup', this._boundKeyUp);
            // `focusin` bubbles, so a single listener on `document` covers every
            // focusable element of the panel.
            document.addEventListener('focusin', this._boundFocusIn);
            window.addEventListener('blur', this._boundBlur);
            this._listenersAttached = true;
        }

        /**
         * Releases the keys physically held in the matrix, leaving out the ones
         * AutoType is currently injecting. Unlike `releaseAll()`, the injection
         * queue is left untouched.
         *
         * @returns {void}
         */
        _flushPhysicalKeys() {
            for (const positions of this._pressedPositions.values()) {
                for (const position of positions) this.setKeyState(position.line, position.bit, false);
            }
            this._pressedPositions.clear();
            this._updateModifiers();
        }

        setLayout(layoutCode) {
            const table = CPC_KEYBOARD_MAPS[layoutCode];
            if (!table) {
                console.error(`[Keyboard] Unknown layout: "${layoutCode}"`);
                return false;
            }
            this.reset();
            this.layout = layoutCode;
            this.layoutMap = table;
            return true;
        }

        /** Raw matrix line (active-low). */
        getMatrixRow(row) {
            if (!Number.isInteger(row) || row < 0 || row > 9) return 0xFF;
            return this.matrix[row];
        }

        /**
         * Hardware read of one matrix row, as the AY-3-8912 returns it to the CPU
         * through register 14 (port A). Active-low: a bit at 0 means pressed.
         *
         * @param {number} line Requested row, 0-9.
         * @returns {number} Row byte, active-low.
         */
        readAYPort(line) {
            if (!Number.isInteger(line) || line < 0 || line > 9) return 0xFF;
            // A firmware read opens the gate for the next injected character.
            this._autoType?.noteFirmwareRead();
            return this.matrix[line];
        }

        /**
         * PPI read path: the row designated by `_getSelectedRow()`.
         * Like `readAYPort()`, a firmware read opens the gate for the next
         * injected character.
         */
        readMatrixRow() {
            const row = this._getSelectedRow();
            if (!Number.isInteger(row) || row < 0 || row > 9) return 0xFF;
            this._autoType?.noteFirmwareRead();
            return this.matrix[row];
        }

        /**
         * Tells whether keyboard focus is in a field where the user TYPES text.
         * Only `<input>` types that are editable with the keyboard count:
         * `range`, `color`, `file`, `checkbox`, `radio` and buttons are excluded,
         * so arrow keys stay with the CPC.
         *
         * @returns {boolean} `true` when focus is in a keyboard-editable field.
         */
        _isHostInputFocused() {
            const noeud = document.activeElement;
            if (!noeud) return false;
            if (noeud.isContentEditable === true) return true;
            if (noeud.tagName === "TEXTAREA") return true;
            if (noeud.tagName !== "INPUT") return false;
            // `input.type` is lower-cased by the DOM and defaults to `text`.
            return Keyboard.TEXT_INPUT_TYPES.has(noeud.type);
        }

        keydownEvent(event) {
            // Focus is in a host input field: the matrix and `preventDefault`
            // are both left alone, so arrows and backspace keep working there.
            if (this._isHostInputFocused()) {
                // Safety net for a focus change that the `focusin` listener did
                // not see: release the keys still held.
                if (this._pressedPositions.size > 0) this._flushPhysicalKeys();
                return;
            }
            // AltGr arrives as `ControlLeft` followed by `AltRight`: the CTRL
            // position already set by the host belongs to character composition,
            // not to CPC state, so it is released here.
            if (this._isAltGrKey(event) || this._altGrActive(event)) {
                this._releaseAltGrCarriers();
            }
            if (Keyboard.CRITICAL_CODES.has(event.code)) event.preventDefault();
            if (this._pressedPositions.has(event.code)) return;
            const positions = this.translateEvent(event);
            if (!positions || positions.length === 0) return;
            this._pressedPositions.set(event.code, positions);
            for (const pos of positions) this.pressKey(pos.line, pos.bit);
            this._updateModifiers();
        }

        keyupEvent(event) {
            // The release is always processed, even when focus has moved to a
            // host input: a key pressed before that must come back up, otherwise
            // the firmware keeps it held. Only `preventDefault` depends on focus.
            if (!this._isHostInputFocused() && Keyboard.CRITICAL_CODES.has(event.code)) {
                event.preventDefault();
            }
            this._releaseTrackedCode(event.code);
        }

        /**
         * Releases the CPC positions set by a `code` and forgets that `code`. A
         * shared position is released only when no other held key keeps it down:
         * SHIFT is shared by both letters of an uppercase pair.
         *
         * @param {string} code `KeyboardEvent.code` to release.
         * @returns {void}
         */
        _releaseTrackedCode(code) {
            const positions = this._pressedPositions.get(code);
            if (!positions) return;
            this._pressedPositions.delete(code);
            const stillHeld = new Set();
            for (const list of this._pressedPositions.values()) {
                for (const held of list) stillHeld.add(`${held.line}:${held.bit}`);
            }
            for (const pos of positions) {
                if (!stillHeld.has(`${pos.line}:${pos.bit}`)) this.releaseKey(pos.line, pos.bit);
            }
            this._updateModifiers();
        }

        /**
         * Tells whether the event is the host AltGr key — a COMPOSITION modifier,
         * not a CPC key. Windows and Linux report it as `key === "AltGraph"`;
         * macOS (Option) and layouts without AltGr report "Alt" instead while
         * still using it to compose, so the `code` of the RIGHT key decides.
         *
         * The right key therefore types nothing on the CPC; the joystick fire
         * button stays reachable through `AltLeft` (9:5) and `ControlLeft` (9:4)
         * — see `translateEvent()`.
         *
         * @param {{key?: string, code?: string}} event Keyboard event.
         * @returns {boolean}
         */
        _isAltGrKey(event) {
            return event.key === "AltGraph" || event.code === "AltRight";
        }

        /**
         * Tells whether AltGr is engaged during this event, both on the AltGr key
         * itself and on the character it composes. A missing `getModifierState`
         * means "no".
         *
         * @param {{getModifierState?: Function}} event Keyboard event.
         * @returns {boolean}
         */
        _altGrActive(event) {
            return typeof event.getModifierState === "function"
                && event.getModifierState("AltGraph") === true;
        }

        /**
         * Removes the positions set by the keys that only carry AltGr
         * (`Keyboard.ALTGRAF_CARRIERS`). The composed character then arrives
         * through the character path, which needs no host modifier.
         *
         * @returns {void}
         */
        _releaseAltGrCarriers() {
            for (const code of Keyboard.ALTGRAF_CARRIERS) this._releaseTrackedCode(code);
        }

        _updateModifiers() {
            for (const name of Object.keys(this.modifiers)) {
                this.modifiers[name] = [...this._pressedPositions.keys()].some(
                    (code) => CPC_MODIFIER_NAMES[code] === name,
                );
            }
        }

        /** Character → position table of the currently selected firmware. */
        _characterTable() {
            const maps = this._characterMaps;
            if (!maps) return null;
            return maps[this.layout] || maps.US || null;
        }

        /**
         * Translates a keyboard event into CPC matrix positions.
         *
         * The lookup key is the CHARACTER produced by the key (`event.key`), not
         * the key itself: the loaded firmware tells which CPC key types that
         * character. Keys that produce no character — arrows, RETURN, TAB,
         * modifiers, F1-F12 — are resolved by their physical POSITION through
         * `layoutMap[event.code]`. AltGr is handled first, see below.
         *
         * @param {{code: string, key?: string}} event Keyboard event.
         * @returns {Array<{line: number, bit: number}>|null} Positions to press,
         *          or `null` when the key has no CPC equivalent.
         */
        translateEvent(event) {
            // AltGr types nothing: it is the host composition modifier and the
            // composed character is translated by the firmware table.
            if (this._isAltGrKey(event)) return null;

            if (this._getJoystickEnabled()) {
                switch (event.code) {
                    case "ArrowLeft": return [{ line: 9, bit: 2 }];
                    case "ArrowUp": return [{ line: 9, bit: 0 }];
                    case "ArrowRight": return [{ line: 9, bit: 3 }];
                    case "ArrowDown": return [{ line: 9, bit: 1 }];
                    case "ControlLeft": case "ControlRight": return [{ line: 9, bit: 4 }];
                    case "AltLeft": case "AltRight": return [{ line: 9, bit: 5 }];
                }
            }

            const character = event.key;
            const table = this._characterTable();
            if (table && typeof character === "string" && character.length === 1) {
                const descriptor = table[character];
                if (descriptor) {
                    const positions = [{ line: descriptor.line, bit: descriptor.bit }];
                    // Uppercase letters and top-row symbols need SHIFT: it is
                    // pressed together with the key, as AutoType does.
                    if (descriptor.shift) positions.push(Keyboard.SHIFT_POSITION);
                    if (descriptor.ctrl) positions.push(Keyboard.CTRL_POSITION);
                    return positions;
                }
                // Character missing from the table: fall back to the physical
                // position. Accents (`é`, `è`, `ç`, `à`, `ù`…) are produced by the
                // CPC from the key position, not from its translation table, and
                // the host AZERTY keyboard has the same geometry as the French
                // CPC one. The `layoutMap` lookup below handles it.
            }

            const pos = this.layoutMap[event.code];
            return pos ? [pos] : null;
        }

        /**
         * Translation from `event.code` alone.
         * @param {string} code `KeyboardEvent.code`.
         * @returns {{line: number, bit: number}|null} CPC position.
         */
        translateCode(code) {
            const positions = this.translateEvent({ code });
            return positions && positions.length > 0 ? positions[0] : null;
        }
    }

    // Keys whose native browser action conflicts with the CPC and must therefore
    // be neutralised. `AltLeft`/`AltRight` are listed because ALT is the CPC CAPS
    // key (row 1, bit 1).
    Keyboard.CRITICAL_CODES = new Set([
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "Tab", "Backspace",
        "AltLeft", "AltRight",
        ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
    ]);

    // Host keys that only CARRY AltGr on a French keyboard: Windows splits AltGr
    // into `ControlLeft` + `AltRight`, Linux only sends `AltRight`. Their press is
    // removed from the matrix as soon as composition starts. `AltLeft` alone is
    // not a carrier and stays injected as is.
    Keyboard.ALTGRAF_CARRIERS = ["ControlLeft", "ControlRight", "AltRight"];

    // `<input>` types where the user TYPES text and which therefore receive
    // keystrokes instead of the CPC. `range`, `color`, `file`, `checkbox`,
    // `radio`, `button`, `submit`, `reset` and `image` are controls, not editors,
    // and are deliberately absent.
    Keyboard.TEXT_INPUT_TYPES = new Set([
        "text", "search", "url", "tel", "email", "password", "number",
        "date", "month", "week", "time", "datetime-local",
    ]);

    // CPC positions of SHIFT and CTRL, derived from the modifier table. The CPC
    // has one key of each: left and right share the position.
    Keyboard.SHIFT_POSITION = CPC_MODIFIER_KEYS.ShiftLeft;
    Keyboard.CTRL_POSITION = CPC_MODIFIER_KEYS.ControlLeft;

    /**
     * Emulates the CPC expansion joystick port (DB9 connector).
     * The I/O byte is decoded from address A12; joystick values are active-low.
     */
    class InputExpansion {
        constructor() {
            this.buttonState = 1;
            this.data = 0;
        }

        reset() {
            this.buttonState = 1;
            this.data = 0;
        }

        writePort(addr, data) {
            if (((addr >>> 8) & 0x10) === 0) {
                this.data = data & 0x7F;
                this.buttonState = (data >>> 7) === 1 ? 0 : 1;
            }
        }

        readButton() { return 1; }

        get joystick1() { return 1; }
        get joystick2() { return 0; }
    }

// ---------------------------------------------------------------------------
// InputExpansion — Extended joystick port (DB9 connector)
// ---------------------------------------------------------------------------

/**
 * @class InputExpansion
 * @description Emulates the CPC expansion joystick port (DB9).
 *
 * The port responds to I/O writes where (addr >>> 8) & 0x10 === 0 (A12 = 0).
 * Data byte layout:
 *   Bits 6:0 — output data lines
 *   Bit  7   — button state (0 = pressed, 1 = released; inverted logic)
 *
 * readButton() always returns 1 (released) because no secondary button
 * is physically connected in this implementation.
 */


/**
 * @class AutoType
 * @description Injects queued characters into the CPC in sync with emulated frames.
 *
 * Text is mapped through the character table of the LOADED firmware
 * (`AUTOTYPE_MAPS[keyboard.layout]`) and queued FIFO. The emulated display
 * calls tick() once per rendered emulation frame; a character is held for
 * PRESS_FRAMES frame(s), released for RELEASE_FRAMES, and no host timer drives
 * key injection — what actually paces the typing is the firmware READING the
 * matrix, counted by `noteFirmwareRead()`.
 *
 * The mapping does not depend on the host keyboard layout, but it does depend
 * on the loaded firmware ROM: the same matrix position types `1` on the English
 * ROM and `&` on the French one. Each descriptor holds a position plus its
 * shift/ctrl modifiers, never a character value. Characters outside the table
 * are ignored silently rather than typed approximately. Matrix descriptors use
 * a zero-based bit index.
 */
const createAutoType = (keyboard) => {

    // Standard UK table: matrix position → characters it produces, extracted from
    // the UK firmware translation table (240 bytes patched at 0x1D69 on the 464
    // and 0x1EEF on the 6128: three blocks of 80 bytes — unshifted, shifted,
    // COPY — for the 10 rows of 8 keys). Only printable ASCII (0x20-0x7E) is
    // kept; the line break is the ENTER key, coded 0x0D by the firmware.
    // `buildAutoTypeMap()` inverts it into `character → { line, bit, shift }`.
    const UK_CHARACTER_TABLE = {
        // Row 2
        '2:1:0:0': ['['], '2:1:1:0': ['{'], '2:2:0:0': ['LF', 'CR'], '2:3:0:0': [']'], '2:3:1:0': ['}'], '2:6:0:0': ['\\'], '2:6:1:0': ['`'],
        // Row 3
        '3:0:0:0': ['^'], '3:1:0:0': ['-'], '3:1:1:0': ['='], '3:2:0:0': ['@'], '3:2:1:0': ['|'], '3:3:0:0': ['p'], '3:3:1:0': ['P'], '3:4:0:0': [';'], '3:4:1:0': ['+'], '3:5:0:0': [':'], '3:5:1:0': ['*'], '3:6:0:0': ['/'], '3:6:1:0': ['?'], '3:7:0:0': ['.'], '3:7:1:0': ['>'],
        // Row 4
        '4:0:0:0': ['0'], '4:0:1:0': ['_'], '4:1:0:0': ['9'], '4:1:1:0': [')'], '4:2:0:0': ['o'], '4:2:1:0': ['O'], '4:3:0:0': ['i'], '4:3:1:0': ['I'], '4:4:0:0': ['l'], '4:4:1:0': ['L'], '4:5:0:0': ['k'], '4:5:1:0': ['K'], '4:6:0:0': ['m'], '4:6:1:0': ['M'], '4:7:0:0': [','], '4:7:1:0': ['<'],
        // Row 5
        '5:0:0:0': ['8'], '5:0:1:0': ['('], '5:1:0:0': ['7'], '5:1:1:0': ['\''], '5:2:0:0': ['u'], '5:2:1:0': ['U'], '5:3:0:0': ['y'], '5:3:1:0': ['Y'], '5:4:0:0': ['h'], '5:4:1:0': ['H'], '5:5:0:0': ['j'], '5:5:1:0': ['J'], '5:6:0:0': ['n'], '5:6:1:0': ['N'], '5:7:0:0': [' '],
        // Row 6
        '6:0:0:0': ['6'], '6:0:1:0': ['&'], '6:1:0:0': ['5'], '6:1:1:0': ['%'], '6:2:0:0': ['r'], '6:2:1:0': ['R'], '6:3:0:0': ['t'], '6:3:1:0': ['T'], '6:4:0:0': ['g'], '6:4:1:0': ['G'], '6:5:0:0': ['f'], '6:5:1:0': ['F'], '6:6:0:0': ['b'], '6:6:1:0': ['B'], '6:7:0:0': ['v'], '6:7:1:0': ['V'],
        // Row 7
        '7:0:0:0': ['4'], '7:0:1:0': ['$'], '7:1:0:0': ['3'], '7:1:1:0': ['#'], '7:2:0:0': ['e'], '7:2:1:0': ['E'], '7:3:0:0': ['w'], '7:3:1:0': ['W'], '7:4:0:0': ['s'], '7:4:1:0': ['S'], '7:5:0:0': ['d'], '7:5:1:0': ['D'], '7:6:0:0': ['c'], '7:6:1:0': ['C'], '7:7:0:0': ['x'], '7:7:1:0': ['X'],
        // Row 8
        '8:0:0:0': ['1'], '8:0:1:0': ['!'], '8:1:0:0': ['2'], '8:1:0:1': ['~'], '8:1:1:0': ['"'], '8:3:0:0': ['q'], '8:3:1:0': ['Q'], '8:4:0:0': ['TAB'], '8:5:0:0': ['a'], '8:5:1:0': ['A'], '8:7:0:0': ['z'], '8:7:1:0': ['Z'],
    };

    // French and Spanish tables, extracted the same way from the French and
    // Spanish firmwares (see `scripts/extract-keytrans.mjs`). They are required:
    // injecting UK positions into a French ROM types the wrong characters
    // (in AZERTY `a` is at 8:3, not 8:5, `z` at 7:3, `w` at 8:7, `m` at 3:5).
    //
    // The five accents are written by glyph, not by byte: the French firmware
    // substitutes the drawing of five ASCII glyphs (`0x7B` `0x7D` `0x40` `0x7C`
    // `0x5C` display as `é` `è` `à` `ù` `ç`), which a byte-based extraction cannot
    // see. The matching glyphs `{`, `}`, `@`, `|` and `\` do not exist on a
    // French CPC and are therefore not declared.
    const FR_CHARACTER_TABLE = {
    // Row 2
    '2:1:0:0': ['*'], '2:1:1:0': ['<'], '2:2:0:0': ['CR'], '2:3:0:0': ['#'], '2:3:1:0': ['>'], '2:6:0:0': ['$'], 
    // Row 3
    '3:0:0:0': ['-'], '3:0:1:0': ['_'], '3:1:0:0': [')'], '3:1:1:0': ['['], '3:2:0:0': ['^'], '3:3:0:0': ['p'], '3:3:1:0': ['P'], '3:4:0:0': ['ù'], '3:4:1:0': ['%'], '3:5:0:0': ['m'], '3:5:1:0': ['M'], '3:6:0:0': ['='], '3:6:1:0': ['+'], '3:7:0:0': [':'], '3:7:1:0': ['/'], 
    // Row 4
    '4:0:0:0': ['à'], '4:0:1:0': ['0'], '4:1:0:0': ['ç'], '4:1:1:0': ['9'], '4:2:0:0': ['o'], '4:2:1:0': ['O'], '4:3:0:0': ['i'], '4:3:1:0': ['I'], '4:4:0:0': ['l'], '4:4:1:0': ['L'], '4:5:0:0': ['k'], '4:5:1:0': ['K'], '4:6:0:0': [','], '4:6:1:0': ['?'], '4:7:0:0': [';'], '4:7:1:0': ['.'], 
    // Row 5
    '5:0:0:0': ['!'], '5:0:1:0': ['8'], '5:1:0:0': ['è'], '5:1:1:0': ['7'], '5:2:0:0': ['u'], '5:2:1:0': ['U'], '5:3:0:0': ['y'], '5:3:1:0': ['Y'], '5:4:0:0': ['h'], '5:4:1:0': ['H'], '5:5:0:0': ['j'], '5:5:1:0': ['J'], '5:6:0:0': ['n'], '5:6:1:0': ['N'], '5:7:0:0': ['SP'], 
    // Row 6
    '6:0:0:0': [']'], '6:0:1:0': ['6'], '6:1:0:0': ['('], '6:1:1:0': ['5'], '6:2:0:0': ['r'], '6:2:1:0': ['R'], '6:3:0:0': ['t'], '6:3:1:0': ['T'], '6:4:0:0': ['g'], '6:4:1:0': ['G'], '6:5:0:0': ['f'], '6:5:1:0': ['F'], '6:6:0:0': ['b'], '6:6:1:0': ['B'], '6:7:0:0': ['v'], '6:7:1:0': ['V'], 
    // Row 7
    '7:0:0:0': ['\''], '7:0:1:0': ['4'], '7:1:0:0': ['"'], '7:1:1:0': ['3'], '7:2:0:0': ['e'], '7:2:1:0': ['E'], '7:3:0:0': ['z'], '7:3:1:0': ['Z'], '7:4:0:0': ['s'], '7:4:1:0': ['S'], '7:5:0:0': ['d'], '7:5:1:0': ['D'], '7:6:0:0': ['c'], '7:6:1:0': ['C'], '7:7:0:0': ['x'], '7:7:1:0': ['X'], 
    // Row 8
    '8:0:0:0': ['&'], '8:0:1:0': ['1'], '8:1:0:0': ['é'], '8:1:1:0': ['2'], '8:1:0:1': ['~'], '8:3:0:0': ['a'], '8:3:1:0': ['A'], '8:4:0:0': ['TAB'], '8:5:0:0': ['q'], '8:5:1:0': ['Q'], '8:7:0:0': ['w'], '8:7:1:0': ['W'],
    };

    const ES_CHARACTER_TABLE = {
    // Row 2
    '2:1:0:0': ['['], '2:1:1:0': ['*'], '2:2:0:0': ['CR'], '2:3:0:0': [']'], '2:3:1:0': ['+'], '2:6:0:0': ['BS'], '2:6:1:0': ['`'], 
    // Row 3
    '3:0:0:0': ['^'], '3:1:0:0': ['-'], '3:1:1:0': ['='], '3:2:0:0': ['@'], '3:2:1:0': ['|'], '3:3:0:0': ['p'], '3:3:1:0': ['P'], '3:4:0:0': [';'], '3:4:1:0': [':'], '3:6:0:0': ['/'], '3:6:1:0': ['?'], '3:7:0:0': ['.'], '3:7:1:0': ['>'], 
    // Row 4
    '4:0:0:0': ['0'], '4:0:1:0': ['_'], '4:1:0:0': ['9'], '4:1:1:0': [')'], '4:1:0:1': ['}'], '4:2:0:0': ['o'], '4:2:1:0': ['O'], '4:3:0:0': ['i'], '4:3:1:0': ['I'], '4:4:0:0': ['l'], '4:4:1:0': ['L'], '4:5:0:0': ['k'], '4:5:1:0': ['K'], '4:6:0:0': ['m'], '4:6:1:0': ['M'], '4:7:0:0': [','], '4:7:1:0': ['<'], 
    // Row 5
    '5:0:0:0': ['8'], '5:0:1:0': ['('], '5:0:0:1': ['{'], '5:1:0:0': ['7'], '5:1:1:0': ['\''], '5:2:0:0': ['u'], '5:2:1:0': ['U'], '5:3:0:0': ['y'], '5:3:1:0': ['Y'], '5:4:0:0': ['h'], '5:4:1:0': ['H'], '5:5:0:0': ['j'], '5:5:1:0': ['J'], '5:6:0:0': ['n'], '5:6:1:0': ['N'], '5:7:0:0': ['SP'], 
    // Row 6
    '6:0:0:0': ['6'], '6:0:1:0': ['&'], '6:1:0:0': ['5'], '6:1:1:0': ['%'], '6:2:0:0': ['r'], '6:2:1:0': ['R'], '6:3:0:0': ['t'], '6:3:1:0': ['T'], '6:4:0:0': ['g'], '6:4:1:0': ['G'], '6:5:0:0': ['f'], '6:5:1:0': ['F'], '6:6:0:0': ['b'], '6:6:1:0': ['B'], '6:7:0:0': ['v'], '6:7:1:0': ['V'], 
    // Row 7
    '7:0:0:0': ['4'], '7:0:1:0': ['$'], '7:1:0:0': ['3'], '7:1:1:0': ['#'], '7:2:0:0': ['e'], '7:2:1:0': ['E'], '7:3:0:0': ['w'], '7:3:1:0': ['W'], '7:4:0:0': ['s'], '7:4:1:0': ['S'], '7:5:0:0': ['d'], '7:5:1:0': ['D'], '7:6:0:0': ['c'], '7:6:1:0': ['C'], '7:7:0:0': ['x'], '7:7:1:0': ['X'], 
    // Row 8
    '8:0:0:0': ['1'], '8:0:1:0': ['!'], '8:1:0:0': ['2'], '8:1:1:0': ['"'], '8:1:0:1': ['~'], '8:3:0:0': ['q'], '8:3:1:0': ['Q'], '8:4:0:0': ['TAB'], '8:5:0:0': ['a'], '8:5:1:0': ['A'], '8:7:0:0': ['z'], '8:7:1:0': ['Z'],
    };

    /**
     * Inverted table: character → key descriptor. A descriptor holds only a
     * position and its modifiers, never a character value.
     *
     * @param {Object} table Table `{ 'row:bit:shift:ctrl': [labels] }`.
     * @returns {Object} Frozen `{ line, bit, shift, ctrl }` table, indexed by character.
     */
    const buildAutoTypeMap = (table) => {
        const result = {};
        const poser = (key, line, bit, shift, ctrl) => {
            if (result[key]) return;
            result[key] = Object.freeze({
                line, bit, shift: shift === 1, ctrl: ctrl === 1,
            });
        };

        for (const [position, characters] of Object.entries(table)) {
            const [line, bit, shift, ctrl] = position.split(':').map(Number);
            for (const label of characters) {
                // `LF`, `CR`, `TAB`, `SP` and `BS` are readable aliases for
                // characters that are invisible in a quoted string.
                const key = label === 'LF' ? String.fromCharCode(10)
                    : label === 'CR' ? String.fromCharCode(13)
                    : label === 'TAB' ? String.fromCharCode(9)
                    : label === 'SP' ? ' '
                    : label === 'BS' ? '\\'
                    : label;
                poser(key, line, bit, shift, ctrl);

                // LF and CR are the same physical key: `typeString()` normalises
                // every line break to `\n` (LF), so CR also answers for LF.
                if (label === 'CR') poser(String.fromCharCode(10), line, bit, shift, ctrl);
            }
        }
        return Object.freeze(result);
    };

    // Injection tables, one per firmware: the active table follows the LOADED
    // firmware, not the user's keyboard. The key is `US` (and not `UK`) to match
    // the layout names of `CPC_KEYBOARD_MAPS`, so that
    // `AUTOTYPE_MAPS[keyboard.layout]` works without a mapping table.
    const AUTOTYPE_MAPS = Object.freeze({
        US: buildAutoTypeMap(UK_CHARACTER_TABLE),
        FR: buildAutoTypeMap(FR_CHARACTER_TABLE),
        ES: buildAutoTypeMap(ES_CHARACTER_TABLE),
    });

    // Injection state machine: `PRESS` holds the key (and SHIFT) in the matrix
    // for PRESS_FRAMES frames, `RELEASE` releases it for RELEASE_FRAMES frames.
    // Pacing is guaranteed by the firmware gate below, not by frame duration.
    const PRESS_FRAMES = 1;
    const RELEASE_FRAMES = 1;

    const queue = [];
    let phase = 'IDLE';
    let currentKey = null;
    let pressFramesLeft = 0;
    let releaseFramesLeft = 0;
    let pressedByAutoType = [];

    // Firmware gate: counts the real matrix reads (`readAYPort()` calls, i.e.
    // reads of PSG register 14) and only allows a keystroke once the firmware has
    // been observed. Queued text stays intact until the program listens.
    let firmwareReads = 0;
    let readsAtLastKeystroke = 0;
    let readsAtPress = 0;
    let readsAtRelease = 0;

    /** Has the firmware read the keyboard since the previous keystroke? */
    function firmwareIsListening() {
        return firmwareReads > readsAtLastKeystroke;
    }

    function releaseCurrent() {
        for (const position of pressedByAutoType) {
            keyboard.setKeyState(position.line, position.bit, false);
        }
        pressedByAutoType = [];
        currentKey = null;
    }

    /**
     * Releases the keys currently injected without emptying the queue. The
     * character being injected is put back at the head of the queue so that it
     * is typed again.
     */
    function suspend() {
        if (currentKey) queue.unshift(currentKey);
        releaseCurrent();
        pressFramesLeft = 0;
        releaseFramesLeft = 0;
        phase = 'IDLE';
    }

    function pressPosition(line, bit) {
        if (keyboard.matrix[line] & (1 << bit)) {
            keyboard.setKeyState(line, bit, true);
            pressedByAutoType.push({ line, bit });
        }
    }

    function beginNextCharacter() {
        // Firmware gate: nothing is sent until the CPC has read the matrix since
        // the previous keystroke.
        if (queue.length > 0 && !firmwareIsListening()) return;

        readsAtLastKeystroke = firmwareReads;
        currentKey = queue.shift() || null;
        if (!currentKey) {
            phase = 'IDLE';
            return;
        }
        pressPosition(currentKey.line, currentKey.bit);
        // SHIFT is CPC key 2:5 and CTRL is 2:7.
        if (currentKey.shift) pressPosition(2, 5);
        if (currentKey.ctrl) pressPosition(2, 7);
        pressFramesLeft = PRESS_FRAMES;
        readsAtPress = firmwareReads;
        phase = 'PRESS';
    }

    /** One emulated frame: advances the state machine. */
    function tick() {
        if (phase === 'IDLE') {
            beginNextCharacter();
            return;
        }

        if (phase === 'PRESS') {
            // Both conditions must hold: the minimum time elapsed AND the press
            // seen by the firmware.
            const firmwareHasSeenPress = firmwareReads > readsAtPress;
            if (pressFramesLeft > 1 || !firmwareHasSeenPress) {
                if (pressFramesLeft > 1) pressFramesLeft--;
                return;
            }
            releaseCurrent();
            releaseFramesLeft = RELEASE_FRAMES;
            readsAtRelease = firmwareReads;
            phase = 'RELEASE';
            return;
        }

        if (phase === 'RELEASE') {
            // The release must be observed: two identical keystrokes ("RR") only
            // differ when the firmware sees the key come back up between them.
            const firmwareHasSeenRelease = firmwareReads > readsAtRelease;
            if (releaseFramesLeft > 1 || !firmwareHasSeenRelease) {
                if (releaseFramesLeft > 1) releaseFramesLeft--;
                return;
            }
            // No buffer phase is needed: `firmwareHasSeenRelease` and
            // `firmwareIsListening()` already guarantee an empty matrix frame
            // between two characters.
            phase = 'IDLE';
            return;
        }
    }

    /**
     * Appends a string to the FIFO queue. Each character is turned into a
     * descriptor from the table of the LOADED firmware (`keyboard.layout`), so
     * the typed text depends on the selected ROM and not on any host keyboard.
     * A CRLF is normalised to a single line break and characters outside the
     * table are ignored.
     *
     * @param {string} text Text to type, for example `RUN"DISC\n`.
     * @returns {void}
     */
    function typeString(text) {
        const normalized = String(text).replace(/\r\n?/g, '\n');
        // The table is picked when queueing, according to the firmware selected
        // at that moment.
        const table = AUTOTYPE_MAPS[keyboard.layout] || AUTOTYPE_MAPS.US;
        for (const character of normalized) {
            const descriptor = table[character];
            if (descriptor) queue.push(descriptor);
        }
    }

    function cancel() {
        queue.length = 0;
        releaseCurrent();
        pressFramesLeft = 0;
        releaseFramesLeft = 0;
        phase = 'IDLE';
        keyboard.matrix.fill(0xFF);
        for (const name of Object.keys(keyboard.modifiers)) keyboard.modifiers[name] = false;
        keyboard._pressedPositions.clear();
    }

    function isAutotyping() {
        return queue.length > 0 || phase !== 'IDLE';
    }

    return {
        typeString,
        // `autotype` and `onFrame` are aliases kept for the pages and the UI.
        autotype: typeString,
        inject: typeString,
        tick,
        onFrame: tick,
        cancel,
        suspend,
        // Records a real matrix read by the firmware: this opens the gate.
        noteFirmwareRead() { firmwareReads++; },
        isAutotyping,
        PRESS_FRAMES,
        RELEASE_FRAMES,
        get queue() { return queue; },
        get maps() { return AUTOTYPE_MAPS; },
    };
};

    /**
     * @class AutoType
     * @description Injects characters into the matrix, synchronised with emulated frames.
     */
    class AutoType {
        constructor(keyboard) {
            this._engine = createAutoType(keyboard);
            keyboard._autoType = this;
            // Physical keystrokes and AutoType share the same firmware table.
            keyboard._characterMaps = this._engine.maps;
        }

        /** Appends a string to the FIFO queue. */
        typeString(text) { return this._engine.typeString(text); }
        /** One emulated frame: advances the state machine. */
        tick() { return this._engine.tick(); }
        cancelAutotype() { return this._engine.cancel(); }
        /** Releases the current keystroke, keeping the pending text. */
        releaseCurrent() { return this._engine.suspend(); }
        /** Records a matrix read by the firmware. */
        noteFirmwareRead() { return this._engine.noteFirmwareRead(); }
        cancel() { return this.cancelAutotype(); }
        isAutotyping() { return this._engine.isAutotyping(); }

        // Aliases kept for existing callers.
        autotype(text) { return this.typeString(text); }
        inject(text) { return this.typeString(text); }
        onFrame() { return this.tick(); }

        get queue() { return this._engine.queue; }
        get maps() { return this._engine.maps; }
    }

    // Expose classes and instances only through this stable namespace binding.
    const keyboard = new Keyboard();
    const inputExpansion = new InputExpansion();
    const autoType = new AutoType(keyboard);
    return Object.freeze({
        Keyboard,
        InputExpansion,
        AutoType,
        keyboard,
        inputExpansion,
        autoType,
        AUTOTYPE_MAPS: autoType.maps,
        detectLayoutFromNavigatorLanguage,
    });
})();

(function () {
    function demarrer() {
        UI_Manager.bindKeyboard();
      };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', demarrer, { once: true });
    } else {
        demarrer();
    }
})();
