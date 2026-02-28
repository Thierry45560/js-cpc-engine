"use strict";

/**
 * @module Keyboard_Manager
 * @description Amstrad CPC keyboard matrix emulation, DOM event handling,
 * layout switching, and AutoType keystroke injection.
 *
 * Hardware model:
 *   The CPC keyboard is a 10-row × 8-bit matrix.
 *   - A bit value of 0 means the key is pressed (inverted logic).
 *   - The row to read is selected by bits 3:0 of PPI Port C.
 *   - The matrix is read via PSG register R14 (Port A input).
 *
 * Module structure:
 *   1. Keyboard_Manager  — matrix state, layout mapping, DOM events
 *   2. InputExpansion    — DB9 joystick expansion port
 *   3. AutoType          — ROM-synchronised keystroke injection engine
 */

const Keyboard_Manager = {

    /** @type {Object|null} Bus reference (retained for backwards compatibility). */
    _bus: null,

    /**
     * @type {Function|null} Returns the PPI-selected row index (0–9).
     * Injected by link() from CPC_Bus.
     */
    _getSelectedRow    : null,

    /**
     * @type {Function|null} Returns true when digital joystick remapping is active.
     * Injected by link() from CPC_Bus.
     */
    _getJoystickEnabled: null,

    /**
     * Injects bus accessor functions so Keyboard_Manager has no direct
     * dependency on the global bus object at call time.
     * @param {Object} bus - CPC_Bus instance exposing getSelectedRow and getJoystickEnabled.
     */
    link(bus) {
        if (bus.getSelectedRow)     this._getSelectedRow     = bus.getSelectedRow;
        if (bus.getJoystickEnabled) this._getJoystickEnabled = bus.getJoystickEnabled;
    },

    /** @type {Uint8Array} 10-row keyboard matrix; bit=0 → key pressed, bit=1 → released. */
    matrix    : new Uint8Array(10),

    /**
     * @type {Array} Sparse array mapping DOM keyCode (0–255) to a [row, bitMask] pair,
     * or null for unmapped keys. Rebuilt by setLayout() on every locale change.
     */
    keyCodeMap : new Array(256),

    // ── AutoType synchronisation state ───────────────────────────────────────

    /**
     * @type {{row:number, bit:number, shift?:boolean, ctrl?:boolean}|null}
     * Key descriptor currently being injected. null = no injection active.
     */
    autoTypeKey      : null,

    /**
     * @type {boolean} Set to true by readMatrixRow() when the ROM firmware scans
     * the row that contains autoTypeKey. AutoType._poll() watches this flag.
     */
    autoTypeScanDone : false,

    /**
     * @type {number} Monotonically increasing count of readMatrixRow() calls.
     * AutoType uses this to measure inter-key gaps in scan-cycle units.
     */
    autoTypeScanCount: 0,

    // ── CPC matrix coordinates [row, bitMask] ────────────────────────────────
    // Source: Amstrad CPC 464/664/6128 technical reference manual.

    KEY_ESC      : [8,   4], KEY_1        : [8,   1], KEY_2        : [8,   2],
    KEY_3        : [7,   2], KEY_4        : [7,   1], KEY_5        : [6,   2],
    KEY_6        : [6,   1], KEY_7        : [5,   2], KEY_8        : [5,   1],
    KEY_9        : [4,   2], KEY_0        : [4,   1], KEY_MINUS    : [3,   2],
    KEY_CARET    : [3,   1], KEY_CLR      : [2,   1], KEY_BACKSPACE: [9, 128],
    KEY_TAB      : [8,  16], KEY_Q_EN     : [8,   8], KEY_W_EN     : [7,   8],
    KEY_E        : [7,   4], KEY_R        : [6,   4], KEY_T        : [6,   8],
    KEY_Y        : [5,   8], KEY_U        : [5,   4], KEY_I        : [4,   8],
    KEY_O        : [4,   4], KEY_P        : [3,   8], KEY_AT       : [3,   4],
    KEY_LBRACKET : [2,   2], KEY_ENTER    : [2,   4], KEY_CAPS_LOCK: [8,  64],
    KEY_A_EN     : [8,  32], KEY_S        : [7,  16], KEY_D        : [7,  32],
    KEY_F        : [6,  32], KEY_G        : [6,  16], KEY_H        : [5,  16],
    KEY_J        : [5,  32], KEY_K        : [4,  32], KEY_L        : [4,  16],
    KEY_SEMICOLON: [3,  32], KEY_COLON    : [3,  16], KEY_RBRACKET : [2,   8],
    KEY_SHIFT    : [2,  32], KEY_Z_EN     : [8, 128], KEY_X        : [7, 128],
    KEY_C        : [7,  64], KEY_V        : [6, 128], KEY_B        : [6,  64],
    KEY_N        : [5,  64], KEY_M        : [4,  64], KEY_COMMA    : [4, 128],
    KEY_PERIOD   : [3, 128], KEY_SLASH    : [3,  64], KEY_DEL      : [2,  64],
    KEY_CTRL     : [2, 128], KEY_ALT      : [1,   2], KEY_SPACE    : [5, 128],
    KEY_COPY     : [0,  64], KEY_NUM7     : [1,  32], KEY_NUM8     : [1,  64],
    KEY_NUM9     : [0,  32], KEY_NUM4     : [2,  16], KEY_NUM5     : [1,  16],
    KEY_NUM6     : [0,  16], KEY_NUM1     : [1,   4], KEY_NUM2     : [1,   8],
    KEY_NUM3     : [0,   8], KEY_NUM0     : [1, 128], KEY_NUM_DOT  : [0, 128],
    KEY_UP       : [0,   1], KEY_DOWN     : [0,   4], KEY_LEFT     : [1,   1],
    KEY_RIGHT    : [0,   2],

    // ── Joystick 1 (row 9, emulated via the CPC port) ────────────────────────

    JOY_UP   : [9,  1], JOY_DOWN  : [9,  2], JOY_LEFT  : [9,  4],
    JOY_RIGHT: [9,  8], JOY_FIRE1 : [9, 16], JOY_FIRE2 : [9, 32],

    // ── Initialisation ───────────────────────────────────────────────────────

    /**
     * Resets the keyboard matrix (all keys released) and attaches DOM
     * keyboard event handlers for the lifetime of the emulation session.
     */
    init() {
        this.matrix.fill(255);
        document.onkeydown  = this.keydownEvent;
        document.onkeyup    = this.keyupEvent;
        document.onkeypress = this.keypressEvent;
    },

    // ── Layout ───────────────────────────────────────────────────────────────

    /**
     * Rebuilds keyCodeMap for the specified firmware locale.
     *
     * Layout differences:
     *   "english" — QWERTY: standard CPC key positions.
     *   "french"  — AZERTY: A↔Q, Z↔W, M on semicolon position,
     *               digits require SHIFT (unshifted row = accented characters).
     *   "spanish" — QWERTY Spanish: ':' and ';' swapped,
     *               Ñ (keyCode 192) maps to KEY_COLON.
     *
     * @param {"english"|"french"|"spanish"} lang - Firmware locale string.
     */
    setLayout(lang) {
        this.keyCodeMap.fill(null);

        const m = this.keyCodeMap;

        // Common to all layouts
        m[27] = this.KEY_ESC;       m[48] = this.KEY_0;        m[49] = this.KEY_1;
        m[50] = this.KEY_2;         m[51] = this.KEY_3;        m[52] = this.KEY_4;
        m[53] = this.KEY_5;         m[54] = this.KEY_6;        m[55] = this.KEY_7;
        m[56] = this.KEY_8;         m[57] = this.KEY_9;        m[ 8] = this.KEY_BACKSPACE;
        m[46] = this.KEY_CLR;       m[ 9] = this.KEY_TAB;      m[69] = this.KEY_E;
        m[82] = this.KEY_R;         m[84] = this.KEY_T;        m[89] = this.KEY_Y;
        m[85] = this.KEY_U;         m[73] = this.KEY_I;        m[79] = this.KEY_O;
        m[80] = this.KEY_P;         m[13] = this.KEY_ENTER;    m[20] = this.KEY_CAPS_LOCK;
        m[83] = this.KEY_S;         m[68] = this.KEY_D;        m[70] = this.KEY_F;
        m[71] = this.KEY_G;         m[72] = this.KEY_H;        m[74] = this.KEY_J;
        m[75] = this.KEY_K;         m[76] = this.KEY_L;        m[16] = this.KEY_SHIFT;
        m[88] = this.KEY_X;         m[67] = this.KEY_C;        m[86] = this.KEY_V;
        m[66] = this.KEY_B;         m[78] = this.KEY_N;        m[32] = this.KEY_SPACE;
        m[35] = this.KEY_COPY;      m[17] = this.KEY_CTRL;     m[18] = this.KEY_ALT;

        // Numpad (also mapped to F1–F10 for laptops without a numpad)
        m[96] = m[121] = this.KEY_NUM0; m[97] = m[112] = this.KEY_NUM7;
        m[98] = m[113] = this.KEY_NUM8; m[99] = m[114] = this.KEY_NUM9;
        m[100]= m[115] = this.KEY_NUM4; m[101]= m[116] = this.KEY_NUM5;
        m[102]= m[117] = this.KEY_NUM6; m[103]= m[118] = this.KEY_NUM1;
        m[104]= m[119] = this.KEY_NUM2; m[105]= m[120] = this.KEY_NUM3;
        m[110]= m[36]  = this.KEY_NUM_DOT;

        // Cursor keys
        m[37] = this.KEY_LEFT; m[38] = this.KEY_UP;
        m[39] = this.KEY_RIGHT; m[40] = this.KEY_DOWN;

        switch (lang) {
            case "english":
                m[81] = this.KEY_Q_EN;       m[87] = this.KEY_W_EN;
                m[65] = this.KEY_A_EN;       m[90] = this.KEY_Z_EN;
                m[77] = this.KEY_M;
                m[186] = this.KEY_SEMICOLON; m[187] = this.KEY_CARET;
                m[188] = this.KEY_COMMA;     m[189] = this.KEY_MINUS;
                m[190] = this.KEY_PERIOD;    m[191] = this.KEY_SLASH;
                m[192] = this.KEY_AT;        m[219] = this.KEY_LBRACKET;
                m[221] = this.KEY_RBRACKET;  m[222] = this.KEY_COLON;
                break;

            case "french":
                // AZERTY: A and Q are swapped, Z and W are swapped.
                m[65] = this.KEY_Q_EN;       m[81] = this.KEY_A_EN;
                m[90] = this.KEY_W_EN;       m[87] = this.KEY_Z_EN;
                m[77] = m[59] = [3, 32];    // M is at row 3, bit 32

                m[189] = [4, 128]; // ; .
                m[188] = [4,  64]; // , ?
                m[190] = [3, 128]; // : /
                m[187] = [3,  64]; // = +
                m[219] = [3,   2]; // ) [
                m[221] = [3,   4]; // ^
                m[186] = [2,   8]; // $ £
                m[220] = [2,   2]; // * <
                m[223] = [5,   1]; // !
                m[226] = [1,   2]; // < >
                break;

            case "spanish":
                // QWERTY Spanish: ':' and ';' positions swapped vs English.
                m[81] = this.KEY_Q_EN;       m[87] = this.KEY_W_EN;
                m[65] = this.KEY_A_EN;       m[90] = this.KEY_Z_EN;
                m[77] = this.KEY_M;

                m[187] = this.KEY_CARET;     m[188] = this.KEY_COMMA;
                m[189] = this.KEY_MINUS;     m[190] = this.KEY_PERIOD;
                m[191] = this.KEY_SLASH;     m[219] = this.KEY_LBRACKET;
                m[221] = this.KEY_RBRACKET;

                m[192] = this.KEY_COLON;     // PC Ñ key → CPC Ñ (COLON position)
                m[186] = this.KEY_SEMICOLON;
                break;

            default:
                console.error(`[Keyboard_Manager] Unknown layout: "${lang}"`);
        }
    },

    // ── Matrix read ──────────────────────────────────────────────────────────

    /**
     * Returns the 8-bit value for the PPI-selected matrix row.
     * Called by PSG_Sound_AY38910.readPort() when register R14 (Port A) is read.
     *
     * AutoType integration: when autoTypeKey is set, the key's bit is cleared
     * in the appropriate row to simulate a press. SHIFT (row 2, bit 32) and
     * CTRL (row 2, bit 128) modifier bits are also cleared when flagged.
     * autoTypeScanDone is raised the first time the key's row is scanned.
     *
     * @returns {number} 8-bit row value (bit=0 → pressed, bit=1 → released).
     */
    readMatrixRow() {
        const row = this._getSelectedRow();
        this.autoTypeScanCount++;

        if (this.autoTypeKey !== null) {
            const key = this.autoTypeKey;
            if (key.row === row) {
                let rowVal = this.matrix[row] & ~key.bit;
                if (key.shift && row === 2) rowVal &= ~32;
                if (key.ctrl  && row === 2) rowVal &= ~128;
                this.autoTypeScanDone = true;
                return rowVal;
            }
            // Maintain modifiers while the firmware scans other rows
            if (row === 2) {
                let modVal = this.matrix[row];
                if (key.shift) modVal &= ~32;
                if (key.ctrl)  modVal &= ~128;
                return modVal;
            }
        }

        return this.matrix[row];
    },

    // ── DOM event handlers ───────────────────────────────────────────────────

    /**
     * Handles keydown: clears the key's matrix bit (pressed state).
     * F11 (fullscreen) and F12 (DevTools) are passed through.
     * @param {KeyboardEvent} e
     */
    keydownEvent(e) {
        if (e.keyCode === 122 || e.keyCode === 123) return;
        e.stopPropagation();
        e.preventDefault();

        const keyPos = Keyboard_Manager.translateKeyCode(e.keyCode);
        if (keyPos !== null) {
            Keyboard_Manager.matrix[keyPos[0]] &= ~keyPos[1];
        }
    },

    /**
     * Handles keyup: sets the key's matrix bit (released state).
     * F11 and F12 are passed through.
     * @param {KeyboardEvent} e
     */
    keyupEvent(e) {
        if (e.keyCode === 122 || e.keyCode === 123) return;
        e.stopPropagation();
        e.preventDefault();

        const keyPos = Keyboard_Manager.translateKeyCode(e.keyCode);
        if (keyPos !== null) {
            Keyboard_Manager.matrix[keyPos[0]] |= keyPos[1];
        }
    },

    /**
     * Suppresses the browser's default keypress behaviour for all keys except
     * F11 and F12, preventing unwanted page scrolling or shortcuts.
     * @param {KeyboardEvent} e
     */
    keypressEvent(e) {
        if (e.keyCode !== 122 && e.keyCode !== 123) {
            e.stopPropagation();
            e.preventDefault();
        }
    },

    // ── Key translation ──────────────────────────────────────────────────────

    /**
     * Translates a DOM keyCode to CPC matrix coordinates [row, bitMask].
     *
     * When joystick emulation is active, arrow keys and Ctrl/Alt are redirected
     * to row 9 (joystick port) instead of their normal CPC matrix positions.
     *
     * @param  {number}     keyCode - DOM KeyboardEvent.keyCode value.
     * @returns {Array|null}         [row, bitMask] pair, or null if unmapped.
     */
    translateKeyCode(keyCode) {
        if (this._getJoystickEnabled()) {
            switch (keyCode) {
                case 37: return this.JOY_LEFT;
                case 38: return this.JOY_UP;
                case 39: return this.JOY_RIGHT;
                case 40: return this.JOY_DOWN;
                case 17: return this.JOY_FIRE1;
                case 18: return this.JOY_FIRE2;
            }
        }
        return (keyCode <= 255) ? this.keyCodeMap[keyCode] : null;
    }
};


