/**
 * @file Z80Disassembler.js
 * @module Z80Disassembler
 *
 * Z80 disassembler for the debug panel of cpc-blank.html.
 *
 * The caller supplies a memory read function: the disassembler knows neither the
 * bus nor the machine state, it only translates bytes, which makes it reusable on
 * any memory image.
 *
 * An undecoded byte is rendered as `DB xx` and consumes one byte, so the stream
 * stays aligned with the following instructions.
 *
 * @example
 * const lignes = Z80Disassembler.desassembler((a) => ROM_Manager.readMemory(a), 0x0150, 8);
 * lignes[0]; // { adresse: 336, octets: '3E 05', texte: 'LD A,05' }
 */

'use strict';

/* 8-bit registers, in the order used by the `r` opcodes. */
const REG8 = ['B', 'C', 'D', 'E', 'H', 'L', '(HL)', 'A'];

/** 16-bit register pairs of `LD rr,nn` / `ADD HL,rr`. */
const REG16 = ['BC', 'DE', 'HL', 'SP'];

/** Conditions of the `cc` suffix. */
const COND = ['NZ', 'Z', 'NC', 'C', 'PO', 'PE', 'P', 'M'];

/* Rotations and bit operations of the CB prefix. */
const CB_ROT = ['RLC', 'RRC', 'RL', 'RR', 'SLA', 'SRA', 'SLL', 'SRL'];

/**
 * Registers one instruction in a table.
 * @param {Array} table    Table to fill (256 entries).
 * @param {number} opcode  Opcode value.
 * @param {string} texte   Mnemonic as displayed.
 * @param {number} longueur Number of bytes the instruction occupies.
 * @returns {void}
 */
function def(table, opcode, texte, longueur) {
    table[opcode] = { t: texte, l: longueur };
}

// MAIN TABLE — 256 entries

/** @type {Array<{t: string, l: number}>} Main decoding table. */
const OPC = new Array(256).fill(null);

/* 0x00-0x3F: constant block, no rule covers it. */
const BASE = [
    'NOP',            'LD BC,nn',      'LD (BC),A',      'INC BC',
    'INC B',          'DEC B',         'LD B,n',         'RLCA',
    "EX AF,AF'",      'ADD HL,BC',     'LD A,(BC)',      'DEC BC',
    'INC C',          'DEC C',         'LD C,n',         'RRCA',
    'DJNZ e',         'LD DE,nn',      'LD (DE),A',      'INC DE',
    'INC D',          'DEC D',         'LD D,n',         'RLA',
    'JR e',           'ADD HL,DE',     'LD A,(DE)',      'DEC DE',
    'INC E',          'DEC E',         'LD E,n',         'RRA',
    'JR NZ,e',        'LD HL,nn',      'LD (nn),HL',     'INC HL',
    'INC H',          'DEC H',         'LD H,n',         'DAA',
    'JR Z,e',         'ADD HL,HL',     'LD HL,(nn)',     'DEC HL',
    'INC L',          'DEC L',         'LD L,n',         'CPL',
    'JR NC,e',        'LD SP,nn',      'LD (nn),A',      'INC SP',
    'INC (HL)',       'DEC (HL)',      'LD (HL),n',      'SCF',
    'JR C,e',         'ADD HL,SP',     'LD A,(nn)',      'DEC SP',
    'INC A',          'DEC A',         'LD A,n',         'CCF',
];
/**
 * Infers the length of an instruction from its text. The pseudo-opcode decides:
 * `nn` is a two-byte operand, `n`, `(n)` and `e` are one byte.
 *
 * @param {string} t Mnemonic, possibly carrying pseudo-opcodes.
 * @returns {number} Total instruction length.
 */
function longueur(t) {
    if (t.includes('nn')) return 3;
    if (t.includes('(n)')) return 2;
    if (/[ ,](?:n|e)$/.test(t)) return 2;
    return 1;
}

for (let op = 0x00; op < 0x40; op++) def(OPC, op, BASE[op], longueur(BASE[op]));

/* 0x40-0x7F: LD r,r' */
for (let d = 0; d < 8; d++) {
    for (let s = 0; s < 8; s++) {
        def(OPC, 0x40 + d * 8 + s, `LD ${REG8[d]},${REG8[s]}`, 1);
    }
}

/* 0x76 = HALT: the only exception of the `LD r,r'` range. */
def(OPC, 0x76, 'HALT', 1);

