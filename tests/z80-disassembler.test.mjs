/**
 * @file tests/z80-disassembler.test.mjs
 * @description Tests du désassembleur Z80 (`site/js/tools/Z80Disassembler.js`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI UN HARNESS QUASI NUL
 * ─────────────────────────────────────────────────────────────────────────────
 * Le désassembleur ne connaît ni le bus ni le DOM : il reçoit une fonction de
 * lecture mémoire. Les tests se contentent donc de lui passer un tableau de 64
 * Ko — c'est ce qui rend le fichier testable sans le moindre simulateur.
 *
 * On vérifie deux choses distinctes, et c'est la seconde qui compte le plus :
 *  1. le texte affiché (« LD A,(1234) ») ;
 *  2. le nombre d'octets consommés, qui garantit que le désassemblage suivant
 *     reste aligné sur le flux réel. Un mnémonique correct mais long d'un octet
 *     produit un listings plausible et faux.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = resolve(HERE, '../site/js/tools/Z80Disassembler.js');

/** @type {object} Le module chargé. */
let Z80Disassembler;

/**
 * Charge le script classique via `vm`, en lui ajoutant une expression d'export.
 * Même stratégie que les autres harnais du dépôt.
 * @returns {object} L'objet `Z80Disassembler`.
 */
function charger() {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  runInThisContext(
    `${source}\n;globalThis.__DISASM__ = Z80Disassembler;`,
    { filename: SOURCE_PATH },
  );
  return globalThis.__DISASM__;
}

/**
 * Construit une image mémoire de 64 Ko à partir d'un fragment placé en 0x0000.
 * @param {number[]} octets Octets à l'adresse 0.
 * @param {number}   base   Adresse de départ du fragment.
 * @returns {Function} Fonction de lecture mémoire.
 */
function image(octets, base = 0x0000) {
  const mem = new Uint8Array(0x10000).fill(0x00);
  octets.forEach((b, i) => { mem[(base + i) & 0xFFFF] = b & 0xFF; });
  return (a) => mem[a & 0xFFFF];
}

/**
 * Désassemble un fragment et renvoie `[texte, longueur, adresseSuivante]`.
 * @param {number[]} octets Fragment à désassembler.
 * @param {number}   base   Adresse de départ.
 * @returns {Array} Résultat de la première ligne.
 */
function premiere(octets, base = 0x0000) {
  const lignes = Z80Disassembler.desassembler(image(octets, base), base, 1);
  const l = lignes[0];
  return [l.texte, l.octets.split(' ').length, (l.adresse + l.octets.split(' ').length) & 0xFFFF];
}

beforeAll(() => { Z80Disassembler = charger(); });

describe('Z80Disassembler — jeu de base', () => {
  it('charge le module et expose desassembler()', () => {
    expect(typeof Z80Disassembler.desassembler).toBe('function');
  });

  it('désassemble une instruction sur un octet', () => {
    expect(premiere([0x00])).toEqual(['NOP', 1, 0x0001]);
    expect(premiere([0x07])).toEqual(['RLCA', 1, 0x0001]);
    expect(premiere([0x76])).toEqual(['HALT', 1, 0x0001]);
    expect(premiere([0x3C])).toEqual(['INC A', 1, 0x0001]);
  });

  it('désassemble LD r,n sur deux octets', () => {
    expect(premiere([0x3E, 0x05])).toEqual(['LD A,05', 2, 0x0002]);
    expect(premiere([0x06, 0xFF])).toEqual(['LD B,FF', 2, 0x0002]);
  });

  it('désassemble LD A,(nn) sur trois octets, operand en little-endian', () => {
    expect(premiere([0x3A, 0x34, 0x12])).toEqual(['LD A,(1234)', 3, 0x0003]);
    expect(premiere([0x2A, 0x00, 0xC0])).toEqual(['LD A,(C000)', 3, 0x0003]);
  });

  it('désassemble les huit registres dans LD r,r\'', () => {
    expect(premiere([0x40])).toEqual(['LD B,B', 1, 0x0001]);
    expect(premiere([0x46])).toEqual(['LD B,(HL)', 1, 0x0001]);
    expect(premiere([0x7E])).toEqual(['LD A,(HL)', 1, 0x0001]);
    expect(premiere([0x77])).toEqual(['LD (HL),A', 1, 0x0001]);
  });

  it('désassemble les opérations logiques et arithmétiques', () => {
    expect(premiere([0x86])).toEqual(['ADD A,(HL)', 1, 0x0001]);
    expect(premiere([0x9E])).toEqual(['SBC A,(HL)', 1, 0x0001]);
    expect(premiere([0xFE, 0x09])).toEqual(['CP 09', 2, 0x0002]);
  });

  it('désassemble les sauts conditionnels avec le bon mot de condition', () => {
    expect(premiere([0xC0])).toEqual(['RET NZ', 1, 0x0001]);
    expect(premiere([0xC8])).toEqual(['RET Z', 1, 0x0001]);
    expect(premiere([0xF8])).toEqual(['RET M', 1, 0x0001]);
    expect(premiere([0xC2, 0x00, 0x20])).toEqual(['JP NZ,2000', 3, 0x0003]);
    expect(premiere([0xDC, 0x00, 0x20])).toEqual(['CALL C,2000', 3, 0x0003]);
    expect(premiere([0xC4, 0x00, 0x20])).toEqual(['CALL NZ,2000', 3, 0x0003]);
  });

  it('désassemble pile, échange et restart', () => {
    expect(premiere([0xC5])).toEqual(['PUSH BC', 1, 0x0001]);
    expect(premiere([0xF1])).toEqual(['POP AF', 1, 0x0001]);
    expect(premiere([0xEB])).toEqual(['EX DE,HL', 1, 0x0001]);
    expect(premiere([0xFF])).toEqual(['RST 38H', 1, 0x0001]);
    expect(premiere([0xC7])).toEqual(['RST 00H', 1, 0x0001]);
  });

  it('désassemble les ports d\'entrée / sortie', () => {
    expect(premiere([0xD3, 0xFE])).toEqual(['OUT (FE),A', 2, 0x0002]);
    expect(premiere([0xDB, 0xFE])).toEqual(['IN A,(FE)', 2, 0x0002]);
  });
});

