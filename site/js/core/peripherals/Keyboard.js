"use strict";

/**
 * @module CPC_INPUT
 * @description Amstrad CPC keyboard matrix emulation, input expansion and AutoType.
 * The script publishes only its `CPC_INPUT` namespace binding; it does not add
 * properties to `window`.
 *
 * Hardware model:
 *   The CPC keyboard is a 10-row × 8-bit matrix.
 *   - A bit value of 0 means the key is pressed (inverted logic).
 *   - The row to read is selected by bits 3:0 of PPI Port C.
 *   - The matrix is read via PSG register R14 (Port A input).
 *
 * Module structure:
 * `CPC_INPUT` owns private class definitions and singleton instances; external
 * scripts access them through that single lexical namespace.
 */

const CPC_INPUT = (() => {
    const {
        CPC_KEYBOARD_MAPS,
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
            this.modifiers = { shift: false, ctrl: false, alt: false, capsLock: false };
            this._pressedPositions = new Map();
            this._autoType = null;
            this._onFrame = () => this._autoType?.onFrame();
            this._boundKeyDown = (event) => this.keydownEvent(event);
            this._boundKeyUp = (event) => this.keyupEvent(event);
            this._boundBlur = () => this.releaseAll();
            this._listenersAttached = false;
        }

        link(bus) {
            if (bus.getSelectedRow) this._getSelectedRow = bus.getSelectedRow;
            if (bus.getJoystickEnabled) this._getJoystickEnabled = bus.getJoystickEnabled;
        }

        /**
         * Active ou désactive directement un point de la matrice (mode brut).
         *
         * C'est le seul point d'écriture de la matrice : frappes physiques,
         * AutoType et joystick passent tous par ici, donc l'état lu par le
         * firmware ne peut pas diverger selon l'origine de la pression.
         *
         * @param {number}  line      Ligne 0-9 de la matrice.
         * @param {number}  bit       Bit 0-7 dans la ligne.
         * @param {boolean} isPressed `true` enfonce (le bit passe à 0).
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
         * Relâche toute touche enfoncée et rend la matrice à l'état de repos,
         * SANS toucher à la file d'injection.
         *
         * C'est ce que fait le `blur` de la fenêtre. Perdre le focus signifie
         * qu'aucun `keyup` ne viendra pour les touches encore enfoncées — il
         * faut donc les relâcher — mais le texte en attente d'injection, lui,
         * n'a rien à voir avec le focus : l'annuler faisait perdre la frappe en
         * cours dès que l'utilisateur allait lire un message dans une autre
         * fenêtre. Le caractère en cours est remis en tête de file pour être
         * retapé plutôt que perdu.
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
         * Met une chaîne dans la file d'attente FIFO.
         * @param {string} text Texte à taper, par exemple `RUN"DISC\n`.
         * @returns {void}
         */
        typeString(text) { this._autoType?.typeString(text); }

        /** Une image d'émulation : fait avancer l'injection. */
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

        /** Appelée par la boucle d'émulation une fois par image. */
        onFrame() { this._onFrame(); }

        init() {
            this.reset();
            if (this._listenersAttached) return;
            document.addEventListener('keydown', this._boundKeyDown);
            document.addEventListener('keyup', this._boundKeyUp);
            window.addEventListener('blur', this._boundBlur);
            this._listenersAttached = true;
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
         * Lecture hardware : l'état d'une ligne de la matrice, telle que le
         * AY-3-8912 la restitue au CPU via son registre 14 (Port A).
         *
         * La logique est active-low — un bit à 0 signifie « enfoncé » — et le
         * circuit AND cette lecture avec l'état des lignes désélectionnées par
         * le PPI. Comme seule la ligne sélectionnée doit être lue ici, les
         * positions hors de la ligne demandée restent à 1.
         *
         * @param {number} line Ligne 0-9 demandée.
         * @returns {number} Octet de la ligne, en logique active-low.
         */
        readAYPort(line) {
            if (!Number.isInteger(line) || line < 0 || line > 9) return 0xFF;
            // Chaque lecture est une interrogation du firmware : elle ouvre la
            // porte qui autorise l'injection du prochain caractère.
            this._autoType?.noteFirmwareRead();
            return this.matrix[line];
        }

        /** PPI row read path; physical and AutoType keys share the matrix. */
        readMatrixRow() {
            const row = this._getSelectedRow();
            if (!Number.isInteger(row) || row < 0 || row > 9) return 0xFF;
            return this.matrix[row];
        }

        keydownEvent(event) {
            if (Keyboard.CRITICAL_CODES.has(event.code)) event.preventDefault();
            if (this._pressedPositions.has(event.code)) return;
            const pos = this.translateCode(event.code);
            if (!pos) return;
            this._pressedPositions.set(event.code, pos);
            this.pressKey(pos.line, pos.bit);
            this._updateModifiers();
        }

        keyupEvent(event) {
            if (Keyboard.CRITICAL_CODES.has(event.code)) event.preventDefault();
            const pos = this._pressedPositions.get(event.code);
            if (!pos) return;
            this._pressedPositions.delete(event.code);
            const stillHeld = [...this._pressedPositions.values()].some(
                (held) => held.line === pos.line && held.bit === pos.bit,
            );
            if (!stillHeld) this.releaseKey(pos.line, pos.bit);
            this._updateModifiers();
        }

        _updateModifiers() {
            for (const name of Object.keys(this.modifiers)) {
                this.modifiers[name] = [...this._pressedPositions.keys()].some(
                    (code) => CPC_MODIFIER_NAMES[code] === name,
                );
            }
        }

        translateCode(code) {
            if (this._getJoystickEnabled()) {
                switch (code) {
                    case "ArrowLeft": return { line: 9, bit: 2 };
                    case "ArrowUp": return { line: 9, bit: 0 };
                    case "ArrowRight": return { line: 9, bit: 3 };
                    case "ArrowDown": return { line: 9, bit: 1 };
                    case "ControlLeft": case "ControlRight": return { line: 9, bit: 4 };
                    case "AltLeft": case "AltRight": return { line: 9, bit: 5 };
                }
            }
            return this.layoutMap[code] || null;
        }
    }

    Keyboard.CRITICAL_CODES = new Set([
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "Tab", "Backspace",
        ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
    ]);

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

// =============================================================================
// InputExpansion — Extended joystick port (DB9 connector)
// =============================================================================

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
 * Text is mapped through a single UK character table and queued FIFO. The
 * emulated display calls tick() once per rendered emulation frame: each
 * character is held for three frames, released for three frames, then the next
 * one is pressed. No host timer drives key injection.
 *
 * The mapping does not depend on the host keyboard layout nor on the loaded
 * firmware ROM — the text typed is the text asked for. Characters outside the
 * table are ignored silently rather than typed approximately. Matrix
 * descriptors use a zero-based bit index.
 */
const createAutoType = (keyboard) => {

    // ── TABLE UK STANDARD : CARACTÈRE → MATRICE CPC ─────────────────────────
    //
    // Cette table est EXTRAITE de la table de traduction du firmware UK : les
    // 240 octets que le ROM patche à `0x1D69` (464) ou `0x1EEF` (6128), soit
    // trois blocs de 80 octets — non-majoré, majoré, COPY — pour les 10 lignes
    // de 8 touches. Elle décrit donc ce que le firmware UK produit
    // RÉELLEMENT, et non une devinette.
    //
    // L'extraire plutôt que de l'écrire à la main est la correction de fond. Les
    // tables précédentes recopiaient les positions à la main et divergeaient :
    // en AZERTY `w` et `z` s'étaient landing inversés, et la rangée des chiffres
    // était décalée d'une touche. Une table dérivée du firmware ne peut plus
    // mentir sur ce que le CPC affiche.
    //
    // `UK_CHARACTER_TABLE` associe à chaque position de matrice la liste des
    // caractères qu'elle produit ; `buildAutoTypeMap()` l'inverse ensuite en
    // `caractère → { line, bit, shift }`.
    //
    // Seuls les codes imprimables ASCII (0x20-0x7E) sont retenus : les touches
    // de fonction, le pavé directionnel et COPY portent des codes hors de cette
    // plage et ne doivent pas être confondus avec des caractères. Le saut de
    // ligne est la touche ENTER, que le firmware code 0x0D.
    //
    // La table est UK parce que c'est le firmware de référence Amstrad : les
    // autres firmwares ne font que patcher celui-ci. `AUTOTYPE_MAPS` ne dépend
    // donc d'aucune ROM charged, et le texte tapé est celui demandé.
    const UK_CHARACTER_TABLE = {
        // Ligne 2
        '2:1:0:0': ['['], '2:1:1:0': ['{'], '2:2:0:0': ['LF', 'CR'], '2:3:0:0': [']'], '2:3:1:0': ['}'], '2:6:0:0': ['\\'], '2:6:1:0': ['`'],
        // Ligne 3
        '3:0:0:0': ['^'], '3:1:0:0': ['-'], '3:1:1:0': ['='], '3:2:0:0': ['@'], '3:2:1:0': ['|'], '3:3:0:0': ['p'], '3:3:1:0': ['P'], '3:4:0:0': [';'], '3:4:1:0': ['+'], '3:5:0:0': [':'], '3:5:1:0': ['*'], '3:6:0:0': ['/'], '3:6:1:0': ['?'], '3:7:0:0': ['.'], '3:7:1:0': ['>'],
        // Ligne 4
        '4:0:0:0': ['0'], '4:0:1:0': ['_'], '4:1:0:0': ['9'], '4:1:1:0': [')'], '4:2:0:0': ['o'], '4:2:1:0': ['O'], '4:3:0:0': ['i'], '4:3:1:0': ['I'], '4:4:0:0': ['l'], '4:4:1:0': ['L'], '4:5:0:0': ['k'], '4:5:1:0': ['K'], '4:6:0:0': ['m'], '4:6:1:0': ['M'], '4:7:0:0': [','], '4:7:1:0': ['<'],
        // Ligne 5
        '5:0:0:0': ['8'], '5:0:1:0': ['('], '5:1:0:0': ['7'], '5:1:1:0': ['\''], '5:2:0:0': ['u'], '5:2:1:0': ['U'], '5:3:0:0': ['y'], '5:3:1:0': ['Y'], '5:4:0:0': ['h'], '5:4:1:0': ['H'], '5:5:0:0': ['j'], '5:5:1:0': ['J'], '5:6:0:0': ['n'], '5:6:1:0': ['N'], '5:7:0:0': [' '],
        // Ligne 6
        '6:0:0:0': ['6'], '6:0:1:0': ['&'], '6:1:0:0': ['5'], '6:1:1:0': ['%'], '6:2:0:0': ['r'], '6:2:1:0': ['R'], '6:3:0:0': ['t'], '6:3:1:0': ['T'], '6:4:0:0': ['g'], '6:4:1:0': ['G'], '6:5:0:0': ['f'], '6:5:1:0': ['F'], '6:6:0:0': ['b'], '6:6:1:0': ['B'], '6:7:0:0': ['v'], '6:7:1:0': ['V'],
        // Ligne 7
        '7:0:0:0': ['4'], '7:0:1:0': ['$'], '7:1:0:0': ['3'], '7:1:1:0': ['#'], '7:2:0:0': ['e'], '7:2:1:0': ['E'], '7:3:0:0': ['w'], '7:3:1:0': ['W'], '7:4:0:0': ['s'], '7:4:1:0': ['S'], '7:5:0:0': ['d'], '7:5:1:0': ['D'], '7:6:0:0': ['c'], '7:6:1:0': ['C'], '7:7:0:0': ['x'], '7:7:1:0': ['X'],
        // Ligne 8
        '8:0:0:0': ['1'], '8:0:1:0': ['!'], '8:1:0:0': ['2'], '8:1:0:1': ['~'], '8:1:1:0': ['"'], '8:3:0:0': ['q'], '8:3:1:0': ['Q'], '8:4:0:0': ['TAB'], '8:5:0:0': ['a'], '8:5:1:0': ['A'], '8:7:0:0': ['z'], '8:7:1:0': ['Z'],
    };

    // ── TABLES FRANÇAISE ET ESPAGNOLE ──────────────────────────────────────
    //
    // Extraites de la même façon que la table UK, mais des firmwares FRANÇAIS
    // et ESPAGNOL — voir `scripts/extract-keytrans.mjs`.
    //
    // Elles ne sont pas optionnelles : injecter les positions UK sur une ROM
    // française tape les mauvais caractères. En AZERTY, `a` est en 8:3 et non
    // 8:5, `z` en 7:3, `w` en 8:7, `m` en 3:5. C'est exactement ce qui
    // produisait « RE? » au lieu de « REM » avec un firmware français chargé.
    //
    // AUCUN ACCENT (`é`, `à`, `ç`) : ce n'est pas une omission de cette
    // extraction, c'est la vérité matérielle. La table du firmware français
    // n'en contient aucun — vérifié sur la ROM. Sur un CPC français, ces
    // caractères s'obtiennent par le mode COPY du générateur de caractères,
    // pas au clavier. Les inventer ici les taperait approximativement, ce que
    // la règle « jamais tapé approximativement » interdit.
    const FR_CHARACTER_TABLE = {
    // Ligne 2
    '2:1:0:0': ['*'], '2:1:1:0': ['<'], '2:2:0:0': ['CR'], '2:3:0:0': ['#'], '2:3:1:0': ['>'], '2:6:0:0': ['$'], 
    // Ligne 3
    '3:0:0:0': ['-'], '3:0:1:0': ['_'], '3:1:0:0': [')'], '3:1:1:0': ['['], '3:2:0:0': ['^'], '3:3:0:0': ['p'], '3:3:1:0': ['P'], '3:4:0:0': ['|'], '3:4:1:0': ['%'], '3:5:0:0': ['m'], '3:5:1:0': ['M'], '3:6:0:0': ['='], '3:6:1:0': ['+'], '3:7:0:0': [':'], '3:7:1:0': ['/'], 
    // Ligne 4
    '4:0:0:0': ['@'], '4:0:1:0': ['0'], '4:1:0:0': ['BS'], '4:1:1:0': ['9'], '4:2:0:0': ['o'], '4:2:1:0': ['O'], '4:3:0:0': ['i'], '4:3:1:0': ['I'], '4:4:0:0': ['l'], '4:4:1:0': ['L'], '4:5:0:0': ['k'], '4:5:1:0': ['K'], '4:6:0:0': [','], '4:6:1:0': ['?'], '4:7:0:0': [';'], '4:7:1:0': ['.'], 
    // Ligne 5
    '5:0:0:0': ['!'], '5:0:1:0': ['8'], '5:1:0:0': ['}'], '5:1:1:0': ['7'], '5:2:0:0': ['u'], '5:2:1:0': ['U'], '5:3:0:0': ['y'], '5:3:1:0': ['Y'], '5:4:0:0': ['h'], '5:4:1:0': ['H'], '5:5:0:0': ['j'], '5:5:1:0': ['J'], '5:6:0:0': ['n'], '5:6:1:0': ['N'], '5:7:0:0': ['SP'], 
    // Ligne 6
    '6:0:0:0': [']'], '6:0:1:0': ['6'], '6:1:0:0': ['('], '6:1:1:0': ['5'], '6:2:0:0': ['r'], '6:2:1:0': ['R'], '6:3:0:0': ['t'], '6:3:1:0': ['T'], '6:4:0:0': ['g'], '6:4:1:0': ['G'], '6:5:0:0': ['f'], '6:5:1:0': ['F'], '6:6:0:0': ['b'], '6:6:1:0': ['B'], '6:7:0:0': ['v'], '6:7:1:0': ['V'], 
    // Ligne 7
    '7:0:0:0': ['\''], '7:0:1:0': ['4'], '7:1:0:0': ['"'], '7:1:1:0': ['3'], '7:2:0:0': ['e'], '7:2:1:0': ['E'], '7:3:0:0': ['z'], '7:3:1:0': ['Z'], '7:4:0:0': ['s'], '7:4:1:0': ['S'], '7:5:0:0': ['d'], '7:5:1:0': ['D'], '7:6:0:0': ['c'], '7:6:1:0': ['C'], '7:7:0:0': ['x'], '7:7:1:0': ['X'], 
    // Ligne 8
    '8:0:0:0': ['&'], '8:0:1:0': ['1'], '8:1:0:0': ['{'], '8:1:1:0': ['2'], '8:1:0:1': ['~'], '8:3:0:0': ['a'], '8:3:1:0': ['A'], '8:4:0:0': ['TAB'], '8:5:0:0': ['q'], '8:5:1:0': ['Q'], '8:7:0:0': ['w'], '8:7:1:0': ['W'],
    };

    const ES_CHARACTER_TABLE = {
    // Ligne 2
    '2:1:0:0': ['['], '2:1:1:0': ['*'], '2:2:0:0': ['CR'], '2:3:0:0': [']'], '2:3:1:0': ['+'], '2:6:0:0': ['BS'], '2:6:1:0': ['`'], 
    // Ligne 3
    '3:0:0:0': ['^'], '3:1:0:0': ['-'], '3:1:1:0': ['='], '3:2:0:0': ['@'], '3:2:1:0': ['|'], '3:3:0:0': ['p'], '3:3:1:0': ['P'], '3:4:0:0': [';'], '3:4:1:0': [':'], '3:6:0:0': ['/'], '3:6:1:0': ['?'], '3:7:0:0': ['.'], '3:7:1:0': ['>'], 
    // Ligne 4
    '4:0:0:0': ['0'], '4:0:1:0': ['_'], '4:1:0:0': ['9'], '4:1:1:0': [')'], '4:1:0:1': ['}'], '4:2:0:0': ['o'], '4:2:1:0': ['O'], '4:3:0:0': ['i'], '4:3:1:0': ['I'], '4:4:0:0': ['l'], '4:4:1:0': ['L'], '4:5:0:0': ['k'], '4:5:1:0': ['K'], '4:6:0:0': ['m'], '4:6:1:0': ['M'], '4:7:0:0': [','], '4:7:1:0': ['<'], 
    // Ligne 5
    '5:0:0:0': ['8'], '5:0:1:0': ['('], '5:0:0:1': ['{'], '5:1:0:0': ['7'], '5:1:1:0': ['\''], '5:2:0:0': ['u'], '5:2:1:0': ['U'], '5:3:0:0': ['y'], '5:3:1:0': ['Y'], '5:4:0:0': ['h'], '5:4:1:0': ['H'], '5:5:0:0': ['j'], '5:5:1:0': ['J'], '5:6:0:0': ['n'], '5:6:1:0': ['N'], '5:7:0:0': ['SP'], 
    // Ligne 6
    '6:0:0:0': ['6'], '6:0:1:0': ['&'], '6:1:0:0': ['5'], '6:1:1:0': ['%'], '6:2:0:0': ['r'], '6:2:1:0': ['R'], '6:3:0:0': ['t'], '6:3:1:0': ['T'], '6:4:0:0': ['g'], '6:4:1:0': ['G'], '6:5:0:0': ['f'], '6:5:1:0': ['F'], '6:6:0:0': ['b'], '6:6:1:0': ['B'], '6:7:0:0': ['v'], '6:7:1:0': ['V'], 
    // Ligne 7
    '7:0:0:0': ['4'], '7:0:1:0': ['$'], '7:1:0:0': ['3'], '7:1:1:0': ['#'], '7:2:0:0': ['e'], '7:2:1:0': ['E'], '7:3:0:0': ['w'], '7:3:1:0': ['W'], '7:4:0:0': ['s'], '7:4:1:0': ['S'], '7:5:0:0': ['d'], '7:5:1:0': ['D'], '7:6:0:0': ['c'], '7:6:1:0': ['C'], '7:7:0:0': ['x'], '7:7:1:0': ['X'], 
    // Ligne 8
    '8:0:0:0': ['1'], '8:0:1:0': ['!'], '8:1:0:0': ['2'], '8:1:1:0': ['"'], '8:1:0:1': ['~'], '8:3:0:0': ['q'], '8:3:1:0': ['Q'], '8:4:0:0': ['TAB'], '8:5:0:0': ['a'], '8:5:1:0': ['A'], '8:7:0:0': ['z'], '8:7:1:0': ['Z'],
    };

    /**
     * Table inversée : caractère → descripteur de frappe.
     *
     * Chaque descripteur ne contient que la position et les modificateurs —
     * aucune valeur de caractère, donc aucune donnée de ROM.
     *
     * @param {Object} table Table `{ 'ligne:bit:shift:ctrl': [libellés] }`.
     * @returns {Object} Table `{ line, bit, shift, ctrl }` gelée, indexée par caractère.
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
                // `LF`, `CR`, `TAB`, `SP` et `BS` sont des alias lisibles : le
                // source resterait sinon illisible, ces caractères n'étant ni
                // visibles ni saisissables dans une chaîne entre apostrophes.
                const key = label === 'LF' ? String.fromCharCode(10)
                    : label === 'CR' ? String.fromCharCode(13)
                    : label === 'TAB' ? String.fromCharCode(9)
                    : label === 'SP' ? ' '
                    : label === 'BS' ? '\\'
                    : label;
                poser(key, line, bit, shift, ctrl);

                // ── LE RETOUR À LA LIGNE EST UN SEUL RETURN ──────────────────
                // Le firmware ne code que 0x0D pour la touche ENTER : les
                // tables extraites de la ROM ne contiennent donc que `CR`, et
                // aucune mention de `LF`. Or `typeString()` normalise tout en
                // `\n` (LF) — c'est la forme la plus naturelle à écrire, et celle
                // que produisent `textarea` et les chaînes multi-lignes.
                //
                // Sans cet alias, le RETURN n'était trouvé QUE sur la table UK
                // (qui portait `LF` parce qu'elle avait été écrite à la main) :
                // sur firmware français ou espagnol, `RUN"…\n` perdait
                // purement et simplement son retour, et la commande n'était
                // jamais exécutée.
                //
                // LF et CR sont ici la MÊME touche physique : les traiter comme
                // deux touches distinctes n'aurait aucun sens matériel.
                if (label === 'CR') poser(String.fromCharCode(10), line, bit, shift, ctrl);
            }
        }
        return Object.freeze(result);
    };

    // ── TABLES D'INJECTION, UNE PAR FIRMWARE ─────────────────────────────────
    //
    // La table suit le FIRMWARE CHARGÉ, et non le clavier de l'utilisateur :
    // les deux n'ont aucune raison de coïncider. Injecter les positions UK
    // dans une ROM française tape les mauvais caractères — en AZERTY, `a` est en
    // 8:3 et non 8:5. C'est ce qui produisait « RE? » au lieu de « REM ».
    //
    // Le UK reste la valeur par défaut : c'est le firmware de référence, et le
    // seul que l'on puisse garantir tant qu'aucun firmware n'est sélectionné.
    //
    // La clé est `US` et non `UK` pour coller au nom de disposition du
    // clavier (`CPC_KEYBOARD_MAPS.US`), afin que `AUTOTYPE_MAPS[keyboard.layout]`
    // fonctionne sans table de correspondance.
    const AUTOTYPE_MAPS = Object.freeze({
        US: buildAutoTypeMap(UK_CHARACTER_TABLE),
        FR: buildAutoTypeMap(FR_CHARACTER_TABLE),
        ES: buildAutoTypeMap(ES_CHARACTER_TABLE),
    });

    // ── MACHINE À ÉTATS DE L'INJECTION ──────────────────────────────────────
    //
    // `PRESS`   : la touche et son modificateur SHIFT sont maintenus enfoncés
    //             dans la matrice pendant PRESS_FRAMES images.
    // `RELEASE` : la touche est relâchée pendant RELEASE_FRAMES images.
    //
    // ── CADENCE ─────────────────────────────────────────────────────────────
    // Une image par phase suffit désormais, contre trois auparavant. La
    // cadence est en effet dictée par le nombre de LECTURES que le firmware
    // fait de la matrice entre deux images, pas par la durée de l'image : à
    // 50 Hz, le firmware interroge le clavier des milliers de fois par image.
    // Trois images de maintien et trois de relâchement n'actaient donc que sur
    // le temps d'affichage du texte tapé, pas sur sa chances d'être vu — et
    // ralentissaient la frappe d'un facteur six.
    //
    // Ce qui garantit la lecture n'est plus la durée mais la PORTE ci-dessous :
    // on n'envoie rien tant que le firmware n'a pas interrogé le clavier.
    const PRESS_FRAMES = 1;
    const RELEASE_FRAMES = 1;
    const GAP_FRAMES = 1;

    const queue = [];
    let phase = 'IDLE';
    let currentKey = null;
    let pressFramesLeft = 0;
    let releaseFramesLeft = 0;
    let gapFramesLeft = 0;
    let pressedByAutoType = [];

    // ── PORTE FIRMWARE ──────────────────────────────────────────────────────
    //
    // Le firmware du CPC balaie la matrice en boucle pour savoir si une touche
    // est enfoncée. Injecter un caractère dans une boucle qui n'écoute pas ne
    // produit rien : la touche est relancée et le caractère est perdu.
    //
    // La porte compte donc les INTERROGATIONS réelles de la matrice — les
    // appels à `readAYPort()`, c'est-à-dire les lectures du registre 14 du PSG
    // — et n'autorise une frappe qu'une fois le firmware observé. Un texte
    // reste donc en file, intact, si le programme n'écoute pas : il sera tapé
    // dès que celui-ci consultera enfin le clavier.
    let firmwareReads = 0;
    let readsAtLastKeystroke = 0;
    let readsAtPress = 0;
    let readsAtRelease = 0;

    /** Le firmware a-t-il interrogé le clavier depuis la frappe précédente ? */
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
     * Relâche les touches injectées en cours sans vider la file.
     *
     * Le caractère en cours d'injection est REMIS EN TÊTE de file plutôt que
     * perdu : il avait déjà été sorti de la file au moment de l'appui, et le
     * relâchement empêche le firmware de le lire. Il doit donc être retapé, ce
     * qui est le comportement attendu quand la frappe est interrompue en cours
     * de route (changement de fenêtre, par exemple).
     */
    function suspend() {
        if (currentKey) queue.unshift(currentKey);
        releaseCurrent();
        pressFramesLeft = 0;
        releaseFramesLeft = 0;
        gapFramesLeft = 0;
        phase = 'IDLE';
    }

    function pressPosition(line, bit) {
        if (keyboard.matrix[line] & (1 << bit)) {
            keyboard.setKeyState(line, bit, true);
            pressedByAutoType.push({ line, bit });
        }
    }

    function beginNextCharacter() {
        // Porte firmware : rien n'est envoyé tant que le CPC n'a pas interrogé
        // la matrice depuis la frappe précédente.
        if (queue.length > 0 && !firmwareIsListening()) return;

        readsAtLastKeystroke = firmwareReads;
        currentKey = queue.shift() || null;
        if (!currentKey) {
            phase = 'IDLE';
            return;
        }
        pressPosition(currentKey.line, currentKey.bit);
        // SHIFT est la touche 2:5 et CTRL la touche 2:7 du CPC.
        if (currentKey.shift) pressPosition(2, 5);
        if (currentKey.ctrl) pressPosition(2, 7);
        pressFramesLeft = PRESS_FRAMES;
        readsAtPress = firmwareReads;
        phase = 'PRESS';
    }

    /** Une image d'émulation : fait avancer la machine à états. */
    function tick() {
        if (phase === 'IDLE') {
            beginNextCharacter();
            return;
        }

        if (phase === 'PRESS') {
            // On ne relâche que si le firmware a VU la touche enfoncée. Les DEUX
            // conditions sont cumulatives : le temps minimal doit être écoulé ET
            // le firmware avoir vu l'appui. Un OU au lieu d'un ET ferait relâcher
            // dès la première image, puisque le compteur minimal vaut 1 — et la
            // frappe entière passerait entre deux balayages.
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
            // Le relâchement doit être OBSERVÉ : deux frappes identiques (« RR »,
            // « TT ») ne se distinguent que si le firmware voit la touche
            // REMONTRER entre les deux. Sans cela, il ne voit qu'une touche
            // enfoncée continue et n'enregistre qu'un seul « R ».
            const firmwareHasSeenRelease = firmwareReads > readsAtRelease;
            if (releaseFramesLeft > 1 || !firmwareHasSeenRelease) {
                if (releaseFramesLeft > 1) releaseFramesLeft--;
                return;
            }
            // Clavier vide : garantit une image entière sans touche entre deux
            // caractères.
            phase = 'IDLE';
            gapFramesLeft = GAP_FRAMES;
            return;
        }

        if (phase === 'GAP') {
            if (gapFramesLeft > 1) {
                gapFramesLeft--;
                return;
            }
            phase = 'IDLE';
        }
    }

    /**
     * Met une chaîne dans la file d'attente FIFO.
     *
     * Chaque caractère est converti en descripteur au moment de l'appel, à
     * partir de la table UK : le texte à taper ne dépend donc d'aucun clavier
     * ni d'aucune ROM. Un CRLF est normalisé en un unique saut de ligne, et
     * les caractères hors table sont ignorés silencieusement — les injecter
     * approximativement produirait une faute de frappe.
     *
     * @param {string} text Texte à taper, par exemple `RUN"DISC\n`.
     * @returns {void}
     */
    function typeString(text) {
        const normalized = String(text).replace(/\r\n?/g, '\n');
        // La table est choisie au moment de l'enfilement, d'après le firmware
        // actuellement sélectionné : changer de firmware entre la commande et
        // sa frappe ne doit pas mélanger deux jeux de positions.
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
        gapFramesLeft = 0;
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
        // `autotype` et `onFrame` sont les noms historiques, conservés parce
        // que les pages et l'UI les appellent déjà.
        autotype: typeString,
        inject: typeString,
        tick,
        onFrame: tick,
        cancel,
        suspend,
        // Enregistre une interrogation réelle de la matrice par le firmware.
        // C'est ce qui ouvre la porte : sans lecture, aucune frappe n'est émise.
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
     * @description Injection de caractères dans la matrice, synchronisée sur les
     * frames d'émulation.
     */
    class AutoType {
        constructor(keyboard) {
            this._engine = createAutoType(keyboard);
            keyboard._autoType = this;
        }

        /** Met une chaîne dans la file FIFO. */
        typeString(text) { return this._engine.typeString(text); }
        /** Une image d'émulation : fait avancer la machine à états. */
        tick() { return this._engine.tick(); }
        cancelAutotype() { return this._engine.cancel(); }
        /** Relâche la frappe en cours en conservant le texte à taper. */
        releaseCurrent() { return this._engine.suspend(); }
        /** Enregistre une interrogation de la matrice par le firmware. */
        noteFirmwareRead() { return this._engine.noteFirmwareRead(); }
        cancel() { return this.cancelAutotype(); }
        isAutotyping() { return this._engine.isAutotyping(); }

        // Noms historiques, conservés pour les appelants existants.
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
