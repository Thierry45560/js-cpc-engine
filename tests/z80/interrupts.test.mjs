/**
 * @file tests/z80/interrupts.test.mjs
 * @description Conformité du système d'interruptions et des états de contrôle.
 *
 * Couvre : EI / DI, les trois modes d'interruption (IM 0, 1, 2), NMI,
 * RETI / RETN, HALT, et le compteur interne R.
 *
 * Le bus du harnais expose deux points de contrôle utilisés ici :
 *  - `getIntStatus()`  simule une ligne d'interruption материального (0/1) ;
 *  - `acknowledgeInterrupt()` renvoie la valeur de bus présentée sur le bus
 *    de données pendant l'acquittement (utile en IM 0 et IM 2).
 */

import { describe, it, expect } from 'vitest';
import { TestMachine } from '../helpers/z80-harness.mjs';

const m = new TestMachine();

/**
 * Réinitialise la machine dans un état connu.
 * @param {object} [options]
 */
function resetMachine({ irqVector = 0xFF, intStatus = 0 } = {}) {
  m.cpu.reset();
  m.cpu.regPC = 0x0100;
  m.cpu.regSP = 0xFFFE;
  m.cpu.ioWriteState = 0;
  m.irqVector = irqVector;
  m.intStatus = intStatus;
  m.ioOut.length = 0;
  m.ioIn.length = 0;
  m.mem.fill(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// EI / DI
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — EI et DI', () => {
  it('DI annule les interruptions, y compris IFF1 et IFF2', () => {
    resetMachine();
    m.load([0xF3], 0x0100);
    m.cpu.iff1 = 1;
    m.cpu.iff2 = 1;
    m.step();
    expect(m.cpu.iff1).toBe(0);
    expect(m.cpu.iff2).toBe(0);
  });

  it('DI annule aussi une activation d\'interruption en attente', () => {
    resetMachine();
    m.load([0xFB, 0xF3], 0x0100); // EI puis DI
    m.step();
    expect(m.cpu.interruptPending, 'EI doit armer la demande').toBe(true);
    m.step();
    expect(m.cpu.interruptPending, 'DI doit la lever').toBe(false);
  });

  it('EI n\'active pas IFF1 immédiatement — l\'instruction suivante s\'exécute d\'abord', () => {
    resetMachine();
    m.load([0xFB, 0x00], 0x0100); // EI ; NOP
    m.step();
    expect(m.cpu.interruptPending, 'EI arme la demande').toBe(true);
    expect(m.cpu.iff1, 'IFF1 ne doit pas encore être à 1').toBe(0);

    // Le NOP doit s'exécuter avant toute prise en compte de l'interruption.
    m.step();
    expect(m.cpu.regPC, 'le NOP suivant doit avoir été exécuté').toBe(0x0102);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Modes d'interruption
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — modes d\'interruption', () => {
  it('IM 0 : exécute l\'instruction fournie par le bus, sans empiler', () => {
    // En IM 0, la valeur présentée sur le bus de données EST l'opcode exécuté.
    resetMachine({ irqVector: 0x3C }); // le bus présente un INC A
    m.cpu.regIM = 0;
    m.load([0x00, 0x00], 0x0100);       // NOP NOP
    m.cpu.regPC = 0x0100;
    m.cpu.iff1 = 1;
    m.intStatus = 1;
    m.setReg8('A', 0x41);

    m.step();

    expect(m.getReg8('A'), 'le bus a présenté INC A, qui doit avoir été exécuté').toBe(0x42);
    expect(m.getReg16('SP'), 'IM 0 n\'empile rien sur la pile').toBe(0xFFFE);
  });

  it('IM 1 : saute au vecteur 0x0038', () => {
    resetMachine({ intStatus: 1 });
    m.load([0xED, 0x56], 0x0100);      // IM 1
    m.step();
    expect(m.cpu.regIM).toBe(1);

    m.cpu.regPC = 0x0100;
    m.cpu.iff1 = 1;
    m.intStatus = 1;
    m.step();

    expect(m.cpu.regPC, 'IM 1 saute à 0x0038').toBe(0x0038);
    expect(m.getReg16('SP'), 'IM 1 empile PC').toBe(0xFFFC);
    expect(m.mem[0xFFFD], 'octet haut de PC').toBe(0x01);
    expect(m.mem[0xFFFC], 'octet bas de PC').toBe(0x00);
    expect(m.cpu.iff1, 'IFF1 doit être remis à 0').toBe(0);
    expect(m.cpu.iff2, 'IFF2 doit recopier IFF1').toBe(0);
  });

  it('IM 2 : construit le vecteur I<<8 | bus', () => {
    resetMachine({ irqVector: 0x34, intStatus: 1 });
    m.load([0xED, 0x5E], 0x0100);      // IM 2
    m.step();
    expect(m.cpu.regIM).toBe(2);

    m.cpu.regI = 0x91;
    m.cpu.regPC = 0x0100;
    m.cpu.iff1 = 1;
    m.intStatus = 1;
    // Table de vecteurs : (I<<8)|bus = 0x9134
    m.mem[0x9134] = 0x78;
    m.mem[0x9135] = 0x56;

    m.step();

    expect(m.cpu.regPC, 'IM 2 saute via la table de vecteurs').toBe(0x5678);
    expect(m.getReg16('SP')).toBe(0xFFFC);
  });

  it('ED 46/4E/66/6E mettent IM 0 ; ED 56/76 mettent IM 1 ; ED 5E/7E mettent IM 2', () => {
    const table = [
      { opcodes: [0x46, 0x4E, 0x66, 0x6E], expected: 0 },
      { opcodes: [0x56, 0x76], expected: 1 },
      { opcodes: [0x5E, 0x7E], expected: 2 },
    ];

    for (const { opcodes, expected } of table) {
      for (const op of opcodes) {
        resetMachine();
        m.cpu.regIM = 7; // valeur sentinelle
        m.load([0xED, op], 0x0100);
        m.step();
        expect(m.cpu.regIM, `ED ${op.toString(16).padStart(2, '0')}`).toBe(expected);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NMI
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — NMI', () => {
  it('sautes à 0x0066, empile PC et désactive IFF1', () => {
    resetMachine();
    m.cpu.regPC = 0x0100;
    m.cpu.iff1 = 1;
    m.cpu.iff2 = 1;
    m.cpu.doNMI();

    expect(m.cpu.regPC).toBe(0x0066);
    expect(m.cpu.iff1, 'NMI désactive IFF1').toBe(0);
    expect(m.getReg16('SP')).toBe(0xFFFC);
    expect(m.mem[0xFFFD]).toBe(0x01);
    expect(m.mem[0xFFFC]).toBe(0x00);
  });

  it('n\'est pas masquable par DI', () => {
    resetMachine();
    m.load([0xF3], 0x0100); // DI
    m.step();
    expect(m.cpu.iff1).toBe(0);

    m.cpu.doNMI();
    expect(m.cpu.regPC, 'le NMI doit être pris même avec IFF1 à 0').toBe(0x0066);
  });

  it('incrémente le compteur R', () => {
    resetMachine();
    m.cpu.regR = 0x10;
    m.cpu.doNMI();
    expect(m.cpu.regR).toBe(0x11);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RETI / RETN
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — RETI et RETN', () => {
  it('RETI restaure IFF1 depuis IFF2', () => {
    resetMachine();
    m.cpu.regIM = 1;
    m.cpu.iff1 = 1;
    m.cpu.iff2 = 0;
    m.cpu.regSP = 0xFFFC;
    m.mem[0xFFFC] = 0x34;
    m.mem[0xFFFD] = 0x12;

    m.load([0xED, 0x4D], 0x0100); // RETI
    m.step();

    expect(m.cpu.regPC).toBe(0x1234);
    expect(m.cpu.iff1, 'RETI restaure IFF1 depuis IFF2 (0)').toBe(0);
  });

  it('RETI avec IFF2 à 1 réactive les interruptions', () => {
    resetMachine();
    m.cpu.iff1 = 0;
    m.cpu.iff2 = 1;
    m.cpu.regSP = 0xFFFC;
    m.mem[0xFFFC] = 0x00;
    m.mem[0xFFFD] = 0x20;

    m.load([0xED, 0x4D], 0x0100); // RETI
    m.step();
    expect(m.cpu.iff1).toBe(1);
  });

  it('RETN restore lui aussi IFF1 depuis IFF2', () => {
    resetMachine();
    m.cpu.iff1 = 1;
    m.cpu.iff2 = 0;
    m.cpu.regSP = 0xFFFC;
    m.mem[0xFFFC] = 0x00;
    m.mem[0xFFFD] = 0x30;

    m.load([0xED, 0x45], 0x0100); // RETN
    m.step();

    expect(m.cpu.regPC).toBe(0x3000);
    expect(m.cpu.iff1).toBe(0);
  });

  it('les huit variantes RETN/RETI de la colonne ED se comportent identiquement', () => {
    const opcodes = [0x45, 0x4D, 0x55, 0x5D, 0x65, 0x6D, 0x75, 0x7D];
    for (const op of opcodes) {
      resetMachine();
      m.cpu.iff1 = 1;
      m.cpu.iff2 = 0;
      m.cpu.regSP = 0xFFFC;
      m.mem[0xFFFC] = 0x11;
      m.mem[0xFFFD] = 0x22;

      m.load([0xED, op], 0x0100);
      m.step();

      expect(m.cpu.regPC, `ED ${op.toString(16)}`).toBe(0x2211);
      expect(m.cpu.iff1, `ED ${op.toString(16)} doit restaurer IFF1`).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HALT
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — HALT', () => {
  it('bloque le compteur de programme et n\'exécute rien d\'autre', () => {
    resetMachine();
    m.load([0x76, 0x3C], 0x0100); // HALT ; INC A
    m.setReg8('A', 0x10);

    m.step();
    expect(m.cpu.isHalted).toBe(true);
    expect(m.getReg8('A'), 'INC A ne doit pas être exécuté').toBe(0x10);
  });

  it('reprend sur l\'instruction suivante lorsqu\'une interruption survient', () => {
    resetMachine({ intStatus: 0 }); // pas d'interruption pendant le HALT lui-même
    m.load([0x76], 0x0100);
    m.cpu.regPC = 0x0100;

    m.step();
    expect(m.cpu.isHalted).toBe(true);

    // L'interruption doit réveiller le CPU et libérer la ligne.
    m.cpu.regIM = 1;
    m.cpu.iff1 = 1;
    m.intStatus = 1;
    m.step();

    expect(m.cpu.isHalted, 'le CPU doit sortir de HALT').toBe(false);
    expect(m.cpu.regPC, 'IM 1 doit alors vecteriser à 0x0038').toBe(0x0038);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Registre R
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — compteur interne R', () => {
  it('s\'incrémente à chaque lecture d\'opcode et préserve le bit 7', () => {
    resetMachine();
    m.load([0x00, 0x00, 0x00], 0x0100); // trois NOP

    m.step();
    expect(m.cpu.regR).toBe(0x01);
    m.step();
    expect(m.cpu.regR).toBe(0x02);
    m.step();
    expect(m.cpu.regR).toBe(0x03);
  });

  it('le bit 7 de R est préservé quand il est déjà positionné', () => {
    resetMachine();
    m.load([0x00], 0x0100);
    m.cpu.regR = 0x85; // bit 7 = 1
    m.step();
    // Seuls les bits 0..6 sont incrémentés ; le bit 7 est recopié tel quel.
    expect(m.cpu.regR).toBe(0x86);
  });

  it('les bits 0..6 bouclent de 0x7F à 0x00', () => {
    resetMachine();
    m.load([0x00], 0x0100);
    m.cpu.regR = 0x7F;
    m.step();
    expect(m.cpu.regR, '0x7F + 1 = 0x80, dont les bits 0..6 valent 0').toBe(0x00);
  });
});