/* 0x80-0xBF: arithmetic and logic operations on A. */
const ALU = ['ADD A,', 'ADC A,', 'SUB ', 'SBC A,', 'AND ', 'XOR ', 'OR ', 'CP '];
for (let i = 0; i < 8; i++) {
    for (let r = 0; r < 8; r++) def(OPC, 0x80 + i * 8 + r, ALU[i] + REG8[r], 1);
}

/* 0xC0-0xFF: eight blocks of eight, one column per low-order byte value.
   Each column has its own list, so no entry overlaps. */
const COL1 = ['POP BC', 'RET',      'POP DE', 'EXX',
              'POP HL', 'JP (HL)',  'POP AF', 'LD SP,HL'];
const COL3 = ['JP nn',  'CB',       'OUT (n),A', 'IN A,(n)',
              'EX (SP),HL', 'EX DE,HL', 'DI',  'EI'];
const COL5 = ['PUSH BC', 'CALL nn', 'PUSH DE', 'DD',
              'PUSH HL', 'ED',       'PUSH AF', 'FD'];
const COL6 = ['ADD A,n', 'ADC A,n', 'SUB n',   'SBC A,n',
              'AND n',   'XOR n',   'OR n',    'CP n'];
for (let k = 0; k < 8; k++) {
    const bloc = 0xC0 + k * 8;
    const t1 = COL1[k], t3 = COL3[k], t5 = COL5[k], t6 = COL6[k];
    def(OPC, bloc + 0, `RET ${COND[k]}`, 1);
    def(OPC, bloc + 1, t1, 1);
    def(OPC, bloc + 2, `JP ${COND[k]},nn`, 3);
    def(OPC, bloc + 3, t3, longueur(t3));
    def(OPC, bloc + 4, `CALL ${COND[k]},nn`, 3);
    def(OPC, bloc + 5, t5, longueur(t5));
    def(OPC, bloc + 6, t6, 2);
    def(OPC, bloc + 7, `RST ${(k * 8).toString(16).toUpperCase().padStart(2, '0')}H`, 1);
}

// CB PREFIX — 256 entries, 2 bytes each (prefix included)

/** @type {Array<{t: string, l: number}>} CB prefix table. */
const OPC_CB = new Array(256).fill(null);
for (let i = 0; i < 8; i++) {
    for (let r = 0; r < 8; r++) {
        def(OPC_CB, 0x00 + i * 8 + r, `${CB_ROT[i]} ${REG8[r]}`, 2);
    }
}
for (let b = 0; b < 8; b++) {
    for (let r = 0; r < 8; r++) {
        def(OPC_CB, 0x40 + b * 8 + r, `BIT ${b},${REG8[r]}`, 2);
        def(OPC_CB, 0x80 + b * 8 + r, `RES ${b},${REG8[r]}`, 2);
        def(OPC_CB, 0xC0 + b * 8 + r, `SET ${b},${REG8[r]}`, 2);
    }
}

// ED PREFIX — extended instructions

/** @type {Array<{t: string, l: number}>} ED prefix table. */
const OPC_ED = new Array(256).fill(null);

/* IN r,(C) and OUT (C),r: the register sits in bits 5:3 of the second byte, so
 * the step is 8 (IN B,(C)=0x40, IN C,(C)=0x48 … OUT (C),B=0x41 …).
 * Register 6 (column "F") has no register name: 0x70 is IN (C), 0x71 OUT (C),0.
 * The IM slots (0x46, 0x4E, 0x56, 0x5E, 0x66, 0x6E, 0x76, 0x7E) are left here
 * and defined below. */
for (let r = 0; r < 8; r++) {
    def(OPC_ED, 0x40 + r * 8, r === 6 ? 'IN (C)'    : `IN ${REG8[r]},(C)`,  2);
    def(OPC_ED, 0x41 + r * 8, r === 6 ? 'OUT (C),0' : `OUT (C),${REG8[r]}`, 2);
}
/* ADC/SBC HL,rr and LD (nn),rr / LD rr,(nn).
 * SBC occupies blocks 0,2,4,6 and ADC blocks 1,3,5,7, hence the step of 16. */
