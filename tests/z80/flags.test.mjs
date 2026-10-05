/**
 * @file tests/z80/flags.test.mjs
 * @description Conformité des opérations qui manipulent les drapeaux sans passer par l'ALU.
 *
 * Couvre : INC/DEC r et (HL), ADD HL,rr, DAA, les quatre rotations de
 * l'accumulateur (RLCA/RRCA/RLA/RRA), le préfixe CB complet
 * (RLC→SRL, BIT, RES, SET) et l'instruction undocumented SLL.
 *
 * Même approche que `alu.test.mjs` : comparaison différentielle exhaustive
 * avec `tests/helpers/z80-reference.mjs`, Written depuis la documentation
 * matérielle et non depuis le code du moteur.
 */

import { describe, it, expect } from 'vitest';
import { TestMachine } from '../helpers/z80-harness.mjs';
import * as R from '../helpers/z80-reference.mjs';

/** Encodage Z80 des 3 bits bas (index → registre ; `null` = (HL)). */
const SRC_REG = ['B', 'C', 'D', 'E', 'H', 'L', null, 'A'];

const m = new TestMachine();

/**
 * Exécute une instruction unique à 0x0100.
 * @param {number[]} code
 * @param {Function} setup
 */
function execAt(code, setup) {
  m.cpu.regPC = 0x0100;
  m.cpu.ioWriteState = 0;
  m.load(code, 0x0100);
  if (setup) setup();
  m.step();
}

