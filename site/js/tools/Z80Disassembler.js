/**
 * @module Z80Disassembler
 * @description Désassembleur Z80 pour le panneau de débogage de cpc-blank.html.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI UN MODULE DÉDIÉ
 * ─────────────────────────────────────────────────────────────────────────────
 * Le noyau `Z80.js` n'a aucune notion de mnémonique : c'est un exécuteur
 * d'opcodes (`opcodes[0x3A]()`). Rien ne dit « LD A,(00FF) » à l'écran.
 *
 * Décoder depuis les tables d'exécution serait possible mais fragile : elles
 * sont construites pour être rapides, et un handler absent ne dit pas de
 * combien d'octets l'instruction occupe. Une table de décodage séparée
 * décrit donc le jeu d'instructions indépendamment de l'implémentation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRAT
 * ─────────────────────────────────────────────────────────────────────────────
 * L'appelant fournit une fonction de lecture mémoire. Le désassembleur ne
 * connaît ni le bus ni l'état de la machine : il ne fait que traduire des
 * octets. C'est ce qui le rend testable sans harness, et réutilisable sur une
 * image mémoire arbitraire.
 *
 * Un octet non décodé est rendu comme `DB xx` et consomme un seul octet : le
 * flux reste aligné sur la suite, quelle que soit la donnée rencontrée.
 *
 * @example
 * const lignes = Z80Disassembler.desassembler((a) => ROM_Manager.readMemory(a), 0x0150, 8);
 * lignes[0]; // { adresse: 336, octets: '3E 05', texte: 'LD A,05' }
 */

'use strict';

/* ── Registres 8 bits, dans l'ordre utilisé par les opcodes `r` ─────────── */
const REG8 = ['B', 'C', 'D', 'E', 'H', 'L', '(HL)', 'A'];

/** Paires 16 bits de la forme `LD rr,nn` / `ADD HL,rr`. */
const REG16 = ['BC', 'DE', 'HL', 'SP'];

/** Conditions du suffixe `cc`. */
const COND = ['NZ', 'Z', 'NC', 'C', 'PO', 'PE', 'P', 'M'];

/* ── Rotations et manipulations de bits du préfixe CB ──────────────────── */
const CB_ROT = ['RLC', 'RRC', 'RL', 'RR', 'SLA', 'SRA', 'SLL', 'SRL'];

/**
 * Enregistre une instruction dans une table.
 * @param {Array} table    Table à remplir (256 entrées).
 * @param {number} opcode  Code de l'opcode.
 * @param {string} texte   Mnémonique tel qu'affiché.
 * @param {number} longueur Nombre d'octets occupés par l'instruction.
 * @returns {void}
 */
function def(table, opcode, texte, longueur) {
    table[opcode] = { t: texte, l: longueur };
}

/* ═══════════════════════════════════════════════════════════════════════════
   TABLE PRINCIPALE — 256 entrées
   ═══════════════════════════════════════════════════════════════════════════ */

/** @type {Array<{t: string, l: number}>} Table de décodage principale. */
const OPC = new Array(256).fill(null);

/* ── 0x00-0x3F : bloc constant, aucune règle ne suffit ─────────────────── */
const BASE = [
    'NOP',            'LD BC,nn',      'LD (BC),A',      'INC BC',
    'INC B',          'DEC B',         'LD B,n',         'RLCA',
    "EX AF,AF'",      'ADD HL,BC',     'LD A,(BC)',      'DEC BC',
    'INC C',          'DEC C',         'LD C,n',         'RRCA',
    'DJNZ e',         'LD DE,nn',      'LD (DE),A',      'INC DE',
    'INC D',          'DEC D',         'LD D,n',         'RLA',
    'JR e',           'ADD HL,DE',     'LD A,(DE)',      'DEC DE',
    'INC E',          'DEC E',         'LD E,n',         'RRA',
    'JR NZ,e',        'LD HL,nn',      'LD (nn),A',      'INC HL',
    'INC H',          'DEC H',         'LD H,n',         'DAA',
    'JR Z,e',         'ADD HL,HL',     'LD A,(nn)',      'DEC HL',
    'INC L',          'DEC L',         'LD L,n',         'CPL',
    'JR NC,e',        'LD SP,nn',      'LD (nn),SP',     'INC SP',
    'INC (HL)',       'DEC (HL)',      'LD (HL),n',      'SCF',
    'JR C,e',         'ADD HL,SP',     'LD A,(nn)',      'DEC SP',
    'INC A',          'DEC A',         'LD A,n',         'CCF',
];
/**
 * Déduit la longueur d'une instruction de son texte.
 *
 * La longueur ne peut pas être dérivée de l'affichage seul : `LD B,n` et
 * `LD A,(BC)` font tous deux un affichage de 6 caractères pour 2 et 1 octets.
 * On se fie donc au pseudo-opcode présent — `nn` vaut 2 octets d'opérande,
 * `n`, `(n)` et `e` en valent un.
 *
 * @param {string} t Mnémonique porteur éventuel de pseudo-opcodes.
 * @returns {number} Longueur totale de l'instruction.
 */
