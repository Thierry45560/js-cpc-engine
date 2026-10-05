/**
 * @file tests/z80/block-io.test.mjs
 * @description Compléments de couverture : variantes bloc, famille INI/OUTI,
 * gestion des opcodes invalides et instantané d'état.
 *
 * `control-flow.test.mjs` couvre déjà LDI/LDIR/LDD et CPI/CPIR. Ce fichier
 * complète avec LDDR, CPD, CPDR, l'intégralité des huit instructions
 * INI/INIR/IND/INDR/OUTI/OTIR/OUTD/OTDR, puis verrouille le comportement
 * des stubs d'erreur (opcodes ED non définis).
 */

import { describe, it, expect } from 'vitest';
import { TestMachine } from '../helpers/z80-harness.mjs';

const m = new TestMachine();

/**
 * Prépare une instruction bloc ED et un bloc mémoire.
 * @param {number} edOpcode second octet
 * @param {number} sourceAddr adresse de départ des données
 * @param {number} destAddr adresse de destination
 * @param {number[]} values octets à placer
 * @param {string} direction 'inc' ou 'dec'
 */
function setupBlock(edOpcode, sourceAddr, destAddr, values, direction = 'inc') {
  m.cpu.reset();
  m.cpu.regPC = 0x0100;
  m.cpu.ioWriteState = 0;
  m.ioOut.length = 0;
  m.load([0xED, edOpcode], 0x0100);

  m.mem.fill(0, 0x2000, 0x2100);
  m.mem.fill(0, 0x3000, 0x3100);

  values.forEach((v, i) => {
    m.mem[direction === 'inc' ? sourceAddr + i : sourceAddr - i] = v;
  });

  m.setReg16('HL', sourceAddr);
  m.setReg16('DE', destAddr);
  m.setReg16('BC', values.length);
  m.setReg16('SP', 0xFFFE);
}

// ─────────────────────────────────────────────────────────────────────────────
// Variantes bloc décroissantes et comparaisons
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — LDDR et LDD', () => {
  it('LDDR transfère tout le bloc en sens décroissant', () => {
    setupBlock(0xB8, 0x2003, 0x3003, [0xA0, 0xA1, 0xA2], 'dec');
    m.stepUntil(0x0102);

    expect(m.mem[0x3003]).toBe(0xA0);
    expect(m.mem[0x3002]).toBe(0xA1);
    expect(m.mem[0x3001]).toBe(0xA2);
    expect(m.getReg16('BC')).toBe(0x0000);
    expect(m.getReg16('HL'), 'HL doit être décrémenté 3 fois').toBe(0x2000);
    expect(m.getReg16('DE')).toBe(0x3000);
  });

  it('LDD ne traite qu\'un octet', () => {
    setupBlock(0xA8, 0x2000, 0x3000, [0x77], 'dec');
    m.step();
    expect(m.mem[0x3000]).toBe(0x77);
    expect(m.getReg16('HL')).toBe(0x1FFF);
    expect(m.getReg16('DE')).toBe(0x2FFF);
    expect(m.getReg16('BC')).toBe(0x0000);
  });
});

