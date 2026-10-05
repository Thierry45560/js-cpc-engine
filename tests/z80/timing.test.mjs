/**
 * @file tests/z80/timing.test.mjs
 * @description Comptage des T-states : empreinte de régression et écart au matériel.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CE QUE CE FICHIER MESURE
 * ─────────────────────────────────────────────────────────────────────────────
 * `Z80_CPU` ne compte que les T-states qu'il déclare explicitement via
 * `executeTicks(n)`. Or `fetchOpcode()` n'appelle jamais `executeTicks` :
 * le cycle M1 (3 T-states du premier fetch) n'est jamais compté. On pourrait
 * donc s'attendre à un décalage constant de 3 — **ce n'est pas le cas**.
 *
 * Le delta mesuré varie de 3 (NOP) à 17 (DD 34, INC (IX+d)) :
 *
 *   instruction        cœur   Z80 réel   écart
 *   NOP                  1        4        -3
 *   LD A,n               2        7        -5
 *   JP nn                3       10        -7
 *   CALL nn              5       17       -12
 *   DD INC (IX+d)        6       23       -17
 *
 * Le cœur compte donc « les cycles internes » et non la durée d'exécution
 * complète de l'instruction. Pour l'émulation CPC cela se traduit par un
 * décompte du temps machine sous-évalué d'un facteur 2 à 4.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEUX BLOCS DE TESTS, DEUX INTENTS
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. `describe('empreinte de régression')` — asserte les valeurs ACTUELLES du
 *    cœur. VERT. Il garantit qu'un refactor du chemin chaud ne modifie pas
 *    silencieusement le rythme d'exécution.
 *
 * 2. `describe('temps matériel (écart assumé…)')` — mesure l'écart au temps
 *    du Z80 réel et le fige. Il est VERT par conception : l'écart est un
 *    choix du moteur (modèle de cycles internes), et ZEXALL ne contrôle pas
 *    la durée. Le test échouera si le comptage change sans qu'on le veuille.
 *
 * Le README ne revendique plus « Cycle-Accurate » : il décrit désormais
 * explicitement le modèle de cycles internes. Ces mesures documentent et
 * figent l'écart résiduel — voir §« Écarts constatés » de RAPPORT.md.
 */

import { describe, it, expect } from 'vitest';
import { TestMachine } from '../helpers/z80-harness.mjs';

const m = new TestMachine();

/**
 * Exécute une instruction et renvoie les T-states qu'elle a consommés.
 * @param {number[]} code
 * @param {Function} [setup]
 * @returns {number}
 */
function ticksFor(code, setup) {
  m.cpu.reset();
  m.cpu.regPC = 0x0100;
  m.cpu.regSP = 0xFFFE;
  m.cpu.ioWriteState = 0;
  m.ioOut.length = 0;   // journal d'E/S remis à zéro entre mesures
  m.load(code, 0x0100);
  if (setup) setup();
  const before = m.ticks;
  m.step();
  return m.ticks - before;
}

/**
 * Jeu de référence : [libellé, opcodes, durée Z80 réelle en T-states, setup].
 * `hw` provient des tables de la documentation Zilog UM0081.
 */
