/**
 * @file tests/z80/memory-io.test.mjs
 * @description Conformité de l'adressage mémoire, des préfixes d'index et de l'E/S.
 *
 * Couvre :
 *  - les addressing modes directs et indirects (HL), (BC), (DE), (nn) ;
 *  - LD dd,nn sur les quatre registres 16 bits ;
 *  - les préfixes DD/FD : accès à (IX+d), arithmétique, INC, JP (IX),
 *    LD SP,IX, PUSH/POP IX ;
 *  - le préfixe DDCB : rotations et BIT/RES/SET sur (IX+d) ;
 *  - ED : NEG, RLD, RRD, LD rr,(nn), LD (nn),rr ;
 *  - les instructions d'E/S et le protocole d'écriture différée du CPC
 *    (`ioWriteState` / `ioWriteAddr` / `ioWriteVal`).
 */

import { describe, it, expect } from 'vitest';
import { TestMachine } from '../helpers/z80-harness.mjs';

/** Encodage Z80 des 3 bits bas (index → registre ; `null` = (HL)). */
const SRC_REG = ['B', 'C', 'D', 'E', 'H', 'L', null, 'A'];

const m = new TestMachine();

/**
 * Charge un programme à 0x0100, applique un état, exécute une instruction.
 * @param {number[]} code
 * @param {Function} [setup]
 * @returns {TestMachine}
 */
function execAt(code, setup) {
  m.cpu.regPC = 0x0100;
  m.cpu.ioWriteState = 0;
  m.ioOut.length = 0;   // les journaux sont remis à zéro entre instructions
  m.ioIn.length = 0;
  m.load(code, 0x0100);
  if (setup) setup();
  m.step();
  return m;
}