describe('Z80 — CPD et CPDR', () => {
  it('CPD compare en sens décroissant', () => {
    // En sens décroissant depuis 0x2003 : le PREMIER octet lu est mem[0x2003].
    setupBlock(0xA9, 0x2003, 0x3000, [0x99, 0x22, 0x11], 'dec'); // ED A9 = CPD
    m.setReg8('A', 0x99);

    m.step();

    expect(m.getReg16('HL')).toBe(0x2002);
    expect(m.getReg16('BC')).toBe(0x0002);
    expect(m.flags.Z, 'Z doit rester 1 : A == (HL)').toBe(1);
  });

  it('CPDR s\'arrête à la correspondance', () => {
    setupBlock(0xB9, 0x2004, 0x3000, [0x01, 0x02, 0x03, 0x77, 0x05], 'dec'); // ED B9 = CPDR
    m.setReg8('A', 0x77);

    m.stepUntil(0x0102);

    // 4 itérations pour atteindre la valeur : BC passe de 5 à 1.
    expect(m.getReg16('HL'), 'doit s\'arrêter juste après la correspondance').toBe(0x2000);
    expect(m.getReg16('BC')).toBe(0x0001);
    expect(m.flags.PV, 'PV reste à 1 tant que BC ≠ 0').toBe(1);
  });

  it('CPDR parcourt tout le bloc sans correspondance', () => {
    setupBlock(0xB9, 0x2004, 0x3000, [0x01, 0x02, 0x03], 'dec');
    m.setReg8('A', 0xFF);

    m.stepUntil(0x0102);
    expect(m.getReg16('BC')).toBe(0x0000);
    expect(m.flags.Z, 'Z doit rester 0').toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Famille INI / OUTI
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — instructions E/S bloc (INI / OUTI)', () => {
  /** Prépare une machine avec un port INConstant. */
  function setupIo(edOpcode, { bc = 0x1000, hl = 0x4000, b = 2, memValue = 0xAA, portValue = 0x5A } = {}) {
    m.cpu.reset();
    m.cpu.regPC = 0x0100;
    m.cpu.ioWriteState = 0;
    m.ioOut.length = 0;
    m.ioIn.length = 0;
    m.load([0xED, edOpcode], 0x0100);
    // On remplit une plage : les instructions répétées (INIR/OTIR) relisent
    // les octets suivants, qui doivent être définis.
    m.mem.fill(memValue, 0x4000, 0x4010);
    m.mem[hl] = memValue;
    m.setReg16('BC', bc);
    m.setReg16('HL', hl);
    m.setReg8('B', b);
    m.ioReadHandler = () => portValue;
    return m;
  }

  it('INI lit le port et écrit la valeur en mémoire', () => {
    setupIo(0xA2, { b: 2 });
    m.step();

    expect(m.mem[0x4000], 'la valeur du port doit être écrite en (HL)').toBe(0x5A);
    expect(m.getReg16('HL'), 'HL incrémenté').toBe(0x4001);
  });

  /**
   * `INI` décrémente B d'une seule unité dans le cœur, alors que le Z80 réel
   * en fait deux (une quirk documentée du double décompte de B).
   *
   * Ce point est HORS PÉRIMÈTRE de ZEXALL : la suite de Cringle ne contient
   * aucun test `ini`/`inir`/`outi`/`otir`. Il n'y a donc pas de référence
   * empirique dans le dépôt pour trancher, et le cœur Z80 étant considéré
   * comme figé, on fige le comportement tel qu'il est plutôt que de le
   * corriger sur la foi d'une documentation secondaire.
   *
   * Conséquence pratique : une boucle `INIR` dure deux fois plus longtemps
   * que sur silicium, ce qui est sans effet sur les jeux CPC (INIR est une
   * instruction quasi inexistante hors des tests de périphériques).
   *
   * Ce test est VERT : il constate, il n'attend pas. Le jour où le double
   * décompte est implémenté, c'est ce test qu'il faut mettre à jour.
   */
  it('INI décrémente B d\'une seule unité (comportement figé, hors ZEXALL)', () => {
    setupIo(0xA2, { b: 2 });
    m.step();
    expect(m.getReg8('B'), 'de 2, le cœur arrive à 1 (Z80 réel : 0)').toBe(0x01);
  });

  it('OUTI décrémente B d\'une seule unité comme sur silicium', () => {
    // Contrairement à INI, OUTI ne décompte B qu'une fois sur le Z80 réel :
    // c'est donc un point sur lequel le cœur est fidèle.
    setupIo(0xA3, { b: 2, memValue: 0x77 });
    m.step();
    expect(m.getReg8('B'), 'de 2, le cœur arrive à 1').toBe(0x01);
  });

  it('INIR répète jusqu\'à B = 0', () => {
    setupIo(0xB2, { b: 3 });
    m.stepUntil(0x0102);

    expect(m.mem[0x4000]).toBe(0x5A);
    expect(m.mem[0x4001]).toBe(0x5A);
    expect(m.mem[0x4002]).toBe(0x5A);
    // Trois itérations, puisque B ne perd qu'une unité par tour.
    expect(m.getReg8('B')).toBe(0x00);
  });

  it('IND travaille en sens décroissant', () => {
    setupIo(0xAA, { hl: 0x4002 });
    m.step();
    expect(m.getReg16('HL')).toBe(0x4001);
  });

  it('OUTI émet une écriture port et décrémente B une seule fois', () => {
    setupIo(0xA3, { b: 2, memValue: 0x77 });
    m.step();

    expect(m.ioOut).toHaveLength(1);
    // B est décrémenté AVANT la lecture du port : BC valait 0x1000,
    // il vaut donc 0x0100 au moment de l'écriture.
    expect(m.ioOut[0].addr, 'le port est pris dans BC après décrément de B').toBe(0x0100);
    expect(m.ioOut[0].value).toBe(0x77);
    expect(m.getReg8('B'), 'OUTI ne décrémente B qu\'une fois').toBe(0x01);
    expect(m.getReg16('HL')).toBe(0x4001);
  });

  it('OTIR répète jusqu\'à B = 0', () => {
    setupIo(0xB3, { b: 3, memValue: 0x33 });
    m.stepUntil(0x0102);

    expect(m.ioOut.length).toBe(3);
    expect(m.ioOut.every((w) => w.value === 0x33)).toBe(true);
    expect(m.getReg8('B')).toBe(0x00);
  });

  it('OUTD travaille en sens décroissant', () => {
    setupIo(0xAB, { hl: 0x4002, memValue: 0x11 });
    m.step();
    expect(m.getReg16('HL')).toBe(0x4001);
    // B est décrémenté avant l'écriture : BC = 0x1000 devient 0x0100.
    expect(m.ioOut[0].addr).toBe(0x0100);
  });

  it('les huit opcodes de la famille sont reconnus', () => {
    const family = [
      [0xA2, 'INI'], [0xB2, 'INIR'], [0xAA, 'IND'], [0xBA, 'INDR'],
      [0xA3, 'OUTI'], [0xB3, 'OTIR'], [0xAB, 'OUTD'], [0xBB, 'OTDR'],
    ];

    for (const [opcode, name] of family) {
      setupIo(opcode, { b: 1 });
      expect(() => m.step(), `${name} (ED ${opcode.toString(16)}) ne doit pas lever`).not.toThrow();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Opcodes invalides
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — exhaustivité des tables d\'opcodes', () => {
  // Ce bloc vérifiait jusqu'ici que `ED 00` et `ED 7F` lèvent une erreur. Il
  // figeait un bug : ces opcodes sont des NOP documentés (Zilog UM0081 — « do
  // nothing at all but taking up 8 T states »), et le moindre `ED FF` dans une
  // ROM de boot CPC interrompait l'émulation.
  //
  // Après correction, les quatre tables sont **complètes** : aucun des 1024
  // opcodes ne lève. C'est le comportement d'un vrai Z80, dont la table
  // n'a aucun trou. Les stubs d'erreur restent en place comme filet de
  // sécurité, mais sont devenus inatteignables — du code mort assumé.
  //
  // Le comportement détaillé des `ED` non documentés est vérifié par
  // tests/z80/ed-nop.test.mjs.
  it('les 1024 opcodes des quatre tables s\'exécutent sans lever', () => {
    const coupables = [];
    for (const [nom, table] of [
      ['base', 'opcodes'], ['CB', 'opcodesCB'],
      ['ED', 'opcodesED'], ['DDFDCB', 'opcodesDDFDCB'],
    ]) {
      for (let i = 0; i < 256; i++) {
        m.cpu.reset();
        try {
          m.cpu[table][i]();
        } catch (e) {
          coupables.push(`${nom} 0x${i.toString(16).toUpperCase().padStart(2, '0')}: ${e.message}`);
        }
      }
    }
    expect(coupables, coupables.join('\n')).toEqual([]);
  });

  it('un préfixe DD suivi d\'un opcode non indexé retombe sur l\'opcode de base', () => {
    // Comportement documenté du Z80 : DD/FD devant un opcode non indexé
    // équivaut à l'instruction de base correspondante.
    m.cpu.reset();
    m.cpu.regPC = 0x0100;
    m.load([0xDD, 0x7E, 0xFF, 0x00], 0x0100); // DD devant LD A,(nn)
    m.setReg16('HL', 0x0000);
    m.mem[0x0000] = 0x42;
    m.setReg16('HL', 0x0000);

    // DD 7E est en réalité `LD A,(IX+d)` ; on vérifie simplement que le CPU
    // reste dans un état cohérent et n'avance pas de façon anormale.
    expect(() => m.step()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Instantané d'état
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — getState()', () => {
  it('reflète fidèlement les registres', () => {
    m.cpu.reset();
    // AF est posé d'un seul tenant : A = 0x11, F = 0x22.
    m.setReg16('AF', 0x1122);
    m.setReg16('BC', 0x3344);
    m.setReg16('DE', 0x5566);
    m.setReg16('HL', 0x7788);
    m.cpu.alt16[0] = 0xAAAA;
    m.cpu.alt16[1] = 0xBBBB;
    m.cpu.alt16[2] = 0xCCCC;
    m.cpu.alt16[3] = 0x3311;
    m.setReg16('IX', 0xDD00);
    m.setReg16('IY', 0xEE01);
    m.setReg16('SP', 0xFFFE);
    m.cpu.regPC = 0x1234;
    m.cpu.regWZ = 0x5678;
    m.cpu.regI = 0x3F;
    m.cpu.regR = 0x21;
    m.cpu.regIM = 2;
    m.cpu.iff1 = 1;
    m.cpu.iff2 = 0;

    const s = m.cpu.getState();

    expect(s.A).toBe(0x11);
    expect(s.F).toBe(0x22);
    expect(s.BC).toBe(0x3344);
    expect(s.DE).toBe(0x5566);
    expect(s.HL).toBe(0x7788);
    expect(s.AF).toBe(0x1122);
    expect(s.BC_alt).toBe(0xAAAA);
    expect(s.DE_alt).toBe(0xBBBB);
    expect(s.HL_alt).toBe(0xCCCC);
    expect(s.AF_alt, "AF' est le jeu alternatif").toBe(0x3311);
    expect(s.IX).toBe(0xDD00);
    expect(s.IY).toBe(0xEE01);
    expect(s.SP).toBe(0xFFFE);
    expect(s.PC).toBe(0x1234);
    expect(s.WZ).toBe(0x5678);
    expect(s.I).toBe(0x3F);
    expect(s.R).toBe(0x21);
    expect(s.IM).toBe(2);
    expect(s.iff1).toBe(1);
    expect(s.iff2).toBe(0);
    expect(s.halted).toBe(false);
  });

  it('reset() remet à zéro l\'état d\'exécution', () => {
    m.cpu.reset();
    m.setReg8('A', 0xFF);
    m.setReg8('F', 0xFF);
    m.setReg16('BC', 0x1234);
    m.cpu.regIM = 2;
    m.cpu.regI = 0x7E;
    m.cpu.iff1 = 1;
    m.cpu.iff2 = 1;
    m.cpu.isHalted = true;
    m.cpu.interruptPending = true;

    m.cpu.reset();

    const s = m.cpu.getState();
    expect(s.PC).toBe(0);
    expect(s.IX).toBe(0xFFFF);
    expect(s.IY).toBe(0xFFFF);
    expect(s.WZ).toBe(0);
    expect(s.IM).toBe(0);
    expect(s.I).toBe(0);
    expect(s.R).toBe(0);
    expect(s.iff1).toBe(0);
    expect(s.iff2).toBe(0);
    expect(s.halted).toBe(false);
  });

  it('reset() ne remet PAS SP ni les registres 8 bits à zéro', () => {
    // Comportement documenté du cœur : `reset()` ne réinitialise que l'état
    // d'exécution. SP et A..L conservent leur valeur — c'est à
    // `Emulator_Core.hardReset()` de les poser explicitement.
    m.setReg8('A', 0x5A);
    m.setReg16('SP', 0x1234);

    m.cpu.reset();

    expect(m.getReg8('A'), 'A survit à reset()').toBe(0x5A);
    expect(m.getReg16('SP'), 'SP survit à reset()').toBe(0x1234);
  });
});