for (let g = 0; g < 4; g++) {
    def(OPC_ED, 0x42 + g * 0x10, `SBC HL,${REG16[g]}`, 2);
    def(OPC_ED, 0x4A + g * 0x10, `ADC HL,${REG16[g]}`, 2);
    def(OPC_ED, 0x43 + g * 0x10, `LD (nn),${REG16[g]}`, 4);
    def(OPC_ED, 0x4B + g * 0x10, `LD ${REG16[g]},(nn)`, 4);
}
/* ED instructions with a fixed slot. */
const ED_FIXE = {
    0x44: 'NEG',      0x45: 'RETN',     0x4C: 'RETN',     0x4D: 'RETI',
    0x4F: 'LD R,A',   0x47: 'LD I,A',   0x57: 'LD A,I',    0x5F: 'LD A,R',
    0x67: 'RRD',      0x6F: 'RLD',
    0xA0: 'LDI',      0xA1: 'CPI',      0xA2: 'INI',      0xA3: 'OUTI',
    0xA8: 'LDD',      0xA9: 'CPD',      0xAA: 'IND',      0xAB: 'OUTD',
    0xB0: 'LDIR',     0xB1: 'CPIR',     0xB2: 'INIR',     0xB3: 'OTIR',
    0xB8: 'LDDR',     0xB9: 'CPDR',     0xBA: 'INDR',     0xBB: 'OTDR',
};
for (const [op, t] of Object.entries(ED_FIXE)) def(OPC_ED, Number(op), t, 2);
/* IM: 0x46/0x4E → IM 0, 0x56 → IM 1, 0x5E → IM 2. */
def(OPC_ED, 0x46, 'IM 0', 2);
def(OPC_ED, 0x4E, 'IM 0', 2);
def(OPC_ED, 0x56, 'IM 1', 2);
def(OPC_ED, 0x5E, 'IM 2', 2);

// DECODING

/**
 * Z80 disassembler.
 * @namespace Z80Disassembler
 */