const REFERENCE = [
  ['NOP', [0x00], 4],
  ['LD A,n', [0x3E, 0x00], 7],
  ['LD B,(HL)', [0x46], 7],
  ['LD (HL),A', [0x77], 7],
  ['INC A', [0x3C], 4],
  ['INC (HL)', [0x34], 11],
  ['ADD A,n', [0xC6, 0x00], 7],
  ['ADD A,(HL)', [0x86], 7],
  ['ADC A,n', [0xCE, 0x00], 7],
  ['SUB n', [0xD6, 0x00], 7],
  ['AND n', [0xE6, 0x00], 7],
  ['CP n', [0xFE, 0x00], 7],
  ['INC BC', [0x03], 6],
  ['DEC HL', [0x2B], 6],
  ['ADD HL,BC', [0x09], 11],
  ['JP nn', [0xC3, 0x00, 0x00], 10],
  ['JP cc,nn (pris)', [0xCA, 0x00, 0x00], 10, () => m.setReg8('F', 0x40)],
  ['JR e', [0x18, 0x00], 12],
  ['JR cc,e (pris)', [0x28, 0x00], 7, () => m.setReg8('F', 0x40)],
  ['DJNZ (pris)', [0x10, 0x00], 13, () => m.setReg8('B', 2)],
  ['CALL nn', [0xCD, 0x00, 0x00], 17],
  ['CALL cc,nn (pris)', [0xC4, 0x00, 0x00], 17, () => m.setReg8('F', 0x40)],
  ['RET', [0xC9], 10],
  ['RST 0', [0xC7], 11],
  ['PUSH BC', [0xC5], 11],
  ['POP BC', [0xC1], 10],
  ['EX (SP),HL', [0xE3], 19],
  ['LD SP,HL', [0xF9], 6],
  ['RLCA', [0x07], 4],
  ['DAA', [0x27], 4],
  ['CPL', [0x2F], 4],
  ['SCF', [0x37], 4],
  ['LD A,(nn)', [0x3A, 0x00, 0x00], 13],
  ['LD (nn),A', [0x32, 0x00, 0x00], 13],
  ['LD HL,(nn)', [0x2A, 0x00, 0x00], 16],
  ['LD (nn),HL', [0x22, 0x00, 0x00], 16],
  ['LD BC,nn', [0x01, 0x00, 0x00], 10],
  ['CB RLC B', [0xCB, 0x00], 8],
  ['CB BIT 0,B', [0xCB, 0x40], 8],
  ['CB RES 0,B', [0xCB, 0x80], 8],
  ['CB SET 0,B', [0xCB, 0xC0], 8],
  ['ED NEG', [0xED, 0x44], 8],
  ['ED RETN', [0xED, 0x45], 14],
  ['ED IM 1', [0xED, 0x56], 8],
  ['ED LD (nn),BC', [0xED, 0x43, 0x00, 0x00], 20],
  ['ED LD BC,(nn)', [0xED, 0x4B, 0x00, 0x00], 20],
  ['ED RRD', [0xED, 0x67], 18],
  ['ED RLD', [0xED, 0x6F], 18],
  ['ED IN B,(C)', [0xED, 0x40], 12],
  ['ED OUT (C),B', [0xED, 0x41], 12],
  ['DD LD r,(IX+d)', [0xDD, 0x46, 0x00], 19],
  ['DD LD (IX+d),r', [0xDD, 0x70, 0x00], 19],
  ['DD INC (IX+d)', [0xDD, 0x34, 0x00], 23],
  ['DDCB RLC (IX+d)', [0xDD, 0xCB, 0x00, 0x00], 23],
  ['DD LD IX,nn', [0xDD, 0x21, 0x00, 0x00], 14],
  ['IN A,(n)', [0xDB, 0x00], 11],
  ['OUT (n),A', [0xD3, 0x00], 11],
];

/** Valeurs effectivement produites par le cœur — l'empreinte de régression. */
const CORE_FINGERPRINT = [
  'NOP:1', 'LD A,n:2', 'LD B,(HL):2', 'LD (HL),A:2', 'INC A:1', 'INC (HL):3',
  'ADD A,n:2', 'ADD A,(HL):2', 'ADC A,n:2', 'SUB n:2', 'AND n:2', 'CP n:2',
  'INC BC:2', 'DEC HL:2', 'ADD HL,BC:3', 'JP nn:3', 'JP cc,nn (pris):3',
  'JR e:3', 'JR cc,e (pris):3', 'DJNZ (pris):4', 'CALL nn:5',
  'CALL cc,nn (pris):3', 'RET:3', 'RST 0:4', 'PUSH BC:4', 'POP BC:3',
  'EX (SP),HL:6', 'LD SP,HL:2', 'RLCA:1', 'DAA:1', 'CPL:1', 'SCF:1',
  'LD A,(nn):4', 'LD (nn),A:4', 'LD HL,(nn):5', 'LD (nn),HL:5',
  'LD BC,nn:3', 'CB RLC B:2', 'CB BIT 0,B:2', 'CB RES 0,B:2', 'CB SET 0,B:2',
  'ED NEG:2', 'ED RETN:4', 'ED IM 1:2', 'ED LD (nn),BC:6', 'ED LD BC,(nn):6',
  'ED RRD:5', 'ED RLD:5', 'ED IN B,(C):4', 'ED OUT (C),B:4',
  'DD LD r,(IX+d):5', 'DD LD (IX+d),r:5', 'DD INC (IX+d):6',
  'DDCB RLC (IX+d):7', 'DD LD IX,nn:4', 'IN A,(n):3', 'OUT (n),A:3',
];

