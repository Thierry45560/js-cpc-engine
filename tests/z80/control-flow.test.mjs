/**
 * @file tests/z80/control-flow.test.mjs
 * @description Conformité du transfert de contrôle et de la pile.
 *
 * Couvre : JP/JR/DJNZ, CALL/RET/RST avec leurs 8 conditions, PUSH/POP,
 * la famille EX (AF,AF' / EXX / (SP),HL), INC/DEC de registres 16 bits,
 * et les instructions bloc (LDI/LDD/LDIR/LDDR et CPI/CPD/CPIR/CPDR).
 *
 * Les instructions bloc ré-exécutent le même opcode tant que BC ≠ 0 : le
 * harnais fournit `stepUntil()` pour les piloter jusqu'à leur terme.
 */

import { describe, it, expect } from 'vitest';
import { TestMachine } from '../helpers/z80-harness.mjs';

/** Nom des 8 conditions Z80, dans l'ordre d'encodage des bits cc. */
const CONDITIONS = ['NZ', 'Z', 'NC', 'C', 'PO', 'PE', 'P', 'M'];

/** Programme sentinelle : si PC y arrive, c'est que la condition est fausse. */
const SENTINEL = 0x8000;

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
  m.load(code, 0x0100);
  if (setup) setup();
  m.step();
  return m;
}