describe('Z80Disassembler — sauts relatifs', () => {
  it('calcule la cible JR depuis la fin de l\'instruction', () => {
    // 0x18 0x05 à 0x0100 → cible 0x0100 + 2 + 5 = 0x0107
    expect(premiere([0x18, 0x05], 0x0100)).toEqual(['JR 0107', 2, 0x0102]);
  });

  it('interprète le déplacement comme signé', () => {
    // 0x18 0xFB à 0x2000 → 0x2000 + 2 - 5 = 0x1FFD
    expect(premiere([0x18, 0xFB], 0x2000)).toEqual(['JR 1FFD', 2, 0x2002]);
  });

  it('traite de même DJNZ et les JR conditionnels', () => {
    expect(premiere([0x10, 0xFE], 0x0000)).toEqual(['DJNZ 0000', 2, 0x0002]);
    expect(premiere([0x28, 0x02], 0x0000)).toEqual(['JR Z,0004', 2, 0x0002]);
    expect(premiere([0x30, 0x02], 0x0000)).toEqual(['JR NC,0004', 2, 0x0002]);
  });
});

describe('Z80Disassembler — préfixe CB', () => {
  it('désassemble une rotation sur deux octets', () => {
    expect(premiere([0xCB, 0x00])).toEqual(['RLC B', 2, 0x0002]);
    expect(premiere([0xCB, 0x3F])).toEqual(['SRL A', 2, 0x0002]);
    expect(premiere([0xCB, 0x30])).toEqual(['SLL B', 2, 0x0002]);
  });

  it('désassemble BIT / RES / SET', () => {
    expect(premiere([0xCB, 0x47])).toEqual(['BIT 0,A', 2, 0x0002]);
    expect(premiere([0xCB, 0x86])).toEqual(['RES 0,(HL)', 2, 0x0002]);
    expect(premiere([0xCB, 0xC6])).toEqual(['SET 0,(HL)', 2, 0x0002]);
  });
});

describe('Z80Disassembler — préfixe ED', () => {
  it('désassemble IN / OUT indexés par C', () => {
    // Les colonnes 0/1 de chaque bloc de 16 portent IN r,(C) et OUT (C),r ;
    // les colonnes 2/3 et 6/7 portent SBC/ADC et LD (nn),rr. Les places
    // officiellement documentées (0x47 LD I,A, 0x4F LD R,A) l'emportent.
    expect(premiere([0xED, 0x40])).toEqual(['IN B', 2, 0x0002]);
    expect(premiere([0xED, 0x41])).toEqual(['IN C', 2, 0x0002]);
    expect(premiere([0xED, 0x48])).toEqual(['OUT (C),B', 2, 0x0002]);
    expect(premiere([0xED, 0x7F])).toEqual(['OUT (C),A', 2, 0x0002]);
  });

  it('désassemble ADC/SBC HL et les échanges avec (nn)', () => {
    expect(premiere([0xED, 0x4A])).toEqual(['ADC HL,BC', 2, 0x0002]);
    expect(premiere([0xED, 0x72])).toEqual(['SBC HL,SP', 2, 0x0002]);
    // 4 octets : ED 43 nn nn
    expect(premiere([0xED, 0x43, 0x00, 0x40])).toEqual(['LD (4000),BC', 4, 0x0004]);
    expect(premiere([0xED, 0x6B, 0x00, 0x40])).toEqual(['LD HL,(4000)', 4, 0x0004]);
    // SBC et ADC occupent des blocs alternés de la plage ED 40-7F : 0x4A est
    // bien ADC HL,BC, et non SBC HL,DE.
    expect(premiere([0xED, 0x5A])).toEqual(['ADC HL,DE', 2, 0x0002]);
    expect(premiere([0xED, 0x6A])).toEqual(['ADC HL,HL', 2, 0x0002]);
  });

  it('désassemble les instructions de contrôle', () => {
    expect(premiere([0xED, 0x44])).toEqual(['NEG', 2, 0x0002]);
    expect(premiere([0xED, 0x47])).toEqual(['LD I,A', 2, 0x0002]);
    expect(premiere([0xED, 0x56])).toEqual(['IM 1', 2, 0x0002]);
    expect(premiere([0xED, 0xB0])).toEqual(['LDIR', 2, 0x0002]);
  });

  it('rend un ED inconnu en DB sans consommer plus de deux octets', () => {
    expect(premiere([0xED, 0x00])).toEqual(['DB ED 00', 2, 0x0002]);
  });
});

