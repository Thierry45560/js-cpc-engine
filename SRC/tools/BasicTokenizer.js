/**
 * @file BasicTokenizer.js
 * @module BasicTokenizer
 *
 * Converts a Locomotive BASIC listing (ASCII) into the TOKENISED program the CPC
 * BASIC expects from &0170 in memory, and writes it there.
 *
 * BASIC program memory:
 *   0040-016F  input area (typed lines, untokenised)
 *   0170-...   PROGRAM (tokenised) → variables → arrays → free space
 *              → strings, growing downwards from HIMEM
 *
 * The program ends with a zero line length (00 00).
 *
 * Four pointers must be set to "&0170 + size":
 *   BASIC 1.1 (664, 6128, 6128+) : &AE66 &AE68 &AE6A &AE6C
 *   BASIC 1.0 (464, 464+)        : &AE83 &AE85 &AE87 &AE89
 * (source: Amstrad CPC Firmware Manual, "Use of memory by the OS".)
 *
 * Line format: [length 2B LE] [number 2B LE] [tokens + ASCII + strings] [00],
 * where length = 5 + body bytes.
 *
 * The module has no dependency on the bus or the DOM: `injecter()` receives the
 * write function as a parameter.
 */

"use strict";

const BasicTokenizer = (() => {

    /** Address of the first byte of the BASIC program. */
    const ADRESSE_PROGRAMME = 0x0170;

    /**
     * Last address usable by the program, per firmware version. Beyond it lies
     * the BASIC work area (&AC00…).
     */
    const LIMITE_BASIC_1_0 = 0xae85;
    const LIMITE_BASIC_1_1 = 0xae68;

    // ---------------------------------------------------------------------------
    // Tables de tokens
    // ---------------------------------------------------------------------------

    /**
     * Unprefixed keywords (0x80-0xFF). Composed forms that reuse the token of
     * their first word (LINE INPUT, CHAIN MERGE, EVERY GOSUB, WINDOW SWAP,
     * GRAPHICS PAPER…) need no dedicated entry.
     * @type {Object<string, number>}
     */
    const MOTS = {
        after: 0x80, auto: 0x81, border: 0x82, call: 0x83, cat: 0x84,
        chain: 0x85, clear: 0x86, clg: 0x87, closein: 0x88, closeout: 0x89,
        cls: 0x8a, cont: 0x8b, data: 0x8c, def: 0x8d, defint: 0x8e,
        defreal: 0x8f, defstr: 0x90, deg: 0x91, delete: 0x92, dim: 0x93,
        draw: 0x94, drawr: 0x95, edit: 0x96, else: 0x97, end: 0x98,
        ent: 0x99, env: 0x9a, erase: 0x9b, error: 0x9c, every: 0x9d,
        for: 0x9e, gosub: 0x9f, goto: 0xa0, if: 0xa1, ink: 0xa2,
        input: 0xa3, key: 0xa4, let: 0xa5, line: 0xa6, list: 0xa7,
        load: 0xa8, locate: 0xa9, memory: 0xaa, merge: 0xab, mid$: 0xac,
        mode: 0xad, move: 0xae, mover: 0xaf, next: 0xb0, new: 0xb1,
        on: 0xb2, openin: 0xb6, openout: 0xb7, origin: 0xb8, out: 0xb9,
        paper: 0xba, pen: 0xbb, plot: 0xbc, plotr: 0xbd, poke: 0xbe,
        print: 0xbf, rad: 0xc1, randomize: 0xc2, read: 0xc3, release: 0xc4,
        rem: 0xc5, renum: 0xc6, restore: 0xc7, resume: 0xc8, return: 0xc9,
        run: 0xca, save: 0xcb, sound: 0xcc, speed: 0xcd, stop: 0xce,
        symbol: 0xcf, tag: 0xd0, tagoff: 0xd1, troff: 0xd2, tron: 0xd3,
        wait: 0xd4, wend: 0xd5, while: 0xd6, width: 0xd7, window: 0xd8,
        write: 0xd9, zone: 0xda, di: 0xdb, ei: 0xdc, fill: 0xdd,
        graphics: 0xde, mask: 0xdf, frame: 0xe0, cursor: 0xe1, erl: 0xe3,
        fn: 0xe4, spc: 0xe5, step: 0xe6, swap: 0xe7, tab: 0xea,
        then: 0xeb, to: 0xec, using: 0xed, and: 0xfa, mod: 0xfb,
        or: 0xfc, xor: 0xfd, not: 0xfe,
    };

    /**
     * Functions, prefixed with 0xFF. Each name carries its own trailing `$`.
     * @type {Object<string, number>}
     */
    const FONCTIONS = {
        abs: 0x00, asc: 0x01, atn: 0x02, "chr$": 0x03, cint: 0x04,
        cos: 0x05, creal: 0x06, exp: 0x07, fix: 0x08, fre: 0x09,
        inkey: 0x0a, inp: 0x0b, int: 0x0c, joy: 0x0d, len: 0x0e,
        log: 0x0f, log10: 0x10, "lower$": 0x11, peek: 0x12, remain: 0x13,
        sgn: 0x14, sin: 0x15, "space$": 0x16, sq: 0x17, sqr: 0x18,
        "str$": 0x19, tan: 0x1a, unt: 0x1b, "upper$": 0x1c, val: 0x1d,
        eof: 0x40, err: 0x41, himem: 0x42, "inkey$": 0x43, pi: 0x44,
        rnd: 0x45, time: 0x46, xpos: 0x47, ypos: 0x48, derr: 0x49,
        "bin$": 0x71, "dec$": 0x72, "hex$": 0x73, instr: 0x74, "left$": 0x75,
        max: 0x76, min: 0x77, pos: 0x78, "right$": 0x79, round: 0x7a,
        "string$": 0x7b, test: 0x7c, testr: 0x7d, "copychr$": 0x7e, vpos: 0x7f,
    };

    /**
     * Composed forms whose token DIFFERS from their first word.
     * @type {Object<string, number>}
     */
    const COMPOSES = {
        "on error goto": 0xb4,
        "on error go to": 0xb4,
        "on break": 0xb3,
        "on sq": 0xb5,
        "go sub": 0x9f,
        "go to": 0xa0,
    };

    /**
     * Keywords that open a zone copied verbatim, without tokenisation, with the
     * character that closes it:
     *
     *   REM  → "eol": the rest of the line, where `:` is comment text;
     *   DATA → ":": the data list stops at the next statement separator.
     * @type {Object<string, string>}
     */
    const BRUTS = { rem: "eol", data: ":" };

    /**
     * Single lookup list, sorted from the longest word to the shortest, so that
     * INKEY$ wins over INKEY, MODE over MOD and STRING$ over STR$.
     * @type {Array<{mot: string, octets: number[], brut: boolean, separateur: boolean}>}
     */
    const LISTE = [];

    Object.keys(COMPOSES).forEach((mot) => {
        LISTE.push({ mot: mot, octets: [COMPOSES[mot]], brut: false, separateur: false });
    });
    Object.keys(MOTS).forEach((mot) => {
        LISTE.push({
            mot: mot,
            octets: [MOTS[mot]],
            brut: BRUTS[mot] || null,
            separateur: false,
        });
    });
    Object.keys(FONCTIONS).forEach((mot) => {
        LISTE.push({ mot: mot, octets: [0xff, FONCTIONS[mot]], brut: false, separateur: false });
    });

    // ELSE is stored preceded by a statement separator (01), which marks the end
    // of a THEN branch.
    LISTE.forEach((entree) => {
        if (entree.mot === "else") entree.separateur = true;
    });

    LISTE.sort((a, b) => b.mot.length - a.mot.length);

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    /**
     * `true` for the letters A-Z / a-z.
     * @param {number} code ASCII code.
     * @returns {boolean}
     */
    const estLettre = (code) => (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);

    /**
     * `true` for letters and digits (rest of a variable name).
     * @param {number} code ASCII code.
     * @returns {boolean}
     */
    const estAlphanum = (code) => estLettre(code) || (code >= 0x30 && code <= 0x39);

    /**
     * A keyword only ends on a boundary, so that "TOTAL" does not match "TO" +
     * "TAL". Digits remain allowed right after ("GOTO100" is valid).
     * @param {string} minuscule Lower-cased line.
     * @param {number} index     Index after the keyword.
     * @returns {boolean}
     */
    const frontiere = (minuscule, index) =>
        index >= minuscule.length || !estLettre(minuscule.charCodeAt(index));

    /**
     * Looks for the longest keyword recognised at the given position. The tables
     * are lower-cased, so the comparison runs on the lower-cased line.
     * @param {string} minuscule Lower-cased line.
     * @param {number} i         Start position.
     * @returns {{entree: object, longueur: number}|null}
     */
    function chercherMot(minuscule, i) {
        for (let k = 0; k < LISTE.length; k++) {
            const entree = LISTE[k];
            if (minuscule.startsWith(entree.mot, i) && frontiere(minuscule, i + entree.mot.length)) {
                return { entree: entree, longueur: entree.mot.length };
            }
        }
        return null;
    }

    /**
     * Encodes a floating point number in BASIC format.
     *
     * Layout: four mantissa bytes (byte 3: bit 7 = sign, bits 6-0 = mantissa bits
     * 30-24) followed by the exponent biased by 128. The value is 1,xxxx × 2^e,
     * so the leading "1" is implicit and not stored.
     *
     * @param {number} nombre Value to encode.
     * @returns {number[]} 5 bytes.
     */
    function octetsFlottant(nombre) {
        let signe = 0;
        let valeur = nombre;
        let mantisse = 0;
        let exposant = 0;

        if (valeur !== 0) {
            if (valeur < 0) { signe = 0x80; valeur = -valeur; }
            exposant = Math.floor(Math.log(valeur) / Math.LN2);
            let m = valeur / Math.pow(2, exposant);
            if (m >= 2) { exposant += 1; m /= 2; }
            if (m < 1) { exposant -= 1; m *= 2; }

            let bits = Math.round((m - 1) * 2147483648);
            // Rounding can push the mantissa up to 2,0: renormalise.
            if (bits >= 2147483648) { bits = 0; exposant += 1; }
            mantisse = bits;
            exposant += 128;
        }

        const m = mantisse >>> 0;
        return [
            m & 0xff,
            (m >>> 8) & 0xff,
            (m >>> 16) & 0xff,
            ((m >>> 24) & 0x7f) | signe,
            exposant & 0xff,
        ];
    }

    /**
     * Reads a number from `i` and returns its tokenised bytes.
     *
     * Locomotive tokeniser rules:
     *   0 to 9         → single byte (0x0E + n)
     *   10 to 255      → 0x19 followed by the value
     *   up to 32767    → 0x1A followed by the value on 2 bytes
     *   otherwise      → 0x1F followed by the 5-byte float
     * Binary "&X…" → 0x1B; hexadecimal "&H…" or "&…" → 0x1C.
     *
     * @param {string} texte Source line.
     * @param {number} i     Start position.
     * @returns {{octets: number[], suivant: number}}
     */
    function lireNombre(texte, i) {
        const n = texte.length;

        if (texte[i] === "&") {
            let j = i + 1;
            let base = 16;
            let token = 0x1c;
            const lettre = j < n ? texte[j].toUpperCase() : "";
            if (lettre === "X") { base = 2; token = 0x1b; j++; }
            else if (lettre === "H") { j++; }
            const debut = j;
            const motif = base === 2 ? /[01]/ : /[0-9A-Fa-f]/;
            while (j < n && motif.test(texte[j])) j++;
            const valeur = (debut === j ? 0 : parseInt(texte.slice(debut, j), base)) & 0xffff;
            return { octets: [token, valeur & 0xff, (valeur >>> 8) & 0xff], suivant: j };
        }

        let j = i;
        let point = false;
        while (j < n) {
            const c = texte[j];
            if (c >= "0" && c <= "9") { j++; continue; }
            if (c === "." && !point) { point = true; j++; continue; }
            break;
        }

        const valeur = parseFloat(texte.slice(i, j));
        if (!point && Number.isInteger(valeur) && valeur >= 0) {
            if (valeur <= 9) return { octets: [0x0e + valeur], suivant: j };
            if (valeur <= 0xff) return { octets: [0x19, valeur], suivant: j };
            if (valeur <= 0x7fff) {
                return { octets: [0x1a, valeur & 0xff, (valeur >>> 8) & 0xff], suivant: j };
            }
        }
        return { octets: [0x1f].concat(octetsFlottant(valeur)), suivant: j };
    }

    /**
     * Reads a variable name and tokenises it.
     *
     * A name is stored as: [type token] [16-bit offset, zero here] [letters, last
     * character with bit 7 set]. The type comes from the suffix (`%`, `$`, `!`);
     * no suffix means the "any" type.
     *
     * @param {string} texte Source line.
     * @param {number} i     Start position (a letter).
     * @returns {{octets: number[], suivant: number}}
     */
    function lireVariable(texte, i) {
        const n = texte.length;
        let j = i;
        while (j < n && estAlphanum(texte.charCodeAt(j))) j++;

        let suffixe = "";
        if (j < n && (texte[j] === "$" || texte[j] === "%" || texte[j] === "!")) {
            suffixe = texte[j];
            j++;
        }

        let type = 0x0d;
        if (suffixe === "$") type = 0x03;
        else if (suffixe === "%") type = 0x02;
        else if (suffixe === "!") type = 0x04;

        const nom = texte.slice(i, j - (suffixe ? 1 : 0));
        const octets = [type, 0x00, 0x00];
        for (let k = 0; k < nom.length; k++) {
            const code = nom.charCodeAt(k) & 0x7f;
            octets.push(k === nom.length - 1 ? (code | 0x80) : code);
        }
        return { octets: octets, suivant: j };
    }

    /** Single-character operators, comparisons excluded. */
    const OPERATEURS = { "+": 0xf4, "-": 0xf5, "*": 0xf6, "/": 0xf7, "^": 0xf8, "\\": 0xf9, ":": 0x01 };

    /**
     * Keywords after which a bare integer is a LINE NUMBER and not a constant:
     * "GOTO 100" yields token 0x1E followed by 100, not the constant 0x19 0x64.
     * Indexed by the last byte of the token.
     * @type {Object<number, boolean>}
     */
    const ATTEND_UN_NUMERO = {
        0x92: true, // DELETE
        0x97: true, // ELSE (the "ELSE 200" branch)
        0x9f: true, // GOSUB
        0xa0: true, // GOTO
        0xa7: true, // LIST
        0xc6: true, // RENUM
        0xc7: true, // RESTORE
        0xc8: true, // RESUME
        0xca: true, // RUN
        0xeb: true, // THEN
    };

    /**
     * Copies an untokenised zone (comment or data) and returns the position where
     * it ends. `arret` is the closing character; "eol" means end of line. A stop
     * character inside a quoted string is inert: `DATA "a:b"` keeps its colon.
     *
     * @param {string}   texte  Source line.
     * @param {number}   i      Start position.
     * @param {string}   arret  Stop character, or "eol".
     * @param {number[]} sortie Bytes already produced, to complete.
     * @returns {number} Position after the zone.
     */
    function copierBrut(texte, i, arret, sortie) {
        const n = texte.length;
        while (i < n && texte[i] !== arret) {
            const c = texte[i];
            sortie.push(c.charCodeAt(0) & 0xff);
            i++;
            if (c === '"') {
                while (i < n && texte[i] !== '"') { sortie.push(texte.charCodeAt(i) & 0xff); i++; }
                if (i < n) { sortie.push(0x22); i++; }
            }
        }
        return i;
    }

    /**
     * Tokenises the body of a line (without its number).
     * @param {string} texte Line body.
     * @returns {number[]} Tokenised bytes.
     */
    function tokeniserCorps(texte) {
        const sortie = [];
        const minuscule = texte.toLowerCase();
        const n = texte.length;
        let i = 0;
        // `true` while the last keyword emitted expects a line number.
        let attendNumero = false;

        while (i < n) {
            const ch = texte[i];
            const code = texte.charCodeAt(i);
            // A keyword keeps its meaning for the next token: a space does not
            // break the context.
            const attendait = attendNumero;
            if (code !== 0x20) attendNumero = false;

            // Literal string: quotes are part of the stream, the content is copied
            // verbatim (no keyword is recognised inside).
            if (ch === '"') {
                sortie.push(0x22);
                i++;
                while (i < n && texte[i] !== '"') { sortie.push(texte.charCodeAt(i) & 0xff); i++; }
                if (i < n) { sortie.push(0x22); i++; }
                continue;
            }

            // Apostrophe comment: same role as REM, preceded by a statement
            // separator like ELSE.
            if (ch === "'") {
                sortie.push(0x01, 0xc0);
                i++;
                while (i < n) { sortie.push(texte.charCodeAt(i) & 0xff); i++; }
                break;
            }

            // RSX: `|`, a zero offset byte, then the name (last character with
            // bit 7 set).
            if (ch === "|") {
                sortie.push(0x7c, 0x00);
                i++;
                const debut = i;
                while (i < n && estAlphanum(texte.charCodeAt(i))) i++;
                const nom = texte.slice(debut, i).toUpperCase();
                for (let k = 0; k < nom.length; k++) {
                    const c = nom.charCodeAt(k) & 0x7f;
                    sortie.push(k === nom.length - 1 ? (c | 0x80) : c);
                }
                if (nom.length === 0) sortie.push(0x80);
                continue;
            }

            // Number (decimal, or binary / hexadecimal prefixed by `&`).
            if ((code >= 0x30 && code <= 0x39) || ch === "&") {
                if (attendait && code >= 0x30 && code <= 0x39) {
                    let fin = i;
                    while (fin < n && texte.charCodeAt(fin) >= 0x30 && texte.charCodeAt(fin) <= 0x39) fin++;
                    const numero = parseInt(texte.slice(i, fin), 10);
                    if (numero >= 1 && numero <= 65535) {
                        sortie.push(0x1e, numero & 0xff, (numero >>> 8) & 0xff);
                        i = fin;
                        continue;
                    }
                }
                const nombre = lireNombre(texte, i);
                for (let k = 0; k < nombre.octets.length; k++) sortie.push(nombre.octets[k]);
                i = nombre.suivant;
                continue;
            }

            // Word: a keyword takes priority, otherwise a variable name. The name
            // of an array or function (followed by `(`) is tokenised by the rest
            // of the loop, producing ( arguments ).
            if (estLettre(code)) {
                const trouve = chercherMot(minuscule, i);
                if (trouve) {
                    const entree = trouve.entree;
                    if (entree.separateur) sortie.push(0x01);
                    for (let k = 0; k < entree.octets.length; k++) sortie.push(entree.octets[k]);
                    i += trouve.longueur;
                    attendNumero = ATTEND_UN_NUMERO[entree.octets[entree.octets.length - 1]] === true;
                    if (entree.brut) {
                        i = copierBrut(texte, i, entree.brut, sortie);
                    }
                    continue;
                }
                const variable = lireVariable(texte, i);
                for (let k = 0; k < variable.octets.length; k++) sortie.push(variable.octets[k]);
                i = variable.suivant;
                continue;
            }

            // Comparisons, including the inverted forms BASIC accepts.
            if (ch === ">" || ch === "<" || ch === "=") {
                const deux = texte.substr(i, 2);
                if (deux === ">=" || deux === "=>") { sortie.push(0xf0); i += 2; continue; }
                if (deux === "<=" || deux === "=<") { sortie.push(0xf3); i += 2; continue; }
                if (deux === "<>") { sortie.push(0xf2); i += 2; continue; }
                sortie.push(ch === ">" ? 0xee : (ch === "<" ? 0xf1 : 0xef));
                i++;
                continue;
            }

            if (Object.prototype.hasOwnProperty.call(OPERATEURS, ch)) {
                sortie.push(OPERATEURS[ch]);
                i++;
                continue;
            }

            // Spaces, `;`, `#`, parentheses…: already their own ASCII code.
            sortie.push(code & 0xff);
            i++;
        }

        return sortie;
    }

    // ---------------------------------------------------------------------------
    // API
    // ---------------------------------------------------------------------------

    /**
     * Tokenises a complete BASIC listing. Every line must start with its number;
     * the space after the number is not kept (BASIC behaviour: "10 PRINT" gives
     * PRINT as the first token).
     *
     * @param {string} source ASCII listing, lines separated by LF or CRLF.
     * @returns {{octets: Uint8Array, lignes: number, erreurs: Array<{ligne: number, message: string}>}}
     */
    function tokeniser(source) {
        const erreurs = [];
        const lignes = [];
        const brut = String(source == null ? "" : source).replace(/\r\n?/g, "\n").split("\n");

        for (let index = 0; index < brut.length; index++) {
            const texte = brut[index];
            if (texte.trim() === "") continue;

            const trouve = /^\s*(\d+)\s?(.*)$/.exec(texte);
            if (!trouve) {
                erreurs.push({
                    ligne: index + 1,
                    message: "Numéro de ligne manquant",
                });
                continue;
            }

            const numero = parseInt(trouve[1], 10);
            if (numero < 1 || numero > 65535) {
                erreurs.push({
                    ligne: index + 1,
                    message: "Numéro de ligne hors bornes (1-65535)",
                });
                continue;
            }

            const corps = tokeniserCorps(trouve[2]);
            const taille = corps.length + 5;
            const octets = [
                taille & 0xff, (taille >>> 8) & 0xff,
                numero & 0xff, (numero >>> 8) & 0xff,
            ].concat(corps);
            octets.push(0x00);
            lignes.push(octets);
        }

        const total = [];
        for (let l = 0; l < lignes.length; l++) {
            for (let o = 0; o < lignes[l].length; o++) total.push(lignes[l][o]);
        }
        total.push(0x00, 0x00); // end of program: zero line length

        return { octets: Uint8Array.from(total), lignes: lignes.length, erreurs: erreurs };
    }

    /**
     * Addresses of the four BASIC pointers for a given machine type.
     * @param {number} machineType Emulator `Machine_Type`.
     * @returns {number[]} Four addresses.
     */
    function pointeursPour(machineType) {
        // 0 = 464, 5 = 464+ (BASIC 1.0); 1 = 664, 2 = 6128, 4 = 6128+ (BASIC 1.1).
        return (machineType === 0 || machineType === 5)
            ? [0xae83, 0xae85, 0xae87, 0xae89]
            : [0xae66, 0xae68, 0xae6a, 0xae6c];
    }

    /**
     * Writes a tokenised BASIC program to memory and updates the pointers.
     * The program fully replaces the one in memory (and its variables); warning
     * the user is the caller's responsibility.
     *
     * @param {string}   source      ASCII listing.
     * @param {number}   machineType Emulator `Machine_Type`.
     * @param {Function} ecrire      `(adresse, valeur) => void`, 8-bit write.
     * @returns {{ok: boolean, erreurs: Array, lignes: number, octets: number, adresseFin: number}}
     */
    function injecter(source, machineType, ecrire) {
        const resultat = tokeniser(source);
        if (resultat.erreurs.length > 0) {
            return {
                ok: false, erreurs: resultat.erreurs, lignes: 0, octets: 0, adresseFin: 0,
            };
        }

        const basic10 = machineType === 0 || machineType === 5;
        const limite = basic10 ? LIMITE_BASIC_1_0 : LIMITE_BASIC_1_1;
        const adresseFin = ADRESSE_PROGRAMME + resultat.octets.length;

        if (adresseFin > limite) {
            return {
                ok: false,
                erreurs: [{
                    ligne: 0,
                    message: "Programme trop volumineux (" + resultat.octets.length
                        + " octets, maximum " + (limite - ADRESSE_PROGRAMME) + ")",
                }],
                lignes: resultat.lignes, octets: resultat.octets.length, adresseFin: 0,
            };
        }

        if (typeof ecrire !== "function") {
            return {
                ok: false,
                erreurs: [{ ligne: 0, message: "Aucune fonction d'écriture mémoire" }],
                lignes: 0, octets: 0, adresseFin: 0,
            };
        }

        for (let k = 0; k < resultat.octets.length; k++) {
            ecrire(ADRESSE_PROGRAMME + k, resultat.octets[k]);
        }

        // BASIC does not stop at the end marker: the four pointers must match the
        // end of the program, otherwise RUN starts on the remains of the previous
        // one.
        const pointeurs = pointeursPour(machineType);
        for (let p = 0; p < pointeurs.length; p++) {
            ecrire(pointeurs[p], adresseFin & 0xff);
            ecrire(pointeurs[p] + 1, (adresseFin >>> 8) & 0xff);
        }

        return {
            ok: true,
            erreurs: [],
            lignes: resultat.lignes,
            octets: resultat.octets.length,
            adresseFin: adresseFin,
        };
    }

    return {
        ADRESSE_PROGRAMME: ADRESSE_PROGRAMME,
        tokeniser: tokeniser,
        pointeursPour: pointeursPour,
        injecter: injecter,
    };
})();