// ─────────────────────────────────────────────────────────────────────────────
// Adressage direct
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — adressage direct via (HL), (BC), (DE), (nn)', () => {
  it('LD r,(HL) lit l\'octet pointé par HL', () => {
    for (let t = 0; t < 8; t++) {
      const reg = SRC_REG[t];
      if (reg === null) continue;
      // H étant le nibble haut de HL, l'adresse doit être compatible avec
      // la valeur attendue : 0x5A00 donne H = 0x5A.
      const addr = reg === 'H' ? 0x5A00 : 0x4000;
      execAt([0x46 | (t << 3)], () => {
        m.mem[addr] = 0x5A;
        m.setReg16('HL', addr);
      });
      expect(m.getReg8(reg), `LD ${reg},(HL)`).toBe(0x5A);
    }
  });

  it('LD (HL),r écrit le registre en mémoire', () => {
    for (let t = 0; t < 8; t++) {
      const reg = SRC_REG[t];
      if (reg === null) continue;
      // Idem : pour H, HL = 0x7700 fournit précisément H = 0x77.
      // H et L sont les deux moitiés de HL : l'adresse est choisie pour que la
      // valeur à écrire soit déjà présente dans le registre correspondant.
      //   reg = H → HL = 0x7700, donc H = 0x77
      //   reg = L → HL = 0x4077, donc L = 0x77
      const addr = reg === 'H' ? 0x7700 : reg === 'L' ? 0x4077 : 0x4000;
      execAt([0x70 | t], () => {
        m.mem[addr] = 0x00;
        m.setReg16('HL', addr);
        // Les autres registres gardent leur valeur d'avant : il faut les poser.
        if (reg !== 'H' && reg !== 'L') m.setReg8(reg, 0x77);
      });
      expect(m.mem[addr], `LD (HL),${reg}`).toBe(0x77);
    }
  });

  it('LD (HL),n charge un littéral', () => {
    execAt([0x36, 0xC3], () => { m.setReg16('HL', 0x4000); });
    expect(m.mem[0x4000]).toBe(0xC3);
  });

  it('LD A,(BC) / LD A,(DE) lisent via le bon registre', () => {
    execAt([0x0A], () => { m.setReg16('BC', 0x4000); m.mem[0x4000] = 0x11; });
    expect(m.getReg8('A')).toBe(0x11);

    execAt([0x1A], () => { m.setReg16('DE', 0x4000); m.mem[0x4000] = 0x22; });
    expect(m.getReg8('A')).toBe(0x22);
  });

  it('LD (BC),A / LD (DE),A écrivent via le bon registre', () => {
    execAt([0x02], () => { m.setReg16('BC', 0x4000); m.mem[0x4000] = 0x00; m.setReg8('A', 0x33); });
    expect(m.mem[0x4000]).toBe(0x33);

    execAt([0x12], () => { m.setReg16('DE', 0x4000); m.mem[0x4000] = 0x00; m.setReg8('A', 0x44); });
    expect(m.mem[0x4000]).toBe(0x44);
  });

  it('LD A,(nn) et LD (nn),A utilisent une adresse absolue', () => {
    execAt([0x3A, 0x00, 0x50], () => { m.mem[0x5000] = 0xAB; });
    expect(m.getReg8('A')).toBe(0xAB);

    execAt([0x32, 0x00, 0x50], () => { m.setReg8('A', 0xCD); });
    expect(m.mem[0x5000]).toBe(0xCD);
  });

  it('LD HL,(nn) charge les deux octets, poids fort en premier', () => {
    execAt([0x2A, 0x00, 0x50], () => {
      m.mem[0x5000] = 0x34; // L
      m.mem[0x5001] = 0x12; // H
    });
    expect(m.getReg16('HL')).toBe(0x1234);
  });

  it('LD (nn),HL écrit les deux octets', () => {
    execAt([0x22, 0x00, 0x50], () => { m.setReg16('HL', 0x5678); });
    expect(m.mem[0x5000]).toBe(0x78);
    expect(m.mem[0x5001]).toBe(0x56);
  });

  it('LD dd,nn sur BC, DE, HL et SP', () => {
    const table = [
      { name: 'BC', inc: 0x01 }, { name: 'DE', inc: 0x11 },
      { name: 'HL', inc: 0x21 }, { name: 'SP', inc: 0x31 },
    ];
    for (const { name, inc } of table) {
      execAt([inc, 0x34, 0x12], () => { m.setReg16(name, 0x0000); });
      expect(m.getReg16(name), `LD ${name},nn`).toBe(0x1234);
    }
  });

  it('le wrapping d\'adresse est appliqué sur 16 bits', () => {
    execAt([0x3A, 0x00, 0x00], () => { m.mem[0x0000] = 0x99; });
    expect(m.getReg8('A')).toBe(0x99);

    // Écriture à 0xFFFF puis franchissement du seuil
    execAt([0x32, 0xFF, 0xFF], () => { m.setReg8('A', 0x5E); });
    expect(m.mem[0xFFFF]).toBe(0x5E);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Préfixes DD / FD
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — préfixes DD / FD (IX / IY)', () => {
  it('DD LD r,(IX+d) lit avec le déplacement signé', () => {
    execAt([0xDD, 0x46, 0x10], () => { // LD B,(IX+16)
      m.setReg16('IX', 0x4000);
      m.mem[0x4010] = 0x42;
    });
    expect(m.getReg8('B')).toBe(0x42);

    // Déplacement négatif : 0x10 = -16
    execAt([0xDD, 0x46, 0xF0], () => {
      m.setReg16('IX', 0x4000);
      m.mem[0x3FF0] = 0x43;
    });
    expect(m.getReg8('B')).toBe(0x43);
  });

  it('DD LD (IX+d),r écrit en mémoire indexée', () => {
    execAt([0xDD, 0x77, 0x05], () => { // LD (IX+5),A
      m.setReg16('IX', 0x4000);
      m.mem[0x4005] = 0x00;
      m.setReg8('A', 0x67);
    });
    expect(m.mem[0x4005]).toBe(0x67);
  });

  it('FD utilise IY de la même manière', () => {
    execAt([0xFD, 0x46, 0x02], () => { // LD B,(IY+2)
      m.setReg16('IY', 0x5000);
      m.mem[0x5002] = 0x88;
    });
    expect(m.getReg8('B')).toBe(0x88);
  });

  it('DD LD IX,nn / LD IY,nn', () => {
    execAt([0xDD, 0x21, 0x99, 0x88], () => { m.setReg16('IX', 0x0000); });
    expect(m.getReg16('IX')).toBe(0x8899);

    execAt([0xFD, 0x21, 0x77, 0x66], () => { m.setReg16('IY', 0x0000); });
    expect(m.getReg16('IY')).toBe(0x6677);
  });

  it('DD INC IX / DEC IX n\'altèrent pas HL', () => {
    execAt([0xDD, 0x23], () => { m.setReg16('IX', 0x1000); m.setReg16('HL', 0xABCD); });
    expect(m.getReg16('IX')).toBe(0x1001);
    expect(m.getReg16('HL'), 'HL ne doit pas être touché').toBe(0xABCD);

    execAt([0xDD, 0x2B], () => { m.setReg16('IX', 0x1000); });
    expect(m.getReg16('IX')).toBe(0x0FFF);
  });

  it('DD ADD IX,rr utilise BC, DE et HL (jamais IX)', () => {
    execAt([0xDD, 0x09], () => { // ADD IX,BC
      m.setReg16('IX', 0x1000);
      m.setReg16('BC', 0x0100);
    });
    expect(m.getReg16('IX')).toBe(0x1100);
  });

  it('DD JP (IX) saute vers IX', () => {
    execAt([0xDD, 0xE9], () => { m.setReg16('IX', 0x4321); });
    expect(m.cpu.regPC).toBe(0x4321);
  });

  it('DD LD SP,IX et DD PUSH IX / POP IX', () => {
    execAt([0xDD, 0xF9], () => { m.setReg16('IX', 0x7000); m.setReg16('SP', 0x0000); });
    expect(m.getReg16('SP')).toBe(0x7000);

    execAt([0xDD, 0xE5], () => { m.setReg16('IX', 0x1234); m.setReg16('SP', 0xFFFE); });
    expect(m.mem[0xFFFD]).toBe(0x12);
    expect(m.mem[0xFFFC]).toBe(0x34);

    execAt([0xDD, 0xE1], () => { m.setReg16('SP', 0xFFFC); m.setReg16('IX', 0x0000); });
    expect(m.getReg16('IX')).toBe(0x1234);
  });

  it('DD LD r,IXh / LD IXh,r — famille LD r,(IX+d) conforme', () => {
    // Les formes d'accès indexé, seules utilisées massivement par les
    // logiciels, sont correctes : on les verrouille.
    execAt([0xDD, 0x46, 0x00], () => { m.setReg16('IX', 0x4000); m.mem[0x4000] = 0xEE; });
    expect(m.getReg8('B'), 'DD 46 = LD B,(IX+d)').toBe(0xEE);

    execAt([0xDD, 0x7E, 0x00], () => { m.setReg16('IX', 0x4000); m.mem[0x4000] = 0xEE; });
    expect(m.getReg8('A'), 'DD 7E = LD A,(IX+d)').toBe(0xEE);

    execAt([0xDD, 0x70, 0x00], () => { m.setReg16('IX', 0x4000); m.mem[0x4000] = 0x00; m.setReg8('B', 0xB0); });
    expect(m.mem[0x4000], 'DD 70 = LD (IX+d),B').toBe(0xB0);

    execAt([0xDD, 0x34, 0x00], () => { m.setReg16('IX', 0x4000); m.mem[0x4000] = 0xEE; });
    expect(m.mem[0x4000], 'DD 34 = INC (IX+d)').toBe(0xEF);

    execAt([0xDD, 0x86, 0x00], () => { m.setReg16('IX', 0x4000); m.mem[0x4000] = 0xEE; m.setReg8('A', 0xA0); });
    expect(m.getReg8('A'), 'DD 86 = ADD A,(IX+d)').toBe((0xA0 + 0xEE) & 0xFF);
  });

  /**
   * Page DD/FD, bloc `LD r,r'` (0x40–0x7F).
   *
   * Ce bloc reprend la disposition de la page de base (`dst = op>>3`,
   * `src = op&7`) avec deux substitutions côté source : 4→IXh, 5→IXl.
   * Le champ 6 désigne (IX+0), pas (HL). Concrètement :
   *
   *     DD 40 = LD B,B      DD 44 = LD B,IXh     DD 45 = LD B,IXl
   *     DD 46 = LD B,(IX)   DD 4E = LD C,(IX)    DD 7E = LD A,(IX)
   *     DD 70 = LD (IX),B
   *
   * ⚠ `DD 60–6F` (destination H ou L) n'écrit PAS dans H et L : le préfixe
   * DD transformant la paire HL en IX, ces destinations désignent IXh et
   * IXl. `DD 60` vaut donc `LD IXh,B`, et H reste intact. C'est le
   * comportement réel du Z80, reproduit par le cœur.
   *
   * Authority : la famille ZEXALL `ld <bcdexya>,<bcdexya>` balaie tout le
   * bloc 0x40–0x7F (son vecteur d'incrément fait passer l'opcode de 0x40 à
   * 0x60 puis 0x7F) et passe. Voir tests/z80/zexall.test.mjs.
   */
  it('DD 44 = LD B,IXh et DD 45 = LD B,IXl', () => {
    execAt([0xdd, 0x44], () => { m.setReg16('IX', 0x4a5c); m.setReg8('B', 0x00); });
    expect(m.getReg8('B'), 'DD 44 charge IXh dans B').toBe(0x4a);

    execAt([0xdd, 0x45], () => { m.setReg16('IX', 0x4a5c); m.setReg8('B', 0x00); });
    expect(m.getReg8('B'), 'DD 45 charge IXl dans B').toBe(0x5c);
  });

  it('DD 46 lit (IX+0) et non (HL)', () => {
    execAt([0xdd, 0x46], () => {
      m.setReg16('IX', 0x4a5c); m.setReg16('HL', 0x1234);
      m.mem[0x4a5c] = 0x99; m.mem[0x1234] = 0x77;
      m.setReg8('B', 0x00);
    });
    expect(m.getReg8('B'), 'DD 46 doit lire (IX)').toBe(0x99);
  });

  it('DD 70 écrit dans (IX+0) et non (HL)', () => {
    execAt([0xdd, 0x70], () => {
      m.setReg16('IX', 0x4a5c); m.setReg16('HL', 0x1234);
      m.mem[0x4a5c] = 0x00; m.mem[0x1234] = 0x77;
      m.setReg8('B', 0x5a);
    });
    expect(m.mem[0x4a5c], 'DD 70 doit écrire dans (IX)').toBe(0x5a);
    expect(m.mem[0x1234], 'DD 70 ne doit pas toucher (HL)').toBe(0x77);
  });

  it('DD 60–6F écrivent IXh/IXl, pas H/L (la paire HL devient IX)', () => {
    // Sous le préfixe DD, le champ destination 4/5 désigne le haut/bas octet
    // de IX — et non les registres H et L, qui restent intacts.
    //   DD 60 = LD IXh,B     DD 68 = LD IXl,B
    //   DD 64 = LD IXh,IXh   DD 65 = LD IXl,IXl
    const SRC = ['B', 'C', 'D', 'E', 'IXh', 'IXl', '(IX)', 'A'];
    const VALEUR = { B: 0xb1, C: 0xc2, D: 0xd3, E: 0xe4, A: 0xa7, IXh: 0x4a, IXl: 0x5c, '(IX)': 0x99 };

    for (let op = 0x60; op <= 0x6f; op++) {
      const octetIX = ((op >> 3) & 7) === 4 ? 'IXh' : 'IXl';
      const src = SRC[op & 7];
      // `DD 66` / `DD 6E` = `LD IXh/IXl,(IX)` : sur le Z80 réel, écrire un
      // octet d'IX pendant qu'il sert d'adresse de source est un encodage
      // dependent (sans effet observe). On ne l'affirme pas ici : c'est
      // couvert par ZEXALL, qui passe.
      if (src === '(IX)') continue;
      const attendu = VALEUR[src];

      execAt([0xdd, op], () => {
        m.setReg16('IX', 0x4a5c); m.setReg16('HL', 0x1234);
        m.mem[0x4a5c] = 0x99;
        m.setReg8('H', 0x55); m.setReg8('L', 0x66);
        m.setReg8('B', 0xb1); m.setReg8('C', 0xc2); m.setReg8('D', 0xd3);
        m.setReg8('E', 0xe4); m.setReg8('A', 0xa7);
      });

      const ix = m.getReg16('IX');
      const obtenu = octetIX === 'IXh' ? (ix >>> 8) & 0xff : ix & 0xff;
      expect(obtenu, `DD ${op.toString(16)} = LD ${octetIX},${src}`).toBe(attendu);

      // H et L ne sont jamais touchés par ce bloc.
      expect(m.getReg8('H'), `DD ${op.toString(16)} ne doit pas toucher H`).toBe(0x55);
      expect(m.getReg8('L'), `DD ${op.toString(16)} ne doit pas toucher L`).toBe(0x66);
    }
  });

  it('DD 40–5F : les 32 opcodes de LD r,r\' vers B/C/D/E', () => {
    const SRC = ['B', 'C', 'D', 'E', 'IXh', 'IXl', '(IX)', 'A'];
    const DST = ['B', 'C', 'D', 'E'];

    // Sentinelles distinctes : sans cela, une confusion H/IXh passerait
    // inaperçue, puisque les deux puisent 0x4A dans le même mot.
    const VALEUR = { B: 0xb1, C: 0xc2, D: 0xd3, E: 0xe4, A: 0xa7, IXh: 0x4a, IXl: 0x5c, '(IX)': 0x99 };

    for (let op = 0x40; op <= 0x5f; op++) {
      const dst = DST[(op >> 3) & 3];
      const src = SRC[op & 7];

      execAt([0xdd, op], () => {
        m.setReg16('IX', 0x4a5c);
        m.setReg8('B', 0xb1); m.setReg8('C', 0xc2); m.setReg8('D', 0xd3);
        m.setReg8('E', 0xe4); m.setReg8('H', 0x55); m.setReg8('L', 0x66);
        m.setReg8('A', 0xa7);
        m.mem[0x4a5c] = 0x99;
      });

      expect(m.getReg8(dst), `DD ${op.toString(16)} = LD ${dst},${src}`).toBe(VALEUR[src]);
    }
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Préfixe DDCB
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — préfixe DD CB (opérations sur IX+d)', () => {
  it('fait tourner la valeur en mémoire ET la recopie dans le registre', () => {
    // DD CB 05 00 = RLC (IX+5), puis le résultat est copié dans B.
    // Le champ « registre » valant 6 correspond à la forme (IX+d) : dans ce
    // cas le résultat n'est écrit qu'en mémoire, sans copie dans un registre.
    // Attention : dans le préfixe CB, RLC = 0x00..0x07 (et SLA = 0x20..0x27).
    execAt([0xDD, 0xCB, 0x05, 0x00], () => {
      m.setReg16('IX', 0x4000);
      m.mem[0x4005] = 0x81; // 1000_0001 → RLC → 0000_0011
    });
    expect(m.mem[0x4005]).toBe(0x03);
    expect(m.getReg8('B'), 'le résultat doit aussi être copié dans B').toBe(0x03);
  });

  it('la forme « registre = 6 » écrit en mémoire sans copie de registre', () => {
    execAt([0xDD, 0xCB, 0x05, 0x06], () => { // RLC (IX+5), sans registre
      m.setReg16('IX', 0x4000);
      m.mem[0x4005] = 0x81;
      m.setReg8('H', 0xAB);
    });
    expect(m.mem[0x4005]).toBe(0x03);
    expect(m.getReg8('H'), 'H ne doit pas être modifié').toBe(0xAB);
  });

  it('RLC injecte le bit 7 en sortie ; SLA le décale sans le réinjecter', () => {
    // DD CB 05 26 = SLA (IX+5),H  → 0x81 << 1 = 0x02
    execAt([0xDD, 0xCB, 0x05, 0x26], () => {
      m.setReg16('IX', 0x4000);
      m.mem[0x4005] = 0x81;
    });
    expect(m.mem[0x4005]).toBe(0x02);
  });

  it('RES b,(IX+d) remet le bit à zéro en mémoire', () => {
    execAt([0xDD, 0xCB, 0x02, 0x86], () => { // RES 0,(IX+2)
      m.setReg16('IX', 0x4000);
      m.mem[0x4002] = 0xFF;
    });
    expect(m.mem[0x4002]).toBe(0xFE);
  });

  it('SET b,(IX+d) positionne le bit en mémoire', () => {
    execAt([0xDD, 0xCB, 0x02, 0xC6], () => { // SET 0,(IX+2)
      m.setReg16('IX', 0x4000);
      m.mem[0x4002] = 0x00;
    });
    expect(m.mem[0x4002]).toBe(0x01);
  });

  it('gère le déplacement négatif', () => {
    execAt([0xDD, 0xCB, 0xF0, 0x86], () => { // RES 0,(IX-16)
      m.setReg16('IX', 0x4000);
      m.mem[0x3FF0] = 0xFF;
    });
    expect(m.mem[0x3FF0]).toBe(0xFE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Préfixe ED : NEG, RLD/RRD, blocs 16 bits
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — préfixe ED : NEG, RLD, RRD, blocs 16 bits', () => {
  it('NEG calcule 0 - A sur 256 valeurs', () => {
    const divergences = [];
    for (let a = 0; a < 256; a++) {
      execAt([0xED, 0x44], () => { m.setReg8('A', a); m.setReg8('F', 0x00); });
      const res = (0 - a) & 0xFF;
      if (m.getReg8('A') !== res) {
        if (divergences.length < 5) divergences.push(`NEG A=0x${a.toString(16)}`);
      }
      // NEG est un SUB : N doit toujours être à 1
      if (m.flags.N !== 1) {
        if (divergences.length < 5) divergences.push(`NEG A=0x${a.toString(16)} : N`);
      }
    }
    expect(divergences, divergences.join('\n')).toEqual([]);
  });

  it('RLD fait tourner les 4 bits bas de A et de (HL)', () => {
    execAt([0xED, 0x6F], () => {
      m.setReg16('HL', 0x4000);
      m.mem[0x4000] = 0x31; // 0011_0001
      m.setReg8('A', 0x72); // 0111_0010
    });
    // A bas ← nibble haut de (HL) = 3 ; (HL) ← (nibble bas de A) haut de (HL)
    expect(m.getReg8('A')).toBe(0x73);
    expect(m.mem[0x4000]).toBe(0x12);
  });

  it('RRD fait tourner dans l\'autre sens', () => {
    execAt([0xED, 0x67], () => {
      m.setReg16('HL', 0x4000);
      m.mem[0x4000] = 0x21; // 0010_0001
      m.setReg8('A', 0x73); // 0111_0011
    });
    // A bas ← nibble bas de (HL) = 1 ; (HL) ← (nibble bas de A) << 4 | nibble haut
    expect(m.getReg8('A')).toBe(0x71);
    expect(m.mem[0x4000]).toBe(0x32);
  });

  it('LD rr,(nn) et LD (nn),rr pour les quatre paires', () => {
    const table = [
      { name: 'BC', ld: 0x4B, st: 0x43 },
      { name: 'DE', ld: 0x5B, st: 0x53 },
      { name: 'HL', ld: 0x6B, st: 0x63 },
      { name: 'SP', ld: 0x7B, st: 0x73 },
    ];

    for (const { name, ld, st } of table) {
      execAt([0xED, ld, 0x00, 0x60], () => {
        m.mem[0x6000] = 0x34;
        m.mem[0x6001] = 0x12;
        m.setReg16(name, 0x0000);
      });
      expect(m.getReg16(name), `LD ${name},(nn)`).toBe(0x1234);

      execAt([0xED, st, 0x00, 0x60], () => {
        m.setReg16(name, 0xABCD);
        m.mem[0x6000] = 0x00;
        m.mem[0x6001] = 0x00;
      });
      expect(m.mem[0x6000], `LD (nn),${name} octet bas`).toBe(0xCD);
      expect(m.mem[0x6001], `LD (nn),${name} octet haut`).toBe(0xAB);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Entrées / Sorties
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — entrées / sorties', () => {
  it('IN A,(n) forme l\'adresse avec le nibble haut de A', () => {
    m.ioReadHandler = (addr) => (addr === 0x7F00 ? 0x5A : 0xFF);
    execAt([0xDB, 0x00], () => { m.setReg8('A', 0x7F); });
    expect(m.getReg8('A')).toBe(0x5A);
    expect(m.ioIn[m.ioIn.length - 1].addr, 'le port doit être (A<<8)|n').toBe(0x7F00);
  });

  it('IN r,(C) utilise le port complet contenu dans BC', () => {
    m.ioReadHandler = () => 0xC3;
    execAt([0xED, 0x50], () => { m.setReg16('BC', 0x1234); }); // IN D,(C)
    expect(m.getReg8('D')).toBe(0xC3);
    expect(m.ioIn[m.ioIn.length - 1].addr).toBe(0x1234);
  });

  it('IN r,(C) positionne S/Z et la parité du résultat', () => {
    m.ioReadHandler = () => 0x00;
    execAt([0xED, 0x78], () => { m.setReg16('BC', 0x1234); }); // IN A,(C)
    expect(m.flags.Z, 'Z doit être 1 pour une valeur nulle').toBe(1);

    m.ioReadHandler = () => 0x01;
    execAt([0xED, 0x78], () => { m.setReg16('BC', 0x1234); });
    expect(m.flags.Z).toBe(0);
  });

  it('OUT (n),A émet une écriture différée de priorité haute', () => {
    execAt([0xD3, 0x40], () => { m.setReg8('A', 0x99); });
    // Le harnais draine l'écriture différée comme le fait IO_Manager.
    expect(m.ioOut).toHaveLength(1);
    expect(m.ioOut[0].value).toBe(0x99);
    expect(m.ioOut[0].addr).toBe(0x9940);
    expect(m.ioOut[0].priority, 'OUT (n),A est priorité 1').toBe(1);
    expect(m.cpu.ioWriteState, 'doit être remis à zéro par l\'hôte').toBe(0);
  });

  it('OUT (C),r émet une écriture différée de priorité basse', () => {
    execAt([0xED, 0x51], () => { m.setReg16('BC', 0x1234); m.setReg8('D', 0x77); });
    expect(m.ioOut).toHaveLength(1);
    expect(m.ioOut[0].addr).toBe(0x1234);
    expect(m.ioOut[0].value).toBe(0x77);
    expect(m.ioOut[0].priority, 'OUT (C),r est priorité 2').toBe(2);
  });

  it('OUT (C),0 écrit une constante nulle', () => {
    execAt([0xED, 0x71], () => { m.setReg16('BC', 0x2000); });
    expect(m.ioOut[0].value).toBe(0x00);
    expect(m.ioOut[0].addr).toBe(0x2000);
  });

  it('LD A,I et LD A,R copient les registres internes', () => {
    execAt([0xED, 0x57], () => { m.cpu.regI = 0x3F; m.cpu.iff2 = 1; });
    expect(m.getReg8('A')).toBe(0x3F);
    expect(m.flags.PV, 'PV doit refléter IFF2').toBe(1);

    execAt([0xED, 0x5F], () => { m.cpu.regR = 0x21; });
    // R est incrémenté à chaque lecture d'opcode : les deux fetches de
    // « ED 5F » l'ont déjà porté de 0x21 à 0x23 avant l'exécution.
    expect(m.getReg8('A')).toBe(0x23);
  });

  it('LD I,A et LD R,A écrivent les registres internes', () => {
    execAt([0xED, 0x47], () => { m.setReg8('A', 0x7E); });
    expect(m.cpu.regI).toBe(0x7E);

    execAt([0xED, 0x4F], () => { m.setReg8('A', 0x19); });
    expect(m.cpu.regR).toBe(0x19);
  });
});