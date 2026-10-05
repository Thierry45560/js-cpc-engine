/**
 * @file tests/z80/alu.test.mjs
 * @description Conformité différentielle des opérations arithmétiques et logiques.
 *
 * Chaque cas croise le cœur sous test avec une implémentation de référence
 * indépendante (`tests/helpers/z80-reference.mjs`). On ne compare pas à des
 * valeurs figées : un accord sur l'espace d'entrée complet prouve bien plus
 * qu'une table d'attentes, et un désaccord localise l'instruction fautive.
 *
 * Périmètre : ADD, ADC, SUB, SBC, AND, XOR, OR, CP — forms « registre »,
 * « immédiat » et « (HL) ». Rapport de couverture en fin de fichier.
 */

import { describe, it, expect } from 'vitest';
import { TestMachine } from '../helpers/z80-harness.mjs';
import * as R from '../helpers/z80-reference.mjs';

/**
 * Encodage Z80 des 3 bits bas d'un opcode source.
 * Index → registre. `null` = (HL), traité séparément.
 */
const SRC_REG = ['B', 'C', 'D', 'E', 'H', 'L', null, 'A'];

/** Octets de base des 8 opérations ALU, colonne de droite du tableau Z80. */
const ALU_BASE = {
  ADD: 0x80, ADC: 0x88, SUB: 0x90, SBC: 0x98,
  AND: 0xA0, XOR: 0xA8, OR: 0xB0, CP: 0xB8,
};

/** Table de dispatch des opérations, indexée par nom. */
const ALU_REF = {
  ADD: (a, b) => R.refAdd(a, b, 0),
  ADC: (a, b, c) => R.refAdd(a, b, c),
  SUB: (a, b) => R.refSub(a, b, 0),
  SBC: (a, b, c) => R.refSub(a, b, c),
  AND: (a, b) => R.refAnd(a, b),
  XOR: (a, b) => R.refXor(a, b),
  OR: (a, b) => R.refOr(a, b),
  CP: (a, b) => ({ a, f: R.refCp(a, b) }),
};

/**
 * Prépare une machine réutilisable pour une boucle d'exécution dense.
 *
 * Réutiliser une seule instance est crucial : `new Z80_CPU()` construit
 * 5 tables de 256 entrées (1 280 closures). En créer 2,7 millions
 * pendant le test prendrait plusieurs minutes.
 *
 * @returns {TestMachine}
 */
function reusableMachine() {
  return new TestMachine();
}

/**
 * Exécute une instruction unique à 0x0100 sur une machine déjà configurée.
 * @param {TestMachine} m
 * @param {number[]} code opcodes + opérandes
 * @param {Function} setup état initial (registres)
 */
function execAt(m, code, setup) {
  m.cpu.regPC = 0x0100;
  m.cpu.ioWriteState = 0;
  m.load(code, 0x0100);
  if (setup) setup();
  m.step();
}

/** Les 8 opérations, avec la liste des retenues d'entrée à couvrir. */
const OPERATIONS = Object.keys(ALU_BASE).map((name) => ({
  name,
  base: ALU_BASE[name],
  ref: ALU_REF[name],
  carries: name === 'ADC' || name === 'SBC' ? [0, 1] : [0],
}));

describe('Z80 — ALU 8 bits, forme « registre »', () => {
  for (const op of OPERATIONS) {
    it(`${op.name} A,r converge avec la référence sur 256×256`, () => {
      const m = reusableMachine();
      const divergences = [];

      for (let t = 0; t < 8; t++) {
        const reg = SRC_REG[t];
        if (reg === null) continue; // (HL) — cf. suite dédiée

        m.mem[0x0100] = op.base | t;

        for (let a = 0; a < 256; a++) {
          for (let v = 0; v < 256; v++) {
            // ADD A,A : l'opérande EST l'accumulateur — une seule valeur.
            const acc = reg === 'A' ? v : a;

            for (const carryIn of op.carries) {
              execAt(m, [op.base | t], () => {
                m.setReg8('A', acc);
                m.setReg8(reg, v);
                m.setReg8('F', carryIn);
              });

              const expected = op.ref(acc, v, carryIn);
              const gotA = m.getReg8('A');
              const gotF = m.getReg8('F');

              const ok = op.name === 'CP'
                ? gotF === expected.f // CP ne modifie pas A
                : gotA === expected.a && gotF === expected.f;

              if (!ok && divergences.length < 5) {
                divergences.push(
                  `A=0x${acc.toString(16)} ${reg}=0x${v.toString(16)} C=${carryIn} → ` +
                  `A: 0x${gotA.toString(16)}≠0x${expected.a.toString(16)}, ` +
                  `F: ${R.formatFlags(gotF)}≠${R.formatFlags(expected.f)}`,
                );
              }
            }
          }
        }
      }

      expect(divergences, divergences.join('\n')).toEqual([]);
    });
  }
});

