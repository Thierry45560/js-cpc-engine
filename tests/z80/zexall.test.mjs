/**
 * @file tests/z80/zexall.test.mjs
 * @description Suite de conformité ZEXALL du cœur Z80.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI CE TEST EST OPT-IN
 * ─────────────────────────────────────────────────────────────────────────────
 * ZEXALL exécute ~5,8 milliards d'instructions, soit plusieurs minutes sur
 * Node. C'est le prix d'une conformité réelle : la suite parcourt des
 * dizaines de milliers de cas machines et compare un CRC 32 à des valeurs
 * relevées sur du silicium.
 *
 * Il ne tourne donc PAS dans `npm test` (qui reste le feedback quotidien,
 * ~1,6 s). Il se déclenche explicitement :
 *
 *   npm run test:zexall
 *
 * qui pose `ZEXALL=1`. C'est le bon rythme : le travail qui gravite autour du
 * cœur (GateArray, ASIC, CRTC, FDC…) n'a pas à payer 4 minutes à chaque
 * `npm test`, mais toute modification touchant au Z80 — ou toute suspicion
 * de non-régression — se vérifie ici.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RÉSULTAT ATTENDU
 * ─────────────────────────────────────────────────────────────────────────────
 * 67/67 tests « OK », 0 « ERROR », et le programme se termine par son
 * « warm boot » (`jp 0`). Les 67 familles couvrent l'ALU 8 bits, les
 * arithmétiques 16 bits sur BC/DE/HL/SP et IX/IY, les rotations et shifts
 * CB, BIT/RES/SET, lesInstructions indexées (DD/FD/DDCB/FDCB), les
 * registres IXh/IXl/IYh/IYl, LDIR/LDDIR/LDI, DAA/NEG, RRD/RLD, CPD/CPI,
 * et tous lesModes d'adressage.
 *
 * ⚠ CE QUE ZEXALL NE COUVRE PAS : les interruptions, le comptage des
 * T-states, et `INI`/`INIR`/`OUTI`/`OTIR` (absents de la suite d'origine).
 * Ces points restent traités par les autres fichiers de `tests/z80/`.
 */

import { describe, it, expect } from 'vitest';

import {
  ZEXALL_SHA256,
  loadZexallBinary,
  parseZexallOutput,
  runZexall,
} from '../helpers/zexall-runner.mjs';

/** ZEXALL ne s'exécute que sur demande explicite. */
const ENABLED = process.env.ZEXALL === '1';

const describeZexall = ENABLED ? describe : describe.skip;

describe('ZEXALL — infrastructure', () => {
  // Ces tests sont instantanés : ils tournent dans `npm test` comme en
  // mode ZEXALL, et valident l'infrastructure (binaire, analyse de sortie)
  // sans payer le plein ZEXALL.
  describe('infrastructure', () => {
    it('le binaire embarqué est bien celui documenté', () => {
      const binary = loadZexallBinary();
      expect(binary.length).toBe(8704);
      expect(ZEXALL_SHA256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('sait lire une sortie « OK »', () => {
      const report = parseZexallOutput(
        'Z80 instruction exerciser\r\nneg...........................  OK\r\nTests complete',
      );
      expect(report.passed).toBe(1);
      expect(report.failed).toBe(0);
      expect(report.completed).toBe(true);
      expect(report.tests[0].name).toBe('neg');
    });

    it('sait lire une sortie « ERROR » avec les deux CRC', () => {
      // Ligne telle qu'émise par zexall.z80 (ermsg1 + phex8 + ermsg2 + phex8).
      const report = parseZexallOutput(
        'ld a,(nnnn) / ld (nnnn),a.....  ERROR **** crc expected:0bcd1234 found:0bcd5678',
      );
      expect(report.failed).toBe(1);
      expect(report.tests[0].status).toBe('ERROR');
      expect(report.tests[0].expected).toBe('0bcd1234');
      expect(report.tests[0].found).toBe('0bcd5678');
    });
  });

});

describeZexall('ZEXALL — conformité du cœur Z80', () => {
  // Le gros morceau. `timeout` doit dépasser la durée réelle (~4 min sur une
  // machine de développement) ; on laisse large.
  it(
    'passe les 67 familles sans aucun CRC erroné',
    () => {
      const report = runZexall({
        onProgress: (n) => {
          // eslint-disable-next-line no-console
          console.log(`    … ${(n / 1e9).toFixed(1)} Md instructions`);
        },
      });

      // eslint-disable-next-line no-console
      console.log(
        `    ${report.instructions.toLocaleString('fr-FR')} instructions, ` +
          `${report.ticks.toLocaleString('fr-FR')} T-states, ` +
          `${report.seconds.toFixed(1)} s`,
      );

      // Un test en échec est bien plus parlant que « 66 != 67 ».
      if (report.failed > 0) {
        const details = report.tests
          .filter((t) => t.status === 'ERROR')
          .map((t) => `      ${t.name} : attendu ${t.expected}, obtenu ${t.found}`)
          .join('\n');
        throw new Error(
          `${report.failed} famille(s) ZEXALL en échec :\n${details}\n\n` +
            `Sortie complète :\n${report.output}`,
        );
      }

      expect(report.timedOut, 'ZEXALL doit se terminer par son « jp 0 »').toBe(false);
      expect(report.completed, 'ZEXALL doit afficher « Tests complete »').toBe(true);
      expect(report.tests).toHaveLength(67);
      expect(report.passed).toBe(67);
      expect(report.failed).toBe(0);
    },
    30 * 60 * 1000,
  );
});
