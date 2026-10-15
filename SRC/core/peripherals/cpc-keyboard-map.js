"use strict";

/**
 * @file cpc-keyboard-map.js
 * @module CPC_KEY_MAP_DATA
 *
 * Physical keyboard → CPC matrix table, keyed by `KeyboardEvent.code`.
 *
 * Format: each entry maps a `KeyboardEvent.code` to a CPC matrix position
 * `{ line: 0..9, bit: 0..7 }`. `bit` is the bit index inside the row, not its
 * mask (`1 << bit`). Positions come from the Amstrad CPC 464/664/6128
 * technical manual.
 *
 * Layouts: the CPC keyboard is AZERTY, so its Q position holds the key marked
 * "A" on a QWERTY keyboard, and vice versa — one dictionary per firmware.
 *
 *   US — reference QWERTY (English firmware)
 *   FR — French AZERTY (French firmware)
 *   ES — Spanish QWERTY (Spanish firmware, Ñ on Backquote)
 *
 * `CPC_KEY_COMMON` holds the keys whose position is identical in the three
 * layouts; each layout only declares its differences. Right-hand modifiers
 * (`ShiftRight`, `ControlRight`, `AltRight`) are added at the end of the file
 * for every layout.
 *
 * To add a key: use its `KeyboardEvent.code` as key and its CPC position
 * `{ line, bit }` as value. Add it to `CPC_KEY_COMMON` only when its position
 * is identical in every layout.
 */

// ---------------------------------------------------------------------------
// Keys common to the three layouts (69)
// ---------------------------------------------------------------------------