describe('Z80 — ALU 8 bits, forme « immédiat » (n)', () => {
  for (const op of OPERATIONS) {
    it(`${op.name} A,n converge avec la référence`, () => {
      const m = reusableMachine();
      // Colonne « n » du tableau Z80 : 0xC0 | base (ADD A,n = 0xC6, CP n = 0xFE).
      const immediateBase = op.base | 0xC6;
      const divergences = [];

      for (let a = 0; a < 256; a++) {
        for (let v = 0; v < 256; v++) {
          for (const carryIn of op.carries) {
            execAt(m, [immediateBase, v], () => {
              m.setReg8('A', a);
              m.setReg8('F', carryIn);
            });

            const expected = op.ref(a, v, carryIn);
            const gotA = m.getReg8('A');
            const gotF = m.getReg8('F');

            const ok = op.name === 'CP'
              ? gotF === expected.f
              : gotA === expected.a && gotF === expected.f;

            if (!ok && divergences.length < 5) {
              divergences.push(
                `A=0x${a.toString(16)} n=0x${v.toString(16)} C=${carryIn} → ` +
                `F: ${R.formatFlags(gotF)}≠${R.formatFlags(expected.f)}`,
              );
            }
          }
        }
      }

      expect(divergences, divergences.join('\n')).toEqual([]);
    });
  }
});

describe('Z80 — ALU 8 bits, forme « (HL) »', () => {
  it('lit la valeur en mémoire pointée par HL et applique la même sémantique', () => {
    const m = reusableMachine();
    const divergences = [];

    for (const op of OPERATIONS) {
      const opcode = op.base | 0x06;

      for (let a = 0; a < 256; a++) {
        for (let v = 0; v < 256; v++) {
          for (const carryIn of op.carries) {
            execAt(m, [opcode], () => {
              m.mem[0x4000] = v;
              m.setReg16('HL', 0x4000);
              m.setReg8('A', a);
              m.setReg8('F', carryIn);
            });

            const expected = op.ref(a, v, carryIn);
            const gotA = m.getReg8('A');
            const gotF = m.getReg8('F');

            const ok = op.name === 'CP'
              ? gotF === expected.f
              : gotA === expected.a && gotF === expected.f;

            if (!ok && divergences.length < 5) {
              divergences.push(
                `${op.name} A=0x${a.toString(16)} (HL)=0x${v.toString(16)} → ` +
                `F: ${R.formatFlags(gotF)}≠${R.formatFlags(expected.f)}`,
              );
            }
          }
        }
      }
    }

    expect(divergences, divergences.join('\n')).toEqual([]);
  });
});