function longueur(t) {
    if (t.includes('nn')) return 3;
    if (t.includes('(n)')) return 2;
    if (/[ ,](?:n|e)$/.test(t)) return 2;
    return 1;
}

for (let op = 0x00; op < 0x40; op++) def(OPC, op, BASE[op], longueur(BASE[op]));

/* ── 0x40-0x7F : LD r,r' ───────────────────────────────────────────────── */
for (let d = 0; d < 8; d++) {
    for (let s = 0; s < 8; s++) {
        def(OPC, 0x40 + d * 8 + s, `LD ${REG8[d]},${REG8[s]}`, 1);
    }
}

/* 0x76 = HALT : la seule exception de la plage `LD r,r'`, où le champ
   source 6 vaut (HL) mais où l'instruction ne fait rien d'autre. */
def(OPC, 0x76, 'HALT', 1);

/* ── 0x80-0xBF : arithmétiques et logiques sur A ──────────────────────── */
const ALU = ['ADD A,', 'ADC A,', 'SUB ', 'SBC A,', 'AND ', 'XOR ', 'OR ', 'CP '];
for (let i = 0; i < 8; i++) {
    for (let r = 0; r < 8; r++) def(OPC, 0x80 + i * 8 + r, ALU[i] + REG8[r], 1);
}

/* ── 0xC0-0xFF : organised en 8 blocs de 8 (colonne = poids de l'octet) ──
   Aucune écriture ne se chevauche : chaque colonne a sa propre liste.     */
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

/* ═══════════════════════════════════════════════════════════════════════════
   PRÉFIXE CB — 256 entrées, 2 octets (dont le préfixe)
   ═══════════════════════════════════════════════════════════════════════════ */

/** @type {Array<{t: string, l: number}>} Table du préfixe CB. */
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

/* ═══════════════════════════════════════════════════════════════════════════
   PRÉFIXE ED — instructions étendues
   ═══════════════════════════════════════════════════════════════════════════ */

/** @type {Array<{t: string, l: number}>} Table du préfixe ED. */
const OPC_ED = new Array(256).fill(null);

/* IN r,(C) et OUT (C),r : le motif se répète sur les 8 blocs de 0x40-0x7F.
 *
 * Les deux familles se chevauchent volontairement sur le matériel : 0x41 est
 * à la fois `IN C,(C)` et `OUT (C),0`, et le Z80 le décode comme la seconde.
 * On écrit donc IN d'abord, puis OUT par-dessus, pour que la table affiche ce
 * que la machine exécute réellement. */
for (let g = 0; g < 4; g++) {
    const base = 0x40 + g * 0x10;
    for (let r = 0; r < 8; r++) {
        def(OPC_ED, base + r, `IN ${REG8[r]}`, 2);
        def(OPC_ED, base + 8 + r, `OUT (C),${REG8[r]}`, 2);
    }
}
/* ADC/SBC HL,rr et LD (nn),rr / LD rr,(nn).
 *
 * Ces quatre familles partagent la colonne 2 de la plage 0x40-0x7F, mais sur
 * des blocs *alternés* : SBC occupe les blocs 0,2,4,6 et ADC les blocs
 * 1,3,5,7. D'où le pas de 16, et non de 8 — avec un pas de 8, `ADC HL,BC`
 * et `SBC HL,DE` se disputeraient 0x4A et la table afficherait n'importe quoi. */