// =============================================================================
// InputExpansion — Extended joystick port (DB9 connector)
// =============================================================================

/**
 * @namespace InputExpansion
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
const InputExpansion = {

    /** @type {number|null} Secondary button state: 0=pressed, 1=released. */
    buttonState: null,

    /** @type {number|null} Output data byte (bits 6:0). */
    data       : null,

    /**
     * Resets the expansion port to its default state (button released, data = 0).
     */
    reset() {
        this.buttonState = 1;
        this.data        = 0;
    },

    /**
     * Processes an I/O write to the expansion port address range.
     * Only responds when address bit 12 (A12) is 0.
     * @param {number} addr - 16-bit I/O address.
     * @param {number} data - 8-bit value; bits 6:0 = output data, bit 7 = button (inverted).
     */
    writePort(addr, data) {
        if (((addr >>> 8) & 0x10) === 0) {
            this.data        = data & 0x7F;
            this.buttonState = (data >>> 7) === 1 ? 0 : 1;
        }
    },

    /**
     * Returns the secondary button state. Always returns 1 (released) because
     * no secondary button is connected in this implementation.
     * @returns {number} 1
     */
    readButton() { return 1; }
};


// =============================================================================
// AutoType — ROM-synchronised keystroke injection
// =============================================================================

/**
 * @namespace AutoType
 * @description Injects a string of characters into the CPC by simulating
 * keystrokes synchronised with the firmware's keyboard scan loop.
 *
 * Injection mechanism:
 *   1. inject(text) builds a queue of {row, bit, shift, ctrl} key descriptors
 *      from the locale-specific CHAR_MAP.
 *   2. The current key descriptor is written to Keyboard_Manager.autoTypeKey.
 *   3. readMatrixRow() (called by the Z80 ROM scan) detects the key on the
 *      correct row and sets autoTypeScanDone = true.
 *   4. A 5 ms polling interval detects autoTypeScanDone, releases the key,
 *      waits a gap measured in scan-cycle units, then advances to the next key.
 *
 * Gap logic (prevents the ROM from merging consecutive identical keys):
 *   - Different consecutive keys  : GAP_NORMAL (20 scan cycles ≈ 20 ms).
 *   - Same key repeated           : GAP_DOUBLE (40 scan cycles).
 *
 * Supported locales (selected from Config_Manager.language at injection time):
 *   'english' — QWERTY standard CPC
 *   'french'  — AZERTY CPC (A↔Q, Z↔W; digits require SHIFT)
 *   'spanish' — QWERTY Spanish (':' and ';' swapped; Ñ/ñ available)
 */