describe('Z80 — invariants de drapeaux spécifiques à l\'ALU', () => {
  const m = reusableMachine();

  it('ADD laisse toujours N à 0', () => {
    for (let a = 0; a < 256; a += 7) {
      // ADD A,B — second registre réel, F rentrant à 0xFF.
      execAt(m, [0x80], () => {
        m.setReg8('A', a);
        m.setReg8('B', 0x33);
        m.setReg8('F', 0xFF);
      });
      expect(m.flags.N, `ADD avec A=0x${a.toString(16)} a mis N`).toBe(0);
    }
  });

  it('SUB et CP mettent toujours N à 1', () => {
    for (const [name, base] of [['SUB', 0x90], ['CP', 0xB8]]) {
      for (let a = 0; a < 256; a += 7) {
        execAt(m, [base], () => { // SUB B / CP B
          m.setReg8('A', a);
          m.setReg8('B', 0x11);
          m.setReg8('F', 0x00);
        });
        expect(m.flags.N, `${name} n'a pas mis N`).toBe(1);
      }
    }
  });

  it('AND met H à 1 et C à 0 ; OR/XOR remettent H et C à 0', () => {
    execAt(m, [0xA7], () => { m.setReg8('A', 0xFF); m.setReg8('F', 0xFF); });
    expect(m.flags.H, 'AND doit mettre H').toBe(1);
    expect(m.flags.C, 'AND doit remettre C à 0').toBe(0);

    for (const base of [0xB0, 0xA8]) {
      execAt(m, [base], () => { // OR B / XOR B
        m.setReg8('A', 0xFF);
        m.setReg8('B', 0xFF);
        m.setReg8('F', 0xFF);
      });
      expect(m.flags.H).toBe(0);
      expect(m.flags.C).toBe(0);
    }
  });

  it('AND/OR/XOR positionnent PV selon la parité du résultat', () => {
    // Chaque cas donne des opérandes produisant une valeur cible connue.
    // AND exige A=0xFF (A & 0 = 0 sinon) ; XOR/OR partent de A=0.
    const cases = [
      { name: 'AND', base: 0xA0, even: [0x00, 0x00], odd: [0xFF, 0x01] },
      { name: 'XOR', base: 0xA8, even: [0x00, 0x00], odd: [0x00, 0x01] },
      { name: 'OR', base: 0xB0, even: [0x00, 0x00], odd: [0x00, 0x01] },
    ];

    for (const { name, base, even, odd } of cases) {
      // Résultat 0x00 → parité paire → PV = 1
      execAt(m, [base], () => { // …B : un vrai second registre, sinon XOR A,A = 0
        m.setReg8('A', even[0]);
        m.setReg8('B', even[1]);
        m.setReg8('F', 0x00);
      });
      expect(m.getReg8('A'), `${name} : résultat attendu 0x00`).toBe(0x00);
      expect(m.flags.PV, `${name} : parité paire → PV=1`).toBe(1);

      // Résultat 0x01 → parité impaire → PV = 0
      execAt(m, [base], () => {
        m.setReg8('A', odd[0]);
        m.setReg8('B', odd[1]);
        m.setReg8('F', 0x00);
      });
      expect(m.getReg8('A'), `${name} : résultat attendu 0x01`).toBe(0x01);
      expect(m.flags.PV, `${name} : parité impaire → PV=0`).toBe(0);
    }
  });

  it('ADC et SBC prennent en compte la retenue entrante', () => {
    // 0xFF + 0x00 + 1 = 0x00 avec C=1 et Z=1  (ADC A,C : opcode 0x89)
    execAt(m, [0x89], () => { m.setReg8('A', 0xFF); m.setReg8('C', 0x00); m.setReg8('F', 0x01); });
    expect(m.getReg8('A')).toBe(0x00);
    expect(m.flags.Z).toBe(1);
    expect(m.flags.C).toBe(1);

    // Même opération sans la retenue → 0xFF, pas de Z
    execAt(m, [0x89], () => { m.setReg8('A', 0xFF); m.setReg8('C', 0x00); m.setReg8('F', 0x00); });
    expect(m.getReg8('A')).toBe(0xFF);
    expect(m.flags.Z).toBe(0);
  });

  it('signale le débordement hors plage signée', () => {
    // 0x7F + 0x01 = 0x80 : overflow
    execAt(m, [0x80], () => { m.setReg8('A', 0x7F); m.setReg8('B', 0x01); m.setReg8('F', 0); });
    expect(m.flags.PV, '0x7F+1 doit overflow').toBe(1);
    expect(m.flags.S).toBe(1);

    // 0xFF + 0x01 = 0x00 : pas d'overflow (unsigned wraparound)
    execAt(m, [0x80], () => { m.setReg8('A', 0xFF); m.setReg8('B', 0x01); m.setReg8('F', 0); });
    expect(m.flags.PV, '0xFF+1 ne doit pas overflow').toBe(0);
  });
});