for (let g = 0; g < 4; g++) {
    def(OPC_ED, 0x42 + g * 0x10, `SBC HL,${REG16[g]}`, 2);
    def(OPC_ED, 0x4A + g * 0x10, `ADC HL,${REG16[g]}`, 2);
    def(OPC_ED, 0x43 + g * 0x10, `LD (nn),${REG16[g]}`, 4);
    def(OPC_ED, 0x4B + g * 0x10, `LD ${REG16[g]},(nn)`, 4);
}
/* Instructions ED à emplacement fixe. */
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
/* IM : 0x46/0x4E → IM 0, 0x56 → IM 1, 0x5E → IM 2. */
def(OPC_ED, 0x46, 'IM 0', 2);
def(OPC_ED, 0x4E, 'IM 0', 2);
def(OPC_ED, 0x56, 'IM 1', 2);
def(OPC_ED, 0x5E, 'IM 2', 2);

/* ═══════════════════════════════════════════════════════════════════════════
   DÉCODAGE
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Désassembleur Z80.
 * @namespace Z80Disassembler
 */
const Z80Disassembler = (() => {

    const hex2 = (v) => (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
    const hex4 = (v) => (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');

    /** Interprète un octet de déplacement comme une valeur signée. */
    const signe = (v) => (v & 0x80) ? v - 256 : v;

    /**
     * Cible d'un saut relatif : l'octet suit l'instruction, qui occupe 2 octets.
     * @param {number} base  Adresse de l'instruction.
     * @param {number} octet Octet de déplacement.
     * @returns {string} Cible au format hexadécimal.
     */
    const cibleJR = (base, octet) => hex4(base + 2 + signe(octet));

    /**
     * Remplace les pseudo-opcodes `n`, `nn` et `e` par les valeurs réelles.
     * @param {string} t      Mnémonique porteur de pseudo-opcodes.
     * @param {number[]} b    Octets de l'instruction, index 0 = opcode.
     * @param {number} i      Index du premier octet d'opérande dans `b`.
     * @param {number} base   Adresse de l'instruction.
     * @returns {string} Mnémonique résolu.
     */
    function resoudre(t, b, i, base) {
        if (t.includes('nn')) return t.replace('nn', hex4(b[i] | (b[i + 1] << 8)));
        // `OUT (n),A` et `IN A,(n)` : l'opérande n'est pas en fin de chaîne.
        if (t.includes('(n)')) return t.replace('(n)', `(${hex2(b[i])})`);
        if (t.endsWith(',e')) return `${t.slice(0, -2)},${cibleJR(base, b[i])}`;
        if (t.endsWith(' e')) return `${t.slice(0, -1)}${cibleJR(base, b[i])}`;
        // `LD B,n` comme `CP n` : l'opérande est le dernier mot.
        return t.replace(/([ ,])n$/, `$1${hex2(b[i])}`);
    }

    /**
     * Décode l'instruction de base en `b`, en ignorant tout préfixe.
     * @param {number[]} b  Octets, `b[0]` étant l'opcode.
     * @param {number} base Adresse de l'opcode.
     * @returns {{t: string, l: number}} Texte et longueur occupée.
     */
    function decoderSimple(b, base) {
        const e = OPC[b[0]];
        if (!e) return { t: `DB ${hex2(b[0])}`, l: 1 };
        return { t: resoudre(e.t, b, 1, base), l: e.l };
    }

    /**
     * Décode une instruction unique à partir de ses octets.
     *
     * Les préfixes DD/FD sont traités à part car ils *modifient* l'instruction
     * suivante : `(HL)` devient `(IX+d)`, `H` devient `IXH`, `HL` devient `IX`.
     * Quand l'opcode following n'utilise aucun de ces registres, le préfixe est
     * simplement ignoré — c'est le comportement réel du Z80.
     *
     * @param {number[]} b  Octets de l'instruction, `b[0]` étant l'opcode.
     * @param {number} base Adresse de l'instruction.
     * @returns {{t: string, l: number}} Texte et longueur occupée.
     */
    function decoder(b, base) {
        const op = b[0];

        /* ── Préfixe CB : CB op ─────────────────────────────────────────── */
        if (op === 0xCB) {
            const e = OPC_CB[b[1]];
            if (!e) return { t: `DB CB ${hex2(b[1])}`, l: 2 };
            return { t: e.t, l: e.l };
        }

        /* ── Préfixe ED : ED op ─────────────────────────────────────────── */
        if (op === 0xED) {
            const e = OPC_ED[b[1]];
            if (!e) return { t: `DB ED ${hex2(b[1])}`, l: 2 };
            return { t: resoudre(e.t, b, 2, base), l: e.l };
        }

        /* ── Préfixes DD / FD : IX et IY ────────────────────────────────── */
        if (op === 0xDD || op === 0xFD) {
            const idx = op === 0xDD ? 'IX' : 'IY';
            const suite = b[1];

            // DD CB d op — la seule forme où le déplacement est explicite.
            if (suite === 0xCB) {
                const e = OPC_CB[b[3]];
                const d = signe(b[2]);
                const cible = `(${idx}${d < 0 ? '-' : '+'}${hex2(Math.abs(d))})`;
                if (!e) return { t: `DB ${hex2(op)} CB ${hex2(b[3])}`, l: 4 };
                return { t: e.t.replace(/\(HL\)$/, cible), l: 4 };
            }

            const e = OPC[suite];
            if (!e) return { t: `DB ${hex2(op)}`, l: 1 };

            // (HL) → (IX+d) : un octet de déplacement s'intercale, et les
            // éventuels opérandes following glissent d'un cran.
            if (e.t.includes('(HL)')) {
                const d = signe(b[2]);
                const cible = `(${idx}${d < 0 ? '-' : '+'}${hex2(Math.abs(d))})`;
                return { t: resoudre(e.t.replace(/\(HL\)/g, cible), b, 3, base), l: e.l + 2 };
            }

            // HL → IX, puis H/L → IXH/IXL (l'ordre compte : sans cela `HL`
            // deviendrait `IXH` + `IXL`).
            if (e.t.includes('HL')) {
                return { t: resoudre(e.t.replace(/HL/g, idx), b, 2, base), l: e.l + 1 };
            }
            if (/\b[HL]\b/.test(e.t)) {
                const t = e.t.replace(/\bH\b/g, `${idx}H`).replace(/\bL\b/g, `${idx}L`);
                return { t: resoudre(t, b, 2, base), l: e.l + 1 };
            }

            // Préfixe sans effet : l'opcode s'exécute tel quel, sans octet de plus.
            //
            // Cas particulier du saut relatif : le Z80 calcule la cible depuis
            // l'adresse *suivante l'instruction complète*, préfixe compris. Un
            // `base + 1` systematically décalerait donc la cible d'un octet.
            if (e.t.endsWith(',e') || e.t.endsWith(' e')) {
                return { t: resoudre(e.t, b, 2, base), l: e.l };
            }
            return decoderSimple([suite].concat(b.slice(2)), base + 1);
        }

        return decoderSimple(b, base);
    }

    /**
     * Désassemble `nombre` instructions à partir de `adresse`.
     * @param {Function} lire  Fonction de lecture mémoire `(adresse) → octet`.
     * @param {number} adresse  Adresse de la première instruction.
     * @param {number} nombre   Nombre d'instructions à produire.
     * @returns {Array<{adresse: number, octets: string, texte: string}>} Les lignes.
     */
    function desassembler(lire, adresse, nombre = 8) {
        const lignes = [];
        let pc = adresse & 0xFFFF;

        for (let n = 0; n < nombre; n++) {
            // Fenêtre de 4 octets : l'instruction Z80 la plus longue.
            const b = [0, 1, 2, 3].map((k) => lire((pc + k) & 0xFFFF) & 0xFF);
            const { t, l } = decoder(b, pc);
            lignes.push({
                adresse: pc,
                octets: b.slice(0, l).map(hex2).join(' '),
                texte: t,
            });
            pc = (pc + Math.max(l, 1)) & 0xFFFF;
        }
        return lignes;
    }

    return { desassembler };
})();