const CPC_KEY_MAP_DATA = (() => {
const CPC_KEY_COMMON = {

    // Row 0 — keypad 3/6/9 and arrows
    "ArrowUp":       { line: 0, bit: 0 },
    "ArrowRight":    { line: 0, bit: 1 },
    "ArrowDown":     { line: 0, bit: 2 },
    "F9":            { line: 0, bit: 3 },   // F1-F10 = keys 7-0, for keyboards without a keypad
    "Numpad9":       { line: 0, bit: 3 },
    "F6":            { line: 0, bit: 4 },
    "Numpad6":       { line: 0, bit: 4 },
    "Numpad3":       { line: 0, bit: 5 },
    "F3":            { line: 0, bit: 5 },
    "Insert":        { line: 0, bit: 6 },   // CPC COPY key
    "NumpadDecimal": { line: 0, bit: 7 },
    "Home":          { line: 0, bit: 7 },   // same position as the keypad

    // Row 1 — keypad 7/8/5/1/2/0
    "ArrowLeft":     { line: 1, bit: 0 },
    "AltLeft":       { line: 1, bit: 1 },   // CPC CAPS key
    "F7":            { line: 1, bit: 2 },
    "Numpad7":       { line: 1, bit: 2 },
    "F8":            { line: 1, bit: 3 },
    "Numpad8":       { line: 1, bit: 3 },
    "F5":            { line: 1, bit: 4 },
    "Numpad5":       { line: 1, bit: 4 },
    "F1":            { line: 1, bit: 5 },
    "Numpad1":       { line: 1, bit: 5 },
    "F2":            { line: 1, bit: 6 },
    "Numpad2":       { line: 1, bit: 6 },
    "F10":           { line: 1, bit: 7 },
    "Numpad0":       { line: 1, bit: 7 },

    // Row 2 — RETURN, CLR, modifiers, keypad 4.
    // `BracketLeft` and `BracketRight` are not common: their position differs in
    // AZERTY, where [ and ] are not where QWERTY puts them.
    "Delete":        { line: 2, bit: 0 },   // CPC CLR/HOME key
    "Enter":         { line: 2, bit: 2 },
    "Numpad4":       { line: 2, bit: 4 },
    "F4":            { line: 2, bit: 4 },
    "ShiftLeft":     { line: 2, bit: 5 },
    "ControlLeft":   { line: 2, bit: 7 },

    // Rows 3 to 9
    "KeyP":          { line: 3, bit: 3 },
    "Period":        { line: 3, bit: 7 },
    "Digit0":        { line: 4, bit: 0 },
    "Digit9":        { line: 4, bit: 1 },
    "KeyO":          { line: 4, bit: 2 },
    "KeyI":          { line: 4, bit: 3 },
    "KeyL":          { line: 4, bit: 4 },
    "KeyK":          { line: 4, bit: 5 },
    "Digit8":        { line: 5, bit: 0 },
    "Digit7":        { line: 5, bit: 1 },
    "KeyU":          { line: 5, bit: 2 },
    "KeyY":          { line: 5, bit: 3 },
    "KeyH":          { line: 5, bit: 4 },
    "KeyJ":          { line: 5, bit: 5 },
    "KeyN":          { line: 5, bit: 6 },
    "Space":         { line: 5, bit: 7 },
    "Digit6":        { line: 6, bit: 0 },
    "Digit5":        { line: 6, bit: 1 },
    "KeyR":          { line: 6, bit: 2 },
    "KeyT":          { line: 6, bit: 3 },
    "KeyG":          { line: 6, bit: 4 },
    "KeyF":          { line: 6, bit: 5 },
    "KeyB":          { line: 6, bit: 6 },
    "KeyV":          { line: 6, bit: 7 },
    "Digit4":        { line: 7, bit: 0 },
    "Digit3":        { line: 7, bit: 1 },
    "KeyE":          { line: 7, bit: 2 },
    "KeyS":          { line: 7, bit: 4 },
    "KeyD":          { line: 7, bit: 5 },
    "KeyC":          { line: 7, bit: 6 },
    "KeyX":          { line: 7, bit: 7 },
    "Digit1":        { line: 8, bit: 0 },
    "Digit2":        { line: 8, bit: 1 },
    "Escape":        { line: 8, bit: 2 },
    "Tab":           { line: 8, bit: 4 },
    "CapsLock":      { line: 8, bit: 6 },
    "Backspace":     { line: 9, bit: 7 },
};

/**
 * `KeyboardEvent.code` → position `{ line, bit }` table, per firmware layout.
 * @type {Object.<"US"|"FR"|"ES", Object.<string, {line:number, bit:number}>>}
 */
const CPC_KEYBOARD_MAPS = {

    // Reference QWERTY (English firmware)
    US: Object.assign({}, CPC_KEY_COMMON, {
        "KeyQ":         { line: 8, bit: 3 },
        "KeyA":         { line: 8, bit: 5 },
        "KeyZ":         { line: 8, bit: 7 },
        "KeyW":         { line: 7, bit: 3 },
        "KeyM":         { line: 4, bit: 6 },
        "Equal":        { line: 3, bit: 0 },
        "Minus":        { line: 3, bit: 1 },
        "Backquote":    { line: 3, bit: 2 },
        "Quote":        { line: 3, bit: 4 },
        "Semicolon":    { line: 3, bit: 5 },
        "Slash":        { line: 3, bit: 6 },
        "Comma":        { line: 4, bit: 7 },
        "BracketLeft":  { line: 2, bit: 1 },
        "BracketRight": { line: 2, bit: 3 },
        // `\` sits at 2:6 in QWERTY against 2:1 in AZERTY, so it is not part of
        // the common set.
        "Backslash":    { line: 2, bit: 6 },
    }),

    // French AZERTY (French firmware).
    //
    // On a French AZERTY host, `event.code` names the QWERTY position:
    //   key marked "A" (QWERTY Q) → event.code "KeyQ"
    //   key marked "Z" (QWERTY W) → event.code "KeyW"
    //   key marked "Q" (QWERTY A) → event.code "KeyA"
    //   key marked "W" (QWERTY Z) → event.code "KeyZ"
    //
    // Each value is the CPC position that produces the expected character with
    // the French firmware (8:3 → 'q'/'Q', 8:5 → 'a'/'A', 7:3 → 'z'/'Z',
    // 8:7 → 'w'/'W').
    FR: Object.assign({}, CPC_KEY_COMMON, {
        "KeyQ":         { line: 8, bit: 3 },   // key "A" → 'a'
        "KeyA":         { line: 8, bit: 5 },   // key "Q" → 'q'
        "KeyZ":         { line: 8, bit: 7 },   // key "W" → 'w'
        "KeyW":         { line: 7, bit: 3 },   // key "Z" → 'z'
        "KeyM":         { line: 3, bit: 5 },
        // Special characters: `event.code` is the physical US position, the CPC
        // position is where the French ROM draws that character.
        "Backquote":    { line: 3, bit: 2 },   // ² key: no CPC character, carried over from the original table
        "Quote":        { line: 3, bit: 4 },   // |/< key → '|'
        "Equal":        { line: 3, bit: 0 },   // = key → '-'
        "Slash":        { line: 3, bit: 6 },   // ?/> key → '='
        "Semicolon":    { line: 3, bit: 6 },   // ; key → '=' (same position as Slash on FR AZERTY)
        "Minus":        { line: 3, bit: 1 },   // - key → ')'
        "Comma":        { line: 4, bit: 7 },   // , key → ';'
        "Backslash":    { line: 2, bit: 6 },   // * key → '$'
        // `^` is a dead key: `event.key` is "Dead", never "^", so positional
        // translation is the only path. The French firmware draws '^' at 3:2.
        "BracketLeft":  { line: 3, bit: 2 },   // ^/¨ key → '^'
        "BracketRight": { line: 2, bit: 3 },   // ] key → '#'
        // Positional fallback for `translateCode()`. Real strokes are caught
        // earlier by `Keyboard#_isAltGrKey()` (AltGraph / AltRight).
        "AltRight":     { line: 5, bit: 0 },
    }),

    // Spanish QWERTY (Spanish firmware): as English, but ':' and ';' are
    // swapped and 'Ñ' sits on the US Backquote key.
    ES: Object.assign({}, CPC_KEY_COMMON, {
        "KeyQ":         { line: 8, bit: 3 },
        "KeyA":         { line: 8, bit: 5 },
        "KeyZ":         { line: 8, bit: 7 },
        "KeyW":         { line: 7, bit: 3 },
        "KeyM":         { line: 4, bit: 6 },
        "Equal":        { line: 3, bit: 0 },
        "Minus":        { line: 3, bit: 1 },
        "Backquote":    { line: 3, bit: 4 },   // Ñ
        "Semicolon":    { line: 3, bit: 5 },
        "Slash":        { line: 3, bit: 6 },
        "Comma":        { line: 4, bit: 7 },
        "BracketLeft":  { line: 2, bit: 1 },
        "BracketRight": { line: 2, bit: 3 },
        "Backslash":    { line: 2, bit: 6 },
    }),
};

/**
 * Modifier keys, kept apart from the ordinary key dictionary: their state has to
 * be known even when no key carries them in the matrix. The right-hand variants
 * (`ShiftRight`, `ControlRight`) share the CPC position of their left-hand
 * counterpart — the CPC has a single SHIFT and a single CTRL key.
 *
 * @type {Object.<string, {line:number, bit:number}>}
 */
const CPC_MODIFIER_KEYS = {
    "ShiftLeft":     { line: 2, bit: 5 },
    "ShiftRight":    { line: 2, bit: 5 },
    "ControlLeft":   { line: 2, bit: 7 },
    "ControlRight":  { line: 2, bit: 7 },
    "AltLeft":       { line: 1, bit: 1 },
    "CapsLock":      { line: 8, bit: 6 },
};

/**
 * Logical modifier name for each `code` of `CPC_MODIFIER_KEYS`.
 * @type {Object.<string, string>}
 */
const CPC_MODIFIER_NAMES = {
    "ShiftLeft": "shift",     "ShiftRight": "shift",
    "ControlLeft": "ctrl",    "ControlRight": "ctrl",
    "AltLeft": "alt",
    "CapsLock": "capsLock",
};

/** Handled firmware layouts, in report order. */
const CPC_LAYOUTS = ["US", "FR", "ES"];

/**
 * Picks one of the available layouts from a BCP 47 language tag. Only US/FR/ES
 * ROMs are shipped, so any other language falls back to the reference US
 * layout. `language` is injectable for tests.
 * @param {string} [language] Defaults to `navigator.language`.
 * @returns {"US"|"FR"|"ES"}
 */
function detectLayoutFromNavigatorLanguage(language =
    (typeof navigator !== "undefined" ? navigator.language : "")) {
    const tag = String(language || "").toLowerCase();
    if (/^fr(?:-|$)/.test(tag)) return "FR";
    if (/^es(?:-|$)/.test(tag)) return "ES";
    return "US";
}

/**
 * Adds the right-hand modifier keys to every layout. Both physical variants
 * share one CPC position, so concurrent presses combine as on real hardware.
 * `AltRight` is intentionally left out: `Keyboard` handles it as a composition
 * modifier before any translation (see `Keyboard#_isAltGrKey()`).
 */
for (const _layout of CPC_LAYOUTS) {
    for (const [code, pos] of Object.entries(CPC_MODIFIER_KEYS)) {
        if (CPC_KEYBOARD_MAPS[_layout][code] === undefined) {
            CPC_KEYBOARD_MAPS[_layout][code] = { line: pos.line, bit: pos.bit };
        }
    }
}

return Object.freeze({
    CPC_KEY_COMMON,
    CPC_KEYBOARD_MAPS,
    CPC_MODIFIER_KEYS,
    CPC_MODIFIER_NAMES,
    CPC_LAYOUTS,
    detectLayoutFromNavigatorLanguage,
});
})();