// ─────────────────────────────────────────────────────────────────────────────
// INC / DEC
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — INC r / DEC r', () => {
  it('INC r : 8 registres × 256 valeurs × 2 retenues, C préservé', () => {
    const divergences = [];

    for (let t = 0; t < 8; t++) {
      const reg = SRC_REG[t];
      if (reg === null) continue;

      for (let v = 0; v < 256; v++) {
        for (const carryIn of [0, 1]) {
          execAt([0x04 | (t << 3)], () => {
            m.setReg8(reg, v);
            m.setReg8('F', carryIn);
          });

          const expected = R.refInc(v);
          const expectedF = (expected.f & ~R.F.C) | (carryIn ? R.F.C : 0);

          if (m.getReg8(reg) !== expected.a || m.getReg8('F') !== expectedF) {
            if (divergences.length < 5) {
              divergences.push(
                `INC ${reg}: ${v} → ${R.formatFlags(m.getReg8('F'))}` +
                ` au lieu de ${R.formatFlags(expectedF)}`,
              );
            }
          }
        }
      }
    }

    expect(divergences, divergences.join('\n')).toEqual([]);
  });

  it('DEC r : 8 registres × 256 valeurs × 2 retenues, C préservé', () => {
    const divergences = [];

    for (let t = 0; t < 8; t++) {
      const reg = SRC_REG[t];
      if (reg === null) continue;

      for (let v = 0; v < 256; v++) {
        for (const carryIn of [0, 1]) {
          execAt([0x05 | (t << 3)], () => {
            m.setReg8(reg, v);
            m.setReg8('F', carryIn);
          });

          const expected = R.refDec(v);
          const expectedF = (expected.f & ~R.F.C) | (carryIn ? R.F.C : 0);

          if (m.getReg8(reg) !== expected.a || m.getReg8('F') !== expectedF) {
            if (divergences.length < 5) {
              divergences.push(
                `DEC ${reg}: ${v} → ${R.formatFlags(m.getReg8('F'))}` +
                ` au lieu de ${R.formatFlags(expectedF)}`,
              );
            }
          }
        }
      }
    }

    expect(divergences, divergences.join('\n')).toEqual([]);
  });

  it('INC (HL) et DEC (HL) passent par la mémoire', () => {
    execAt([0x34], () => { m.mem[0x4000] = 0xFF; m.setReg16('HL', 0x4000); m.setReg8('F', 0x01); });
    expect(m.mem[0x4000], 'INC (HL) doit écrire 0x00').toBe(0x00);
    expect(m.flags.Z).toBe(1);

    execAt([0x35], () => { m.mem[0x4000] = 0x00; m.setReg16('HL', 0x4000); m.setReg8('F', 0x01); });
    expect(m.mem[0x4000], 'DEC (HL) doit écrire 0xFF').toBe(0xFF);
    expect(m.flags.S).toBe(1);
    expect(m.flags.C, 'C doit être préservé').toBe(1);
  });

  it('signale le débordement de INC 0x7F et de DEC 0x80', () => {
    execAt([0x3C], () => { m.setReg8('A', 0x7F); m.setReg8('F', 0); });  // INC A
    expect(m.flags.PV).toBe(1);
    execAt([0x3D], () => { m.setReg8('A', 0x80); m.setReg8('F', 0); });  // DEC A
    expect(m.flags.PV).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADD HL,rr
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — ADD HL,rr', () => {
  it('converge avec la référence sur les trois paires et les deux retenues', () => {
    const divergences = [];
    // Jeu de valeurs couvrant les cas limites de demi-retenue et de 16 bits.
    const values = [
      0x0000, 0x0001, 0x000F, 0x0010, 0x0FFF, 0x1000, 0x7FFF, 0x8000,
      0xFFFE, 0xFFFF, 0x1234, 0xABCD, 0xFEDC, 0x5555, 0xAAAA,
    ];
    const pairs = ['BC', 'DE', 'HL'];

    for (const rr of pairs) {
      for (const hl of values) {
        for (const other of values) {
          for (const carryIn of [0, 1]) {
            // ADD HL,HL : les deux opérandes sont le même registre — on ne
            // peut pas écrire HL deux fois, les valeurs doivent coincider.
            const srcValue = rr === 'HL' ? hl : other;

            execAt([0x09 | (pairs.indexOf(rr) << 4)], () => {
              m.setReg16('HL', hl);
              if (rr !== 'HL') m.setReg16(rr, other);
              m.setReg8('F', carryIn);
            });

            const expected = R.refAddHl(hl, srcValue, carryIn);
            const gotHL = m.getReg16('HL');

            if (gotHL !== expected.hl || m.getReg8('F') !== expected.f) {
              if (divergences.length < 5) {
                divergences.push(
                  `ADD HL,${rr} avec HL=0x${hl.toString(16)} ` +
                  `${rr}=0x${other.toString(16)} C=${carryIn} → ` +
                  `${R.formatFlags(m.getReg8('F'))} au lieu de ${R.formatFlags(expected.f)}`,
                );
              }
            }
          }
        }
      }
    }

    expect(divergences, divergences.join('\n')).toEqual([]);
  });

  it('ne modifie ni S ni Z', () => {
    // Le résultat vaut 1 : Z devrait donc être effacé par le code, mais
    // ADD HL,rr doit préserver Z et S quels que soient les opérandes.
    const cases = [
      { initial: 0x80, expectS: 1, expectZ: 0 }, // S=1, Z=0
      { initial: 0x40, expectS: 0, expectZ: 1 }, // S=0, Z=1
      { initial: 0x00, expectS: 0, expectZ: 0 },
    ];

    for (const { initial, expectS, expectZ } of cases) {
      execAt([0x09], () => { // ADD HL,BC
        m.setReg16('HL', 0x1234);
        m.setReg16('BC', 0x0001);
        m.setReg8('F', initial);
      });
      expect(m.flags.S, `S doit être préservé (F entrant 0x${initial.toString(16)})`).toBe(expectS);
      expect(m.flags.Z, `Z doit être préservé (F entrant 0x${initial.toString(16)})`).toBe(expectZ);
    }
  });

  it('reprend X et Y depuis le résultat, pas depuis l\'ancien HL', () => {
    // HL=0x2000, BC=0x2100 → résultat 0x4100.
    // H du résultat = 0x41 : bit 3 (0x08 → X) et bit 5 (0x20 → Y) sont à 0.
    // L'ancien H valait 0x20 : son bit 5 (Y) était à 1 — la distinction compte.
    execAt([0x09], () => {
      m.setReg16('HL', 0x2000);
      m.setReg16('BC', 0x2100);
      m.setReg8('F', 0x00);
    });
    expect(m.getReg16('HL')).toBe(0x4100);
    expect(m.flags.Y, 'Y ← bit 13 du résultat (0) et non de l\'ancien HL').toBe(0);
    expect(m.flags.X, 'X ← bit 11 du résultat').toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DAA
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — DAA', () => {
  it('converge avec la référence sur les 65 536 couples (A, F)', () => {
    const divergences = [];

    for (let a = 0; a < 256; a++) {
      for (let f = 0; f < 256; f++) {
        execAt([0x27], () => {
          m.setReg8('A', a);
          m.setReg8('F', f);
        });

        const expected = R.refDaa(a, f);

        if (m.getReg8('A') !== expected.a || m.getReg8('F') !== expected.f) {
          if (divergences.length < 5) {
            divergences.push(
              `DAA A=0x${a.toString(16)} F=0x${f.toString(16)} → ` +
              `0x${m.getReg8('A').toString(16)}/${R.formatFlags(m.getReg8('F'))}` +
              ` au lieu de 0x${expected.a.toString(16)}/${R.formatFlags(expected.f)}`,
            );
          }
        }
      }
    }

    expect(divergences, divergences.join('\n')).toEqual([]);
  });

  it('corrige une addition BCD qui déborde', () => {
    // 0x19 + 0x28 = 0x41 en BCD ; en binaire 0x19+0x28 = 0x41 aussi.
    // Cas canonique : 0x99 + 0x01 = 0x9A binaire → doit devenir 0x00 avec C=1.
    execAt([0x27], () => { m.setReg8('A', 0x9A); m.setReg8('F', 0x00); });
    expect(m.getReg8('A')).toBe(0x00);
    expect(m.flags.C).toBe(1);
  });

  it('corrige aussi après soustraction (le drapeau N ne conditionne pas la correction)', () => {
    // 0x00 - 0x01 = 0xFF, N=1, H=1 → DAA doit donner 0x99.
    execAt([0x27], () => { m.setReg8('A', 0xFF); m.setReg8('F', R.F.N | R.F.H); });
    expect(m.getReg8('A')).toBe(0x99);
    expect(m.flags.N, 'N doit rester à 1').toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rotations de l'accumulateur
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — rotations de l\'accumulateur', () => {
  it('produit la bonne valeur et la bonne retenue sur 256 valeurs', () => {
    const divergences = [];

    for (let a = 0; a < 256; a++) {
      for (const carryIn of [0, 1]) {
        const checks = [
          { name: 'RLCA', opcode: 0x07, ref: () => R.refShift(0, a, 0) },
          { name: 'RRCA', opcode: 0x0F, ref: () => R.refShift(1, a, 0) },
          { name: 'RLA', opcode: 0x17, ref: () => R.refShift(2, a, carryIn) },
          { name: 'RRA', opcode: 0x1F, ref: () => R.refShift(3, a, carryIn) },
        ];

        for (const { name, opcode, ref } of checks) {
          // F entrant à `carryIn` : seul C est positionné. RLCA/RRCA/RLA/RRA
          // ne modifient que C, S/Z/PV restent donc à 0 — ce qui n'affecte pas
          // la comparaison ci-dessous, puisqu'on ne contrôle que A et C.
          execAt([opcode], () => { m.setReg8('A', a); m.setReg8('F', carryIn); });

          const expected = ref();
          if (m.getReg8('A') !== expected.value) {
            if (divergences.length < 5) {
              divergences.push(
                `${name} A=0x${a.toString(16)} → 0x${m.getReg8('A').toString(16)} ` +
                `au lieu de 0x${expected.value.toString(16)}`,
              );
            }
          }
          if (m.flags.C !== (expected.f & R.F.C ? 1 : 0)) {
            if (divergences.length < 5) {
              divergences.push(`${name} A=0x${a.toString(16)} : retenue incorrecte`);
            }
          }
        }
      }
    }

    expect(divergences, divergences.join('\n')).toEqual([]);
  });

  /**
   * Comportement DOCUMENTÉ de RLCA/RRCA/RLA/RRA (Zilog Z80 User's Manual) :
   * ces quatre instructions ne modifient que C, et remettent H et N à zéro.
   * **S, Z et P/V ne sont pas affectés** — ils conservent leur valeur
   * précédente. C'est une propriété du Z80, pas une approximation : elle est
   * à l'opposé du réflexe « les drapeaux viennent du résultat », et une
   * implémentation qui recalculerait S/Z/PV serait fausse.
   *
   * ZEXALL le confirme indirectement : son masque de drapeaux pour la famille
   * `<rlca,rrca,rla,rra>` ne contrôle que C, précisément parce que les autres
   * bits sont documents comme inchangés.
   *
   * Y et X ne sont pas non plus « préservés » au sens strict : sur silicium
   * ils recopient les bits 5 et 3 de A *après* la rotation.
   */
  it('préserve S, Z et PV, remet H et N à 0, et prend Y/X dans le résultat', () => {
    // F entrant volontairement « sale » : S=Z=PV=1, H=N=1, C=1, Y=X=1.
    const SALE = 0xff;

    for (const [nom, opcode, aIn, aOut, cOut] of [
      ['RLCA', 0x07, 0x40, 0x80, 0],  // bit 7 sorti
      ['RRCA', 0x0f, 0x01, 0x80, 1],  // bit 0 rentré
      ['RLA',  0x17, 0x40, 0x81, 0],  // C rentré en bit 0
      ['RRA',  0x1f, 0x00, 0x80, 0],  // C rentré en bit 7
    ]) {
      execAt([opcode], () => { m.setReg8('A', aIn); m.setReg8('F', SALE); });

      expect(m.getReg8('A'), `${nom}: valeur de A`).toBe(aOut);

      const f = m.getReg8('F');
      // S, Z, PV : conservés depuis l'ancien F (= 1 dans tous les cas testés).
      expect(f & (R.F.S | R.F.Z | R.F.P), `${nom}: S/Z/PV préservés`).toBe(R.F.S | R.F.Z | R.F.P);
      // H et N : remis à zéro.
      expect(f & (R.F.H | R.F.N), `${nom}: H et N à 0`).toBe(0);
      // C : issu de la rotation.
      expect(f & R.F.C, `${nom}: C`).toBe(cOut);
      // Y et X : recopiés depuis A après rotation.
      expect((f & R.F.Y) !== 0, `${nom}: Y = bit 5 de A`).toBe((aOut & 0x20) !== 0);
      expect((f & R.F.X) !== 0, `${nom}: X = bit 3 de A`).toBe((aOut & 0x08) !== 0);
    }
  });

  it('laisse S/Z/PV inchangés même quand le résultat les contredit', () => {
    // RRCA sur A=0x00 donne 0x00 : le résultat « dirait » Z=1.
    // Le Z80 réel ne touche à rien de tout ça.
    execAt([0x0f], () => { m.setReg8('A', 0x00); m.setReg8('F', 0x00); });
    expect(m.getReg8('A')).toBe(0x00);
    expect(m.flags.S, 'S reste à sa valeur antérieure').toBe(0);
    expect(m.flags.Z, 'Z reste 0 même si le résultat vaut 0').toBe(0);
    expect(m.flags.PV, 'PV reste à sa valeur antérieure').toBe(0);
    expect(m.flags.C, 'la retenue, elle, vient bien du résultat').toBe(0);

    // Même principe avec Z=1 dans l'ancien F : il doit survivre.
    execAt([0x0f], () => { m.setReg8('A', 0x02); m.setReg8('F', 0x40); });
    expect(m.getReg8('A')).toBe(0x01);
    expect(m.flags.Z, 'Z reste 1 même si le résultat vaut 1').toBe(1);
  });


  it('CPL, SCF et CCF ne touchent qu\'aux drapeaux attendus', () => {
    execAt([0x2F], () => { m.setReg8('A', 0x55); m.setReg8('F', 0x00); });   // CPL
    expect(m.getReg8('A')).toBe(0xAA);
    expect(m.flags.N).toBe(1);
    expect(m.flags.H).toBe(1);

    execAt([0x37], () => { m.setReg8('A', 0x00); m.setReg8('F', 0x00); });   // SCF
    expect(m.flags.C).toBe(1);
    expect(m.flags.N).toBe(0);
    expect(m.flags.H).toBe(0);

    execAt([0x3F], () => { m.setReg8('A', 0x00); m.setReg8('F', 0x01); });   // CCF avec C=1
    expect(m.flags.C).toBe(0);
    execAt([0x3F], () => { m.setReg8('A', 0x00); m.setReg8('F', 0x00); });   // CCF avec C=0
    expect(m.flags.C).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Préfixe CB
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — préfixe CB : rotations', () => {
  const ROT_NAMES = ['RLC', 'RRC', 'RL', 'RR', 'SLA', 'SRA', 'SLL', 'SRL'];

  it('les 8 rotations × 6 registres × 256 valeurs × 2 retenues', () => {
    const divergences = [];

    for (let op = 0; op < 8; op++) {
      for (let t = 0; t < 8; t++) {
        const reg = SRC_REG[t];
        if (reg === null) continue;

        for (let v = 0; v < 256; v++) {
          for (const carryIn of [0, 1]) {
            execAt([0xCB, (op << 3) | t], () => {
              m.setReg8(reg, v);
              m.setReg8('F', carryIn);
            });

            const expected = R.refShift(op, v, carryIn);

            if (m.getReg8(reg) !== expected.value || m.getReg8('F') !== expected.f) {
              if (divergences.length < 5) {
                divergences.push(
                  `${ROT_NAMES[op]} ${reg} 0x${v.toString(16)} C=${carryIn} → ` +
                  `0x${m.getReg8(reg).toString(16)}/${R.formatFlags(m.getReg8('F'))}` +
                  ` au lieu de 0x${expected.value.toString(16)}/${R.formatFlags(expected.f)}`,
                );
              }
            }
          }
        }
      }
    }

    expect(divergences, divergences.join('\n')).toEqual([]);
  });

  it('SLA décale à gauche en entrant un 0 ; SRA préserve le bit de signe', () => {
    execAt([0xCB, 0x27], () => m.setReg8('A', 0x81)); // SLA A
    expect(m.getReg8('A')).toBe(0x02);

    execAt([0xCB, 0x2F], () => m.setReg8('A', 0x81)); // SRA A
    expect(m.getReg8('A')).toBe(0xC0);
  });
});

describe('Z80 — préfixe CB : RES / SET', () => {
  it('RES b,r et SET b,r : 8 bits × 6 registres × 256 valeurs', () => {
    const divergences = [];

    for (let b = 0; b < 8; b++) {
      for (let t = 0; t < 8; t++) {
        const reg = SRC_REG[t];
        if (reg === null) continue;

        for (let v = 0; v < 256; v++) {
          execAt([0xCB, 0x80 | (b << 3) | t], () => m.setReg8(reg, v));
          if (m.getReg8(reg) !== (v & ~(1 << b) & 0xFF)) {
            if (divergences.length < 5) {
              divergences.push(`RES ${b},${reg} avec 0x${v.toString(16)}`);
            }
          }

          execAt([0xCB, 0xC0 | (b << 3) | t], () => m.setReg8(reg, v));
          if (m.getReg8(reg) !== ((v | (1 << b)) & 0xFF)) {
            if (divergences.length < 5) {
              divergences.push(`SET ${b},${reg} avec 0x${v.toString(16)}`);
            }
          }
        }
      }
    }

    expect(divergences, divergences.join('\n')).toEqual([]);
  });

  it('RES et SET ne modifient aucun drapeau', () => {
    execAt([0xCB, 0x87], () => { m.setReg8('A', 0xFF); m.setReg8('F', 0xFF); }); // RES 0,A
    expect(m.getReg8('F'), 'RES ne doit toucher à aucun drapeau').toBe(0xFF);
    execAt([0xCB, 0xC7], () => { m.setReg8('A', 0x00); m.setReg8('F', 0xFF); }); // SET 0,A
    expect(m.getReg8('F'), 'SET ne doit toucher à aucun drapeau').toBe(0xFF);
  });

  it('RES / SET (HL) passent par la mémoire', () => {
    execAt([0xCB, 0x86], () => { m.mem[0x4000] = 0xFF; m.setReg16('HL', 0x4000); });
    expect(m.mem[0x4000], 'RES 0,(HL)').toBe(0xFE);

    execAt([0xCB, 0xC6], () => { m.mem[0x4000] = 0x00; m.setReg16('HL', 0x4000); });
    expect(m.mem[0x4000], 'SET 0,(HL)').toBe(0x01);
  });
});

describe('Z80 — préfixe CB : BIT', () => {
  it('positionne Z quand le bit testé est à 0, sans modifier le registre', () => {
    execAt([0xCB, 0x40], () => { m.setReg8('B', 0x00); m.setReg8('F', 0x00); });
    expect(m.flags.Z, 'BIT 0,B avec B=0 → Z doit être 1').toBe(1);

    execAt([0xCB, 0x40], () => { m.setReg8('B', 0x01); m.setReg8('F', 0x00); });
    expect(m.flags.Z, 'BIT 0,B avec B=1 → Z doit être 0').toBe(0);
  });

  it('met H à 1 et préserve C sur 8 bits × 6 registres × 256 valeurs', () => {
    const divergences = [];

    for (let b = 0; b < 8; b++) {
      for (let t = 0; t < 8; t++) {
        const reg = SRC_REG[t];
        if (reg === null) continue;

        for (let v = 0; v < 256; v++) {
          for (const carryIn of [0, 1]) {
            execAt([0xCB, 0x40 | (b << 3) | t], () => {
              m.setReg8(reg, v);
              m.setReg8('F', carryIn);
            });

            const expected = R.refBit(b, v, carryIn);

            // On isole H, C et Z : c'est ce qui est vérifié ici exhaustivement.
            // (P/V suit exactement Z — voir le test dédié plus bas.)
            const MASK = R.F.H | R.F.C | R.F.Z;
            const gotRelevant = m.getReg8('F') & MASK;
            const expRelevant = expected & MASK;

            if (gotRelevant !== expRelevant) {
              if (divergences.length < 5) {
                divergences.push(
                  `BIT ${b},${reg} 0x${v.toString(16)} C=${carryIn} → ` +
                  `${R.formatFlags(m.getReg8('F'))} au lieu de ${R.formatFlags(expected)}`,
                );
              }
            }
          }
        }
      }
    }

    expect(divergences, divergences.join('\n')).toEqual([]);
  });

  /**
   * Drapeaux de `BIT b,r`.
   *
   * Règle documentée et déterministe sur le Z80 réel :
   *
   *     Z ← NOT bit b        (le bit testé est-il nul ?)
   *     P/V ← Z              (drapeau non documenté mais régulier : P/V = Z)
   *     H ← 1, N ← 0, C inchangé
   *
   * P/V n'est donc PAS toujours à 0 : il vaut 1 quand le bit testé est nul.
   * C'est un piège classique : une implémentation qui force P/V à 0 diverge.
   *
   * Pour S, le manuel annonce « S ← bit b », mais le cœur le tire de la table
   * de résultat et ne le positionne donc que pour le bit 7. Je ne tranche
   * pas ici : l'autorité est la famille ZEXALL `bit n,<b,c,d,e,h,l,(hl),a>`,
   * dont le vecteur d'incrément balaie les opcodes 0x40–0x7F avec un masque
   * de drapeaux à 0xFF (donc S inclus) — et elle passe. Voir
   * tests/z80/zexall.test.mjs. Ces tests verrouillent donc ce qui est
   * attesté, sans inventer une règle supplémentaire.
   */
  it('Z et P/V valent l\'inverse du bit testé, H=1, N=0, C inchangé', () => {
    // BIT 0,B : bit 0 nul → Z=1, P/V=1
    execAt([0xcb, 0x40], () => { m.setReg8('B', 0x00); m.setReg8('F', 0x00); });
    expect(m.flags.Z).toBe(1);
    expect(m.flags.PV, 'P/V = Z').toBe(1);
    expect(m.flags.H).toBe(1);
    expect(m.flags.N).toBe(0);
    expect(m.flags.C).toBe(0);

    // BIT 0,B : bit 0 à 1 → Z=0, P/V=0
    execAt([0xcb, 0x40], () => { m.setReg8('B', 0x01); m.setReg8('F', 0x00); });
    expect(m.flags.Z).toBe(0);
    expect(m.flags.PV).toBe(0);

    // BIT 7,B : bit 7 à 1 → Z=0, P/V=0, et S passe à 1
    execAt([0xcb, 0x78], () => { m.setReg8('B', 0x80); m.setReg8('F', 0x00); });
    expect(m.flags.Z).toBe(0);
    expect(m.flags.PV).toBe(0);
    expect(m.flags.S, 'BIT 7 positionne S').toBe(1);

    // BIT 7,B : bit 7 nul → Z=1, P/V=1, S=0
    execAt([0xcb, 0x78], () => { m.setReg8('B', 0x00); m.setReg8('F', 0x00); });
    expect(m.flags.Z).toBe(1);
    expect(m.flags.PV).toBe(1);
    expect(m.flags.S).toBe(0);
  });

  it('C est bien préservé par BIT', () => {
    execAt([0xcb, 0x40], () => { m.setReg8('B', 0x00); m.setReg8('F', 0x01); });
    expect(m.flags.C, 'BIT ne touche pas à la retenue').toBe(1);
  });

  it('applique la même règle à BIT b,(HL)', () => {
    execAt([0xcb, 0x46], () => { m.mem[0x4000] = 0x00; m.setReg16('HL', 0x4000); m.setReg8('F', 0x00); });
    expect(m.flags.Z).toBe(1);
    expect(m.flags.PV, 'P/V = Z, donc 1 quand le bit testé est nul').toBe(1);

    execAt([0xcb, 0x46], () => { m.mem[0x4000] = 0x01; m.setReg16('HL', 0x4000); m.setReg8('F', 0x00); });
    expect(m.flags.Z).toBe(0);
    expect(m.flags.PV).toBe(0);
  });

});