describe('Z80Disassembler — préfixes DD / FD', () => {
  it('remplace (HL) par (IX+d) et ajoute l\'octet de déplacement', () => {
    // DD 7E 05 = LD A,(IX+05) → 3 octets
    expect(premiere([0xDD, 0x7E, 0x05])).toEqual(['LD A,(IX+05)', 3, 0x0003]);
    // DD 34 05 = INC (IX+05)
    expect(premiere([0xDD, 0x34, 0x05])).toEqual(['INC (IX+05)', 3, 0x0003]);
  });

  it('sait composer (IX+d) avec un opérande immédiat', () => {
    // DD 36 05 42 = LD (IX+05),42 → 4 octets, l'immédiat est le 4e
    expect(premiere([0xDD, 0x36, 0x05, 0x42])).toEqual(['LD (IX+05),42', 4, 0x0004]);
  });

  it('affiche le déplacement en négatif', () => {
    expect(premiere([0xFD, 0x7E, 0xFB])).toEqual(['LD A,(IY-05)', 3, 0x0003]);
  });

  it('remplace HL par IX, et H/L par IXH/IXL', () => {
    expect(premiere([0xDD, 0x21, 0x00, 0x40])).toEqual(['LD IX,4000', 4, 0x0004]);
    expect(premiere([0xDD, 0x09])).toEqual(['ADD IX,BC', 2, 0x0002]);
    expect(premiere([0xDD, 0xE5])).toEqual(['PUSH IX', 2, 0x0002]);
    expect(premiere([0xDD, 0x24])).toEqual(['INC IXH', 2, 0x0002]);
  });

  it('traite DD CB d op comme une instruction de quatre octets', () => {
    // DD CB 05 06 = RLC (IX+05)
    expect(premiere([0xDD, 0xCB, 0x05, 0x06])).toEqual(['RLC (IX+05)', 4, 0x0004]);
  });

  it('ignore le préfixe quand l\'opcode n\'utilise ni H, ni L, ni HL', () => {
    // DD 3E 42 : le Z80 exécute LD A,42 ; le DD est sans effet, donc 2 octets.
    expect(premiere([0xDD, 0x3E, 0x42])).toEqual(['LD A,42', 2, 0x0002]);
  });
});

describe('Z80Disassembler — flux et robustesse', () => {
  it('énumère plusieurs instructions et reste aligné sur le flux', () => {
    const lignes = Z80Disassembler.desassembler(
      image([0x3E, 0x2A, 0x21, 0x16, 0x40, 0xCD, 0x00, 0x20, 0x76], 0x0150),
      0x0150,
      4,
    );
    expect(lignes.map((l) => l.texte)).toEqual([
      'LD A,2A', 'LD HL,4016', 'CALL 2000', 'HALT',
    ]);
    expect(lignes.map((l) => l.adresse)).toEqual([0x0150, 0x0152, 0x0155, 0x0158]);
    expect(lignes.map((l) => l.octets)).toEqual(['3E 2A', '21 16 40', 'CD 00 20', '76']);
  });

  it('rend un ED inconnu en DB sans casser l\'alignement du flux', () => {
    // 0xED 0x00 n'existe pas ; l'instruction suivante doit rester lisible.
    const lignes = Z80Disassembler.desassembler(
      image([0xED, 0x00, 0x3E, 0x42]), 0x0000, 2,
    );
    expect(lignes[0].texte).toBe('DB ED 00');
    expect(lignes[0].adresse).toBe(0x0000);
    expect(lignes[1].texte).toBe('LD A,42');
    expect(lignes[1].adresse).toBe(0x0002);
  });

  it('formate les octets en majuscules sur deux caractères', () => {
    const l = Z80Disassembler.desassembler(image([0x3E, 0x0A]), 0x0000, 1)[0];
    expect(l.octets).toBe('3E 0A');
  });

  it('produit le nombre de lignes demandé et boucle sur 64 Ko', () => {
    expect(Z80Disassembler.desassembler(image([0x00]), 0x0000, 5)).toHaveLength(5);
    // L'instruction à 0xFFFF déborde : l'adresse suivante doit reboucler.
    const l = Z80Disassembler.desassembler(image([0x3E, 0x42], 0xFFFF), 0xFFFF, 1)[0];
    expect(l.adresse).toBe(0xFFFF);
    expect(l.octets).toBe('3E 42');
  });
});