const Z80Disassembler = (() => {

    // Hex literal prefix: the panel shows bare numbers, the RASM export
    // prefixes them with `#` (RASM reads `C000` as a symbol and needs `#`, `$`,
    // `0x` or an `h` suffix).
    const hex2 = (v, p = '') => p + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
    const hex4 = (v, p = '') => p + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');

    /** Interprets a displacement byte as a signed value. */
    const signe = (v) => (v & 0x80) ? v - 256 : v;

    /**
     * Target of a relative jump; the displacement byte follows the opcode.
     *
     * `base` is the address of the OPCODE, not of the prefix: a prefixed relative
     * jump (DD 18 e) must count the prefix byte, so the caller passes `base + 1`.
     *
     * @param {number} base  Opcode address.
     * @param {number} octet Displacement byte.
     * @param {string} p     Hex prefix ('' for display, '#' for RASM).
     * @returns {string} Target in hexadecimal.
     */
    const cibleJR = (base, octet, p = '') => hex4(base + 2 + signe(octet), p);

    /**
     * Replaces the `n`, `nn` and `e` pseudo-opcodes with the real values.
     * @param {string} t      Mnemonic carrying pseudo-opcodes.
     * @param {number[]} b    Instruction bytes, index 0 = opcode.
     * @param {number} i      Index of the first operand byte in `b`.
     * @param {number} base   Opcode address (shifted when prefixed).
     * @param {string} p      Hex prefix.
     * @returns {string} Resolved mnemonic.
     */
    function resoudre(t, b, i, base, p = '') {
        if (t.includes('nn')) return t.replace('nn', hex4(b[i] | (b[i + 1] << 8), p));
        // `OUT (n),A` and `IN A,(n)`: the operand is not at the end of the string.
        if (t.includes('(n)')) return t.replace('(n)', `(${hex2(b[i], p)})`);
        if (t.endsWith(',e')) return `${t.slice(0, -2)},${cibleJR(base, b[i], p)}`;
        if (t.endsWith(' e')) return `${t.slice(0, -1)}${cibleJR(base, b[i], p)}`;
        // `LD B,n` as well as `CP n`: the operand is the last word.
        return t.replace(/([ ,])n$/, (tout, sep) => sep + hex2(b[i], p));
    }

    /**
     * Renders a raw data line: `DB ED 7F` for display, `db #ED,#7F` for RASM,
     * where parameters are comma-separated and hexadecimal is prefixed.
     *
     * @param {number[]} octets  Bytes concerned.
     * @param {number}   longueur Number of bytes consumed.
     * @param {boolean}  rasm     `true` for RASM syntax.
     * @returns {{t: string, l: number}}
     */
    function ligneDB(octets, longueur, rasm) {
        if (rasm) return { t: 'db ' + octets.map((v) => hex2(v, '#')).join(','), l: longueur };
        return { t: 'DB ' + octets.map((v) => hex2(v)).join(' '), l: longueur };
    }

    /**
     * Decodes the base instruction in `b`, ignoring any prefix.
     * @param {number[]} b  Bytes, `b[0]` being the opcode.
     * @param {number} base Opcode address.
     * @param {boolean} rasm RASM rendering instead of display.
     * @returns {{t: string, l: number}} Text and occupied length.
     */
    function decoderSimple(b, base, rasm) {
        const e = OPC[b[0]];
        if (!e) return ligneDB([b[0]], 1, rasm);
        return { t: resoudre(e.t, b, 1, base, rasm ? '#' : ''), l: e.l };
    }

    /**
     * Decodes a single instruction from its bytes.
     *
     * DD/FD prefixes modify the next instruction: `(HL)` becomes `(IX+d)`, `H`
     * becomes `IXH`, `HL` becomes `IX`. When the following opcode uses none of
     * those registers the prefix is skipped.
     *
     * @param {number[]} b  Instruction bytes, `b[0]` being the opcode.
     * @param {number} base Instruction address.
     * @returns {{t: string, l: number}} Text and occupied length.
     */
    function decoder(b, base, rasm) {
        const p  = rasm ? '#' : '';
        const op = b[0];

        /* CB prefix: CB op */
        if (op === 0xCB) {
            const e = OPC_CB[b[1]];
            if (!e) return ligneDB([0xCB, b[1]], 2, rasm);
            return { t: e.t, l: e.l };
        }

        /* ED prefix: ED op */
        if (op === 0xED) {
            const e = OPC_ED[b[1]];
            if (!e) return ligneDB([0xED, b[1]], 2, rasm);
            return { t: resoudre(e.t, b, 2, base, p), l: e.l };
        }

        /* DD / FD prefixes: IX and IY */
        if (op === 0xDD || op === 0xFD) {
            const idx = op === 0xDD ? 'IX' : 'IY';
            const suite = b[1];

            // DD CB d op — the only form with an explicit displacement.
            if (suite === 0xCB) {
                const e = OPC_CB[b[3]];
                const d = signe(b[2]);
                const cible = `(${idx}${d < 0 ? '-' : '+'}${hex2(Math.abs(d), p)})`;
                if (!e) return ligneDB([op, 0xCB, b[2], b[3]], 4, rasm);
                return { t: e.t.replace(/\(HL\)$/, cible), l: 4 };
            }

            const e = OPC[suite];
            if (!e) return ligneDB([op], 1, rasm);

            // JP (IX) / JP (IY): opcode 0xE9, 2 bytes, no displacement.
            if (suite === 0xE9) {
                return { t: `JP (${idx})`, l: 2 };
            }

            // (HL) → (IX+d): a displacement byte is inserted and the operands
            // shift by one byte.
            if (e.t.includes('(HL)')) {
                const d = signe(b[2]);
                const cible = `(${idx}${d < 0 ? '-' : '+'}${hex2(Math.abs(d), p)})`;
                return { t: resoudre(e.t.replace(/\(HL\)/g, cible), b, 3, base, p), l: e.l + 2 };
            }

            // HL → IX, then H/L → IXH/IXL (order matters here).
            if (e.t.includes('HL')) {
                return { t: resoudre(e.t.replace(/HL/g, idx), b, 2, base, p), l: e.l + 1 };
            }
            if (/\b[HL]\b/.test(e.t)) {
                const t = e.t.replace(/\bH\b/g, `${idx}H`).replace(/\bL\b/g, `${idx}L`);
                return { t: resoudre(t, b, 2, base, p), l: e.l + 1 };
            }

            // The opcode uses none of H, L, HL, but the prefix byte is still
            // consumed by the Z80: `DD 3E 42` occupies 3 bytes, hence the `+ 1`.
            if (e.t.endsWith(',e') || e.t.endsWith(' e')) {
                // A relative jump targets the address after the *complete*
                // instruction, prefix included: hence `base + 1`.
                return { t: resoudre(e.t, b, 2, base + 1, p), l: e.l + 1 };
            }
            const r = decoderSimple([suite].concat(b.slice(2)), base + 1, rasm);
            return { t: r.t, l: r.l + 1 };
        }

        return decoderSimple(b, base, rasm);
    }

    /**
     * Disassembles `nombre` instructions from `adresse`.
     *
     * Conditional branches are reported to the caller: a target that is already
     * disassembled is ignored, an unknown target is collected in
     * `adressesInconnues` for a later pass.
     *
     * @param {Function} lire  Memory read function `(adresse) → byte`.
     * @param {number} adresse  Address of the first instruction.
     * @param {number} nombre   Number of instructions to produce.
     * @param {Set<number>} [ciblesDejaDesassembles] Addresses already disassembled.
     * @param {Set<number>} [adressesInconnues] Unknown branch targets, collected.
     * @returns {Array<{adresse: number, octets: string, texte: string}>} The lines.
     */
    function desassembler(lire, adresse, nombre = 8,
                          ciblesDejaDesassembles = null,
                          adressesInconnues = null) {
        const lignes = [];
        let pc = adresse & 0xFFFF;

        for (let n = 0; n < nombre; n++) {
            // 4-byte window: the longest Z80 instruction.
            const b = [0, 1, 2, 3].map((k) => lire((pc + k) & 0xFFFF) & 0xFF);
            const { t, l } = decoder(b, pc, false);

            const ligne = {
                adresse: pc,
                octets: b.slice(0, l).map((v) => hex2(v)).join(' '),
                texte: t,
            };
            lignes.push(ligne);

            // Detect conditional branches.
            if (t.startsWith('JP ') || t.startsWith('CALL ') || t.startsWith('JR ') ||
                t.startsWith('DJNZ') || t.startsWith('RET ')) {
                const type = t.split(' ')[0];
                const cible = extraireCible(t, pc, l, b);

                if (cible !== null) {
                    // Known target: nothing to do, the flow continues as is.
                    if (ciblesDejaDesassembles && ciblesDejaDesassembles.has(cible)) {
                        // Intentionally empty.
                    }
                    // Unknown target: collect it for a later pass.
                    else if (adressesInconnues) {
                        adressesInconnues.add(cible);
                    }
                }
            }

            pc = (pc + Math.max(l, 1)) & 0xFFFF;
        }
        return lignes;
    }

    /**
     * Extracts the target address of a branch instruction.
     * @param {string} t Instruction text.
     * @param {number} pc Instruction address.
     * @param {number} l Instruction length.
     * @param {number[]} b Instruction bytes.
     * @returns {number|null} Target address, or `null` when it cannot be computed.
     */
    function extraireCible(t, pc, l, b) {
        const type = t.split(' ')[0];

        // JP nn / CALL nn: absolute address on 2 bytes.
        if (type === 'JP' || type === 'CALL') {
            const m = /#?([0-9A-Fa-f]{1,4})$/.exec(t);
            if (m) {
                const cibleHex = m[1];
                // Hexadecimal address to 16-bit value, e.g. '2000' -> 0x2000.
                return parseInt(cibleHex, 16) & 0xFFFF;
            }
            return null;
        }

        // JR e / DJNZ e: relative displacement.
        if (type === 'JR' || type === 'DJNZ') {
            if (l >= 2 && b[1] !== undefined) {
                const deplacement = b[1];
                const signe = (deplacement & 0x80) ? deplacement - 256 : deplacement;
                return (pc + l + signe) & 0xFFFF;
            }
        }

        // RET cc: no direct target, the return address is on the stack.
        if (type === 'RET') return null;

        return null;
    }

    /**
     * Disassembles a SINGLE instruction from `adresse`, with its text, its length
     * (needed to know where the next one starts) and its bytes.
     *
     * @param {Function} lire Memory read function `(adresse) → byte`.
     * @param {number}   adresse Instruction address.
     * @returns {{texte: string, longueur: number, octets: number[], rasm: string}}
     *          `texte` is for display, `rasm` for the assembler export.
     */
    function decoderUne(lire, adresse) {
        const pc = adresse & 0xFFFF;
        const b  = [0, 1, 2, 3].map((k) => lire((pc + k) & 0xFFFF) & 0xFF);
        const { t, l } = decoder(b, pc, false);
        const longueur = Math.max(l, 1);
        return {
            texte:    t,
            longueur: longueur,
            octets:   b.slice(0, longueur),
            rasm:     decoder(b, pc, true).t,
        };
    }

    return { desassembler, decoderUne, extraireCible };
})();