// ─────────────────────────────────────────────────────────────────────────────
// JP
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — JP nn', () => {
  it('charge une adresse absolue dans PC', () => {
    execAt([0xC3, 0x34, 0x12], () => { m.setReg16('HL', 0xFFFF); });
    expect(m.cpu.regPC).toBe(0x1234);
  });

  it('JP cc,nn prend la branche si et seulement si la condition est vraie', () => {
    // Table des 8 conditions : [drapeau testé, valeur attendue du bit]
    // Z=bit6, C=bit0, PV=bit2, S=bit7
    const truthTable = [
      { cc: 0, flag: R_F.Z, set: 0, taken: true },  // NZ : Z=0
      { cc: 1, flag: R_F.Z, set: 1, taken: true },  // Z  : Z=1
      { cc: 2, flag: R_F.C, set: 0, taken: true },  // NC : C=0
      { cc: 3, flag: R_F.C, set: 1, taken: true },  // C  : C=1
      { cc: 4, flag: R_F.PV, set: 0, taken: true }, // PO : PV=0
      { cc: 5, flag: R_F.PV, set: 1, taken: true }, // PE : PV=1
      { cc: 6, flag: R_F.S, set: 0, taken: true },  // P  : S=0
      { cc: 7, flag: R_F.S, set: 1, taken: true },  // M  : S=1
    ];

    for (const { cc, flag, set, taken } of truthTable) {
      // Condition satisfaite → saut vers 0x1234
      execAt([0xC2 | (cc << 3), 0x34, 0x12], () => { m.setReg8('F', set * flag); });
      expect(m.cpu.regPC, `JP ${CONDITIONS[cc]} satisfaite`).toBe(0x1234);

      // Condition non satisfaite → PC tombe juste après les 3 octets
      execAt([0xC2 | (cc << 3), 0x34, 0x12], () => { m.setReg8('F', (1 - set) * flag); });
      expect(m.cpu.regPC, `JP ${CONDITIONS[cc]} non satisfaite`).toBe(0x0103);
      expect(taken).toBe(true);
    }
  });

  it('JP (HL) saute vers le contenu de HL', () => {
    execAt([0xE9], () => { m.setReg16('HL', 0xABCD); });
    expect(m.cpu.regPC).toBe(0xABCD);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// JR / DJNZ
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — JR et DJNZ', () => {
  it('JR e accepte un déplacement relatif signé', () => {
    execAt([0x18, 0x05], () => {});          // JR +5 depuis 0x0102
    expect(m.cpu.regPC).toBe(0x0107);

    execAt([0x18, 0xFB], () => {});          // JR -5
    expect(m.cpu.regPC).toBe(0x00FD);
  });

  it('JR cc,e respecte la condition', () => {
    // JR Z, +2  (0x28)
    execAt([0x28, 0x02], () => { m.setReg8('F', R_F.Z); });
    expect(m.cpu.regPC).toBe(0x0104);

    execAt([0x28, 0x02], () => { m.setReg8('F', 0x00); });
    expect(m.cpu.regPC).toBe(0x0102);

    // JR NZ, +2 (0x20)
    execAt([0x20, 0x02], () => { m.setReg8('F', 0x00); });
    expect(m.cpu.regPC).toBe(0x0104);
  });

  it('DJNZ décrémente B et boucle tant que B ≠ 0', () => {
    // DJNZ -2  (0x10, 0xFE) placé à 0x0100, B=3
    m.cpu.regPC = 0x0100;
    m.cpu.ioWriteState = 0;
    m.load([0x10, 0xFE, 0x00], 0x0100);
    m.setReg8('B', 3);
    m.setReg16('HL', 0x0200);

    let iterations = 0;
    while (m.cpu.regPC === 0x0100 && iterations < 10) {
      m.step();
      iterations++;
    }

    expect(iterations, 'DJNZ doit itérer exactement B fois').toBe(3);
    expect(m.getReg8('B'), 'B doit finir à 0').toBe(0);
    expect(m.cpu.regPC, 'doit être sorti de la boucle').toBe(0x0102);
  });

  it('DJNZ avec B=0 ne boucle pas (256 itérations sur 8 bits)', () => {
    m.cpu.regPC = 0x0100;
    m.load([0x10, 0xFE], 0x0100);
    m.setReg8('B', 1); // une seule itération suffit pour sortir
    m.step();
    expect(m.getReg8('B')).toBe(0);
    expect(m.cpu.regPC).toBe(0x0102);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CALL / RET / RST
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — CALL / RET', () => {
  it('CALL empile l\'adresse de retour et saute', () => {
    execAt([0xCD, 0x00, 0x20], () => { m.setReg16('SP', 0xFFFE); });
    expect(m.cpu.regPC).toBe(0x2000);
    expect(m.getReg16('SP'), 'SP doit être décrémenté de 2').toBe(0xFFFC);
    // Adresse de retour = 0x0103, pushed high byte first
    expect(m.mem[0xFFFD]).toBe(0x01);
    expect(m.mem[0xFFFC]).toBe(0x03);
  });

  it('RET dépile et revient à l\'adresse de retour', () => {
    execAt([0xCD, 0x00, 0x20], () => { m.setReg16('SP', 0xFFFE); });
    expect(m.cpu.regPC).toBe(0x2000);

    // On charge réellement RET à la cible du saut.
    m.load([0xC9], 0x2000);
    m.cpu.regPC = 0x2000;
    m.step();
    expect(m.cpu.regPC).toBe(0x0103);
    expect(m.getReg16('SP')).toBe(0xFFFE);
  });

  it('CALL cc,nn / RET cc push et pop de façon symétrique', () => {
    // Pour chaque condition : un cas où elle est vraie, un où elle est fausse.
    const cases = [
      { cc: 0, condition: 'NZ', takenF: 0x00, notTakenF: R_F.Z },
      { cc: 1, condition: 'Z', takenF: R_F.Z, notTakenF: 0x00 },
    ];

    for (const { cc, condition, takenF, notTakenF } of cases) {
      execAt([0xC4 | (cc << 3), 0x00, 0x20], () => {
        m.setReg16('SP', 0xFFFE);
        m.setReg8('F', takenF);
      });
      expect(m.cpu.regPC, `CALL ${condition} pris`).toBe(0x2000);
      expect(m.getReg16('SP'), 'le saut doit empiler').toBe(0xFFFC);

      execAt([0xC4 | (cc << 3), 0x00, 0x20], () => {
        m.setReg16('SP', 0xFFFE);
        m.setReg8('F', notTakenF);
      });
      expect(m.cpu.regPC, `CALL ${condition} non pris`).toBe(0x0103);
      expect(m.getReg16('SP'), 'rien ne doit être empilé').toBe(0xFFFE);
    }
  });

  it('RST p saute aux 8 vecteurs de réinitialisation', () => {
    for (let p = 0; p < 8; p++) {
      execAt([0xC7 | (p << 3)], () => { m.setReg16('SP', 0xFFFE); });
      expect(m.cpu.regPC, `RST ${p << 3}`).toBe(p << 3);
      expect(m.getReg16('SP')).toBe(0xFFFC);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUSH / POP
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — PUSH / POP', () => {
  const PAIRS = [
    { name: 'BC', opcode: 0xC5, index: 'BC' },
    { name: 'DE', opcode: 0xD5, index: 'DE' },
    { name: 'HL', opcode: 0xE5, index: 'HL' },
    { name: 'AF', opcode: 0xF5, index: 'AF' },
  ];

  it('PUSH puis POP restitue la valeur', () => {
    for (const { name, opcode, index } of PAIRS) {
      execAt([opcode], () => {
        m.setReg16('SP', 0xFFFE);
        m.setReg16(index, 0x1234);
      });
      expect(m.getReg16('SP'), `PUSH ${name}`).toBe(0xFFFC);

      m.cpu.regPC = 0x0100;
      m.load([opcode === 0xC5 ? 0xC1 : opcode === 0xD5 ? 0xD1 : opcode === 0xE5 ? 0xE1 : 0xF1], 0x0100);
      m.step();
      expect(m.getReg16(index), `POP ${name}`).toBe(0x1234);
      expect(m.getReg16('SP')).toBe(0xFFFE);
    }
  });

  it('PUSH écrit l\'octet haut en premier', () => {
    execAt([0xE5], () => { m.setReg16('SP', 0xFFFE); m.setReg16('HL', 0xABCD); });
    expect(m.mem[0xFFFD]).toBe(0xAB);
    expect(m.mem[0xFFFC]).toBe(0xCD);
  });

  it('POP ne touche pas SP lors d\'une interruption', () => {
    execAt([0xF1], () => { m.setReg16('SP', 0xFFFC); m.mem[0xFFFC] = 0x00; m.mem[0xFFFD] = 0x00; });
    expect(m.getReg16('SP')).toBe(0xFFFE);
    expect(m.getReg8('A')).toBe(0x00);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EX
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — famille EX', () => {
  it('EX AF,AF\' échange AF et le jeu alternatif', () => {
    execAt([0x08], () => { m.setReg16('AF', 0x1234); m.cpu.alt16[3] = 0xABCD; });
    expect(m.getReg16('AF')).toBe(0xABCD);
    expect(m.cpu.alt16[3]).toBe(0x1234);
  });

  it('EXX échange les trois paires principales', () => {
    execAt([0xD9], () => {
      m.setReg16('BC', 0x1111); m.setReg16('DE', 0x2222); m.setReg16('HL', 0x3333);
      m.cpu.alt16[0] = 0xAAAA; m.cpu.alt16[1] = 0xBBBB; m.cpu.alt16[2] = 0xCCCC;
    });
    expect(m.getReg16('BC')).toBe(0xAAAA);
    expect(m.getReg16('DE')).toBe(0xBBBB);
    expect(m.getReg16('HL')).toBe(0xCCCC);
    expect(m.cpu.alt16[0]).toBe(0x1111);
    expect(m.cpu.alt16[2]).toBe(0x3333);
  });

  it('EX DE,HL échange DE et HL', () => {
    execAt([0xEB], () => { m.setReg16('DE', 0x1111); m.setReg16('HL', 0x2222); });
    expect(m.getReg16('DE')).toBe(0x2222);
    expect(m.getReg16('HL')).toBe(0x1111);
  });

  it('EX (SP),HL écrit le bas de HL dans la pile puis fait pivoter HL', () => {
    execAt([0xE3], () => {
      m.setReg16('SP', 0xFFFE);
      m.setReg16('HL', 0x1234);
      m.mem[0xFFFE] = 0xAA;
      m.mem[0xFFFF] = 0xBB;
    });
    expect(m.mem[0xFFFE], 'le bas de HL doit être écrit en (SP)').toBe(0x34);
    expect(m.getReg16('HL'), 'HL doit valoir l\'ancien contenu de (SP)').toBe(0xBBAA);
  });

  it('LD SP,HL copie HL dans SP', () => {
    execAt([0xF9], () => { m.setReg16('HL', 0x4321); m.setReg16('SP', 0x0000); });
    expect(m.getReg16('SP')).toBe(0x4321);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INC / DEC 16 bits
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — INC/DEC de registres 16 bits', () => {
  it('INC rr et DEC rr sur BC, DE, HL, SP', () => {
    // Table explicite : INC SP (0x33) et DEC SP (0x3B) ne suivent pas
    // la formule `0x03 | (p << 4)` qui ne couvre que les trois paires r16.
    const table = [
      { name: 'BC', inc: 0x03, dec: 0x0B },
      { name: 'DE', inc: 0x13, dec: 0x1B },
      { name: 'HL', inc: 0x23, dec: 0x2B },
      { name: 'SP', inc: 0x33, dec: 0x3B },
    ];

    for (const { name, inc, dec } of table) {
      execAt([inc], () => { m.setReg16(name, 0x00FF); });
      expect(m.getReg16(name), `INC ${name}`).toBe(0x0100);

      execAt([dec], () => { m.setReg16(name, 0x0100); });
      expect(m.getReg16(name), `DEC ${name}`).toBe(0x00FF);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Instructions bloc
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — instructions bloc (LDI/LDD/LDIR/LDDR)', () => {
  /**
   * Prépare un bloc source et une machine, avec BC initialisé.
   * @param {number} edOpcode second octet (LDI=0xA0, LDIR=0xB0, LDD=0xA8…)
   * @param {number} count nombre d'octets à transférer
   * @param {number} [hl=0x2000] adresse de départ de la source
   * @returns {TestMachine}
   */
  function setupBlock(edOpcode, count, hl = 0x2000) {
    m.cpu.regPC = 0x0100;
    m.cpu.ioWriteState = 0;
    m.load([0xED, edOpcode], 0x0100);   // les DEUX octets sont nécessaires
    m.mem.fill(0, 0x2000, 0x2100);
    m.mem.fill(0, 0x3000, 0x3100);
    for (let i = 0; i < count; i++) m.mem[hl + i] = 0xA0 + i;
    m.setReg16('HL', hl);
    m.setReg16('DE', 0x3000);
    m.setReg16('BC', count);
    m.setReg16('SP', 0xFFFE);
    return m;
  }

  it('LDI copie un octet, incrémente HL/DE et décrémente BC', () => {
    setupBlock(0xA0, 1);
    m.step();
    expect(m.mem[0x3000]).toBe(0xA0);
    expect(m.getReg16('HL')).toBe(0x2001);
    expect(m.getReg16('DE')).toBe(0x3001);
    expect(m.getReg16('BC')).toBe(0x0000);
    expect(m.flags.PV, 'PV doit tomber à 0 quand BC atteint 0').toBe(0);
  });

  it('LDIR transfère tout le bloc et rend la main après', () => {
    setupBlock(0xB0, 4);
    m.stepUntil(0x0102);

    for (let i = 0; i < 4; i++) {
      expect(m.mem[0x3000 + i], `octet ${i}`).toBe(0xA0 + i);
    }
    expect(m.getReg16('BC')).toBe(0x0000);
    expect(m.getReg16('HL')).toBe(0x2004);
    expect(m.getReg16('DE')).toBe(0x3004);
  });

  it('LDD copie en sens décroissant', () => {
    setupBlock(0xA8, 1, 0x2004);
    m.setReg16('DE', 0x3004);
    m.step();
    expect(m.mem[0x3004]).toBe(0xA0);
    expect(m.getReg16('HL')).toBe(0x2003);
    expect(m.getReg16('DE')).toBe(0x3003);
  });

  it('CPI compare sans écrire et positionne les drapeaux', () => {
    m.cpu.regPC = 0x0100;
    m.load([0xED, 0xA1], 0x0100);
    m.mem[0x2000] = 0x42;
    m.setReg16('HL', 0x2000);
    m.setReg16('BC', 1);
    m.setReg8('A', 0x42);
    m.step();

    expect(m.flags.Z, 'Z doit être 1 si A == (HL)').toBe(1);
    expect(m.getReg16('HL')).toBe(0x2001);
    expect(m.getReg16('BC')).toBe(0x0000);
    expect(m.mem[0x2000], 'CPI ne doit pas modifier la mémoire').toBe(0x42);
  });

  it('CPIR s\'arrête à la correspondance', () => {
    m.cpu.regPC = 0x0100;
    m.load([0xED, 0xB1], 0x0100);
    m.mem.fill(0x00, 0x2000, 0x2010);
    m.mem[0x2005] = 0x99;
    m.setReg16('HL', 0x2000);
    m.setReg16('BC', 10);
    m.setReg8('A', 0x99);

    m.stepUntil(0x0102);
    expect(m.getReg16('BC'), 'doit s\'arrêter après 6 itérations').toBe(4);
  });
});

// Drapeaux bruts, pour éviter une dépendance à z80-reference dans ce fichier.
const R_F = { Z: 0x40, C: 0x01, PV: 0x04, S: 0x80 };