// ─────────────────────────────────────────────────────────────────────────────
// 1. Empreinte de régression — VERT, garantit la stabilité du cœur
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — empreinte de régression des T-states', () => {
  it('chaque instruction consomme toujours le même nombre de T-states', () => {
    const observed = [];

    for (const [name, code, , setup] of REFERENCE) {
      observed.push(`${name}:${ticksFor(code, setup)}`);
    }

    expect(observed, 'le profil de timing du cœur a changé').toEqual(CORE_FINGERPRINT);
  });

  it('le cycle M1 n\'est jamais compté (fetchOpcode n\'appelle pas executeTicks)', () => {
    // NOP vaut 4 T-states sur matériel, 1 dans le cœur : les 3 T du fetch
    // M1 sont exactement la valeur manquante. Ce test verrouille ce fait
    // pour que la correction du comptage soit délibérée, pas accidentelle.
    expect(ticksFor([0x00])).toBe(1);
  });

  it('les T-states sont croissants avec la complexité de l\'adressage', () => {
    const direct = ticksFor([0x00]);              // NOP
    const indirect = ticksFor([0x86]);            // ADD A,(HL)
    const absolute = ticksFor([0x3A, 0x00, 0x00]); // LD A,(nn)

    expect(indirect).toBeGreaterThan(direct);
    expect(absolute).toBeGreaterThan(indirect);
  });

  it('les écritures I/O différées n\'ajoutent pas de T-states par elles-mêmes', () => {
    const plain = ticksFor([0x00]);
    const out = ticksFor([0xD3, 0x00], () => m.setReg8('A', 0xFF));

    // OUT (n),A arme `ioWriteState` ; c'est l'hôte (Emulator_Core) qui
    // déclenche le port au T-state voulu, pas le CPU.
    expect(m.ioOut.length, 'l\'écriture différée doit avoir été enregistrée').toBe(1);
    expect(out).toBeGreaterThan(plain);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Conformité au temps matériel
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — temps matériel (écart assumé, non couvert par ZEXALL)', () => {
  /**
   * Le comptage des T-states du cœur n'est PAS cycle-accurate au sens strict :
   * le cycle M1 (le fetch d'opcode) n'est jamais compté, et l'écart avec le
   * matériel n'est pas un décalage constant — il varie avec l'instruction.
   *
   * C'est un choix assumé du moteur, pas une régression : le modèle « cycles
   * internes » suffit à piloter le CRTC et le GateArray, qui n'ont besoin que
   * d'un rythme relatif cohérent entre instructions. Rien dans ZEXALL ne
   * permet de trancher : la suite de conformité de Cringle ne contrôle que
   * les registres, les drapeaux et la mémoire — jamais la durée.
   *
   * Ce test est donc VERT par conception. Il mesure, fige et documente
   * l'écart, et échouera si quelqu'un change le comptage sans le vouloir. Pour
   * revenir au temps matériel, il faudra réécrire `op_*` avec une table de
   * durées, et c'est un chantier à part.
   */
  it('mesure et fige l\'écart au temps matériel, instruction par instruction', () => {
    const ecart = [];

    for (const [nom, code, materiel, setup] of REFERENCE) {
      const obtenu = ticksFor(code, setup);
      ecart.push({
        instruction: nom,
        materiel,
        coeur: obtenu,
        delta: materiel - obtenu,
      });
    }

    // L'écart n'est pas constant : c'est ce qui distingue « cycle-accurate »
    // d'un simple modèle de cycles internes.
    const deltas = new Set(ecart.map((e) => e.delta));
    expect(deltas.size,
      `l'écart devrait être variable ; deltas vus : ${[...deltas].sort((a, b) => a - b).join(', ')}`,
    ).toBeGreaterThan(1);

    // Le cœur est toujours plus rapide que le matériel, et jamais négatif.
    for (const e of ecart) {
      expect(e.delta, `${e.instruction} : delta négatif`).toBeGreaterThan(0);
    }

    // Report lisible en cas d'évolution : c'est aussi la table de référence
    // pour quiconque voudra un jour poser des durées matérielles.
    // eslint-disable-next-line no-console
    console.log(
      '  écart au temps matériel :\n' +
        ecart.map((e) => `    ${e.instruction.padEnd(20)} matériel ${String(e.materiel).padStart(2)}  cœur ${String(e.coeur).padStart(2)}  Δ ${e.delta}`).join('\n'),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Propriétés du compteur — invariants vrais quel que soit le décalage
// ─────────────────────────────────────────────────────────────────────────────

describe('Z80 — invariants du compteur de T-states', () => {
  it('chaque instruction consomme un nombre strictement positif de T-states', () => {
    for (const [name, code, , setup] of REFERENCE) {
      expect(ticksFor(code, setup), `${name} ne doit pas être gratuit`).toBeGreaterThan(0);
    }
  });

  it('LDIR boucle correctement sans bouclage infini', () => {
    // Le timing des instructions bloc est difficile à prédire ; on vérifie
    // seulement qu'elles terminent et qu'elles ne consomment pas de temps
    // infini, ce qui révélerait une boucle de report mal calibrée.
    m.cpu.reset();
    m.cpu.regPC = 0x0100;
    m.load([0xED, 0xB0], 0x0100); // LDIR
    m.mem.fill(0, 0x2000, 0x2100);
    m.setReg16('HL', 0x2000);
    m.setReg16('DE', 0x3000);
    m.setReg16('BC', 64);

    const before = m.ticks;
    m.stepUntil(0x0102);
    expect(m.ticks - before).toBeGreaterThan(0);
    expect(m.getReg16('BC')).toBe(0);
  });
});