window.AutoType = (function () {

    var _bus = null;

    // ── CHAR_MAP ENGLISH — QWERTY standard CPC ────────────────────────────────

    var _MAP_ENGLISH = {
        '0':{row:4,bit:1},   '1':{row:8,bit:1},   '2':{row:8,bit:2},
        '3':{row:7,bit:2},   '4':{row:7,bit:1},   '5':{row:6,bit:2},
        '6':{row:6,bit:1},   '7':{row:5,bit:2},   '8':{row:5,bit:1},
        '9':{row:4,bit:2},
        'A':{row:8,bit:32},  'B':{row:6,bit:64},  'C':{row:7,bit:64},
        'D':{row:7,bit:32},  'E':{row:7,bit:4},   'F':{row:6,bit:32},
        'G':{row:6,bit:16},  'H':{row:5,bit:16},  'I':{row:4,bit:8},
        'J':{row:5,bit:32},  'K':{row:4,bit:32},  'L':{row:4,bit:16},
        'M':{row:4,bit:64},  'N':{row:5,bit:64},  'O':{row:4,bit:4},
        'P':{row:3,bit:8},   'Q':{row:8,bit:8},   'R':{row:6,bit:4},
        'S':{row:7,bit:16},  'T':{row:6,bit:8},   'U':{row:5,bit:4},
        'V':{row:6,bit:128}, 'W':{row:7,bit:8},   'X':{row:7,bit:128},
        'Y':{row:5,bit:8},   'Z':{row:8,bit:128},
        ' ':{row:5,bit:128}, '\r':{row:2,bit:4},  '\n':{row:2,bit:4},
        ':':{row:3,bit:16},  ';':{row:3,bit:32},
        '.':{row:3,bit:128}, ',':{row:4,bit:128}, '-':{row:3,bit:2},
        '@':{row:3,bit:4},   '[':{row:2,bit:2},   ']':{row:2,bit:8},
        '/':{row:3,bit:64},  '^':{row:3,bit:1},
        '!':{row:8,bit:1,  shift:true}, '"':{row:8,bit:2,  shift:true},
        '#':{row:7,bit:2,  shift:true}, '$':{row:7,bit:1,  shift:true},
        '%':{row:6,bit:2,  shift:true}, '&':{row:6,bit:1,  shift:true},
        "'":{row:5,bit:2,  shift:true}, '(':{row:5,bit:1,  shift:true},
        ')':{row:4,bit:2,  shift:true}, '=':{row:3,bit:2,  shift:true},
        '+':{row:3,bit:32, shift:true}, '*':{row:3,bit:16, shift:true},
        '<':{row:4,bit:128,shift:true}, '>':{row:3,bit:128,shift:true},
        '?':{row:3,bit:64, shift:true}, '_':{row:4,bit:1,  shift:true},
        '|':{row:3,bit:4,  shift:true},
        '{':{row:2,bit:2,  shift:true}, '}':{row:2,bit:8,  shift:true}
    };

    // ── CHAR_MAP FRENCH — AZERTY CPC 6128 ────────────────────────────────────

    var _MAP_FRENCH = {
        'a':{row:8,bit:8},   'b':{row:6,bit:64},  'c':{row:7,bit:64}, 'd':{row:7,bit:32},
        'e':{row:7,bit:4},   'f':{row:6,bit:32},  'g':{row:6,bit:16}, 'h':{row:5,bit:16},
        'i':{row:4,bit:8},   'j':{row:5,bit:32},  'k':{row:4,bit:32}, 'l':{row:4,bit:16},
        'm':{row:3,bit:32},  'n':{row:5,bit:64},  'o':{row:4,bit:4},  'p':{row:3,bit:8},
        'q':{row:8,bit:32},  'r':{row:6,bit:4},   's':{row:7,bit:16}, 't':{row:6,bit:8},
        'u':{row:5,bit:4},   'v':{row:6,bit:128}, 'w':{row:8,bit:128},'x':{row:7,bit:128},
        'y':{row:5,bit:8},   'z':{row:7,bit:8},
        'A':{row:8,bit:8,  shift:true}, 'B':{row:6,bit:64, shift:true}, 'C':{row:7,bit:64, shift:true},
        'D':{row:7,bit:32, shift:true}, 'E':{row:7,bit:4,  shift:true}, 'F':{row:6,bit:32, shift:true},
        'G':{row:6,bit:16, shift:true}, 'H':{row:5,bit:16, shift:true}, 'I':{row:4,bit:8,  shift:true},
        'J':{row:5,bit:32, shift:true}, 'K':{row:4,bit:32, shift:true}, 'L':{row:4,bit:16, shift:true},
        'M':{row:3,bit:32, shift:true}, 'N':{row:5,bit:64, shift:true}, 'O':{row:4,bit:4,  shift:true},
        'P':{row:3,bit:8,  shift:true}, 'Q':{row:8,bit:32, shift:true}, 'R':{row:6,bit:4,  shift:true},
        'S':{row:7,bit:16, shift:true}, 'T':{row:6,bit:8,  shift:true}, 'U':{row:5,bit:4,  shift:true},
        'V':{row:6,bit:128,shift:true}, 'W':{row:8,bit:128,shift:true}, 'X':{row:7,bit:128,shift:true},
        'Y':{row:5,bit:8,  shift:true}, 'Z':{row:7,bit:8,  shift:true},
        '1':{row:8,bit:1,  shift:true}, '2':{row:8,bit:2,  shift:true}, '3':{row:7,bit:2,  shift:true},
        '4':{row:7,bit:1,  shift:true}, '5':{row:6,bit:2,  shift:true}, '6':{row:6,bit:1,  shift:true},
        '7':{row:5,bit:2,  shift:true}, '8':{row:5,bit:1,  shift:true}, '9':{row:4,bit:2,  shift:true},
        '0':{row:4,bit:1,  shift:true},
        '&':{row:8,bit:1},   'é':{row:8,bit:2},   '"':{row:7,bit:2},  "'":{row:7,bit:1},
        '(':{row:6,bit:2},   '-':{row:3,bit:1},   'è':{row:5,bit:2},  '_':{row:3,bit:1,  shift:true},
        'ç':{row:4,bit:2},   'à':{row:4,bit:1},   ')':{row:3,bit:2},  '=':{row:3,bit:64},
        '+':{row:3,bit:64,  shift:true},           '#':{row:2,bit:8},
        '^':{row:3,bit:4},   '$':{row:2,bit:64},   '*':{row:2,bit:2},  'ù':{row:3,bit:16},
        '%':{row:3,bit:16, shift:true},
        ',':{row:4,bit:64},  '.':{row:4,bit:128, shift:true},
        ':':{row:3,bit:128}, ';':{row:4,bit:128},
        '!':{row:5,bit:1},   '/':{row:3,bit:128, shift:true},
        '?':{row:4,bit:64,  shift:true},
        '<':{row:2,bit:2,   shift:true}, '>':{row:2,bit:8,   shift:true},
        '[':{row:3,bit:2,   shift:true}, ']':{row:6,bit:1},
        '|':{row:3,bit:4,   ctrl:true},  '\\':{row:2,bit:64, shift:true},
        ' ':{row:5,bit:128}, '\r':{row:2,bit:4}, '\n':{row:2,bit:4}
    };

    // ── CHAR_MAP SPANISH — QWERTY Spanish CPC ────────────────────────────────

    var _MAP_SPANISH = {
        '0':{row:4,bit:1},   '1':{row:8,bit:1},   '2':{row:8,bit:2},
        '3':{row:7,bit:2},   '4':{row:7,bit:1},   '5':{row:6,bit:2},
        '6':{row:6,bit:1},   '7':{row:5,bit:2},   '8':{row:5,bit:1},
        '9':{row:4,bit:2},
        'A':{row:8,bit:32},  'B':{row:6,bit:64},  'C':{row:7,bit:64},
        'D':{row:7,bit:32},  'E':{row:7,bit:4},   'F':{row:6,bit:32},
        'G':{row:6,bit:16},  'H':{row:5,bit:16},  'I':{row:4,bit:8},
        'J':{row:5,bit:32},  'K':{row:4,bit:32},  'L':{row:4,bit:16},
        'M':{row:4,bit:64},  'N':{row:5,bit:64},  'O':{row:4,bit:4},
        'P':{row:3,bit:8},   'Q':{row:8,bit:8},   'R':{row:6,bit:4},
        'S':{row:7,bit:16},  'T':{row:6,bit:8},   'U':{row:5,bit:4},
        'V':{row:6,bit:128}, 'W':{row:7,bit:8},   'X':{row:7,bit:128},
        'Y':{row:5,bit:8},   'Z':{row:8,bit:128},
        'Ñ':{row:3,bit:16},  'ñ':{row:3,bit:16},
        ' ':{row:5,bit:128}, '\r':{row:2,bit:4},  '\n':{row:2,bit:4},
        ':':{row:3,bit:32},  ';':{row:3,bit:16},
        '.':{row:3,bit:128}, ',':{row:4,bit:128}, '-':{row:3,bit:2},
        '@':{row:3,bit:4},   '[':{row:2,bit:2},   ']':{row:2,bit:8},
        '/':{row:3,bit:64},  '^':{row:3,bit:1},
        '!':{row:8,bit:1,  shift:true}, '"':{row:8,bit:2,  shift:true},
        '#':{row:7,bit:2,  shift:true}, '$':{row:7,bit:1,  shift:true},
        '%':{row:6,bit:2,  shift:true}, '&':{row:6,bit:1,  shift:true},
        "'":{row:5,bit:2,  shift:true}, '(':{row:5,bit:1,  shift:true},
        ')':{row:4,bit:2,  shift:true}, '=':{row:3,bit:2,  shift:true},
        '+':{row:3,bit:16, shift:true}, '*':{row:3,bit:32, shift:true},
        '<':{row:4,bit:128,shift:true}, '>':{row:3,bit:128,shift:true},
        '?':{row:3,bit:64, shift:true}, '_':{row:4,bit:1,  shift:true},
        '|':{row:3,bit:4,  shift:true},
        '{':{row:2,bit:2,  shift:true}, '}':{row:2,bit:8,  shift:true}
    };

    /**
     * Returns the CHAR_MAP for the active firmware locale.
     * Falls back to English if the bus language is unset.
     * @returns {Object} Character-to-matrix-coordinate map.
     */
    function _buildCharMap() {
        var lang = (_bus && _bus.language) ? _bus.language : 'english';
        switch (lang) {
            case 'french':  return _MAP_FRENCH;
            case 'spanish': return _MAP_SPANISH;
            default:        return _MAP_ENGLISH;
        }
    }

    var CHAR_MAP   = {};
    var _queue     = [];
    var _phase     = 0;
    var _timerId   = null;
    var _prevKey   = null;
    var _gapTarget = 0;

    /** Scan cycles to wait between two different consecutive keys. */
    var GAP_NORMAL = 20;
    /** Scan cycles to wait between two identical consecutive keys. */
    var GAP_DOUBLE = 40;

    function _clearKey() {
        Keyboard_Manager.autoTypeKey      = null;
        Keyboard_Manager.autoTypeScanDone = false;
    }

    function _isSameKey(a, b) {
        return a && b && a.row === b.row && a.bit === b.bit;
    }

    /**
     * Polling function called every 5 ms by setInterval.
     * Phase 1 (press): waits for autoTypeScanDone, then releases the key.
     * Phase 2 (gap):   waits for autoTypeScanCount to reach gapTarget.
     */
    function _poll() {
        if (_phase === 0) return;

        if (_phase === 1) {
            if (Keyboard_Manager.autoTypeScanDone) {
                Keyboard_Manager.autoTypeScanDone = false;
                _clearKey();
                var nextKey = (_queue.length > 0) ? _queue[0] : null;
                var gap = _isSameKey(_prevKey, nextKey) ? GAP_DOUBLE : GAP_NORMAL;
                _gapTarget = Keyboard_Manager.autoTypeScanCount + gap;
                _phase = 2;
            }
        } else if (_phase === 2) {
            if (Keyboard_Manager.autoTypeScanCount >= _gapTarget) {
                _phase = 0;
                _nextChar();
            }
        }
    }

    /**
     * Dequeues the next character and sets it as the active AutoType key.
     * Stops the polling timer when the queue is empty.
     */
    function _nextChar() {
        if (_queue.length === 0) {
            _clearKey();
            _prevKey = null;
            if (_timerId) { clearInterval(_timerId); _timerId = null; }
            $('#status').text('Running');
            return;
        }
        var key = _queue.shift();
        _prevKey = key;
        Keyboard_Manager.autoTypeKey      = key;
        Keyboard_Manager.autoTypeScanDone = false;
        _phase = 1;
    }

    return {

        /**
         * Injects the bus dependency (called by CPC_Bus.js after linking all modules).
         * The bus must expose a `language` string matching the active firmware locale.
         */
        set bus(b) { _bus = b; },

        /**
         * Diagnostic tool: injects a BASIC program that scans and prints the raw
         * matrix state for every row and bit combination.
         * Used for keyboard layout debugging when adding a new firmware locale.
         */
        debugScan: function () {
            this.cancel();
            _queue = [];
            let lineNum = 100;
            const bits = [1, 2, 4, 8, 16, 32, 64, 128];

            const azertyMap = {
                '0':{row:4,bit:1, shift:true}, '1':{row:8,bit:1, shift:true}, '2':{row:8,bit:2, shift:true},
                '3':{row:7,bit:2, shift:true}, '4':{row:7,bit:1, shift:true}, '5':{row:6,bit:2, shift:true},
                '6':{row:6,bit:1, shift:true}, '7':{row:5,bit:2, shift:true}, '8':{row:5,bit:1, shift:true},
                '9':{row:4,bit:2, shift:true}, ' ':{row:5,bit:128}, '\r':{row:2,bit:4},
                'R':{row:6,bit:4}, 'E':{row:7,bit:4}, 'M':{row:3,bit:32}, 'O':{row:4,bit:4},
                'F':{row:6,bit:32}, 'N':{row:5,bit:64}, 'W':{row:8,bit:128}, 'S':{row:7,bit:16},
                'H':{row:5,bit:16}, 'I':{row:4,bit:8}, 'T':{row:6,bit:8}, 'A':{row:8,bit:8}
            };

            const addText = (text) => {
                for (let c of text.toUpperCase()) {
                    let k = azertyMap[c];
                    if (k) _queue.push({ ...k });
                }
            };

            for (let s = 0; s <= 1; s++) {
                for (let r = 0; r <= 8; r++) {
                    addText(lineNum.toString() + " REM ");
                    addText(s === 0 ? "OFF" : "ON ");
                    addText(" R" + r + " ");

                    for (let b of bits) {
                        addText("B" + b + ":");
                        _queue.push({ row: r, bit: b, shift: (s === 1) });
                        addText(" ");
                    }

                    addText("\r");
                    lineNum += 10;
                }
            }

            console.log("Starting AZERTY scan...");
            _nextChar();
            _timerId = setInterval(_poll, 5);
        },

        /**
         * Injects a string of text into the CPC keyboard matrix.
         *
         * The CHAR_MAP is selected at call time from the active firmware locale,
         * so the same call works correctly after a language change.
         * Line endings (\r\n and \n) are normalised to \r (CPC Enter = 13).
         * If a character has no exact match its uppercase equivalent is tried.
         *
         * @param {string} text - Text to inject (BASIC commands, keypresses, etc.).
         */
        inject: function (text) {
            CHAR_MAP = _buildCharMap();
            this.cancel();
            text = text.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
            _queue = [];
            for (var i = 0; i < text.length; i++) {
                var ch = text[i];
                var k = CHAR_MAP[ch] || CHAR_MAP[ch.toUpperCase()];
                if (k) _queue.push(k);
            }
            if (_queue.length === 0) return;
            $('#status').text('Auto-Typing...');
            _nextChar();
            _timerId = setInterval(_poll, 5);
        },

        /**
         * Cancels any in-progress injection and clears the key queue.
         */
        cancel: function () {
            if (_timerId) { clearInterval(_timerId); _timerId = null; }
            _queue  = [];
            _phase  = 0;
            _clearKey();
            $('#status').text('Running');
        }
    };

})();


// =============================================================================
// DOM bindings
// =============================================================================

$(document).ready(function () {
    UI_Manager.bindKeyboard();
});
