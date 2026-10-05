/**
 * @file tests/z80/ed-nop.test.mjs
 * @description Les 256 opcodes `ED` s'exécutent — NOP sur 2 octets pour les non documentés.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LE BUG
 * ─────────────────────────────────────────────────────────────────────────────
 * `initTables()` posait d'abord 256 stubs qui lèvent :
 *
 *     this.opcodesED[i] = () => { throw new Error(`Z80: Unknown ED opcode 0x…`); };
 *
 * puis surchargeait les seuls opcodes documentés. Les 178 autres restaient
 * sur le stub. Or Zilog UM0081 dit (repris par la SinclairFAQ) :
 *
 *     « The ED opcodes in the range 00-3F and 80-FF (except for the block
 *       instructions) do nothing at all but taking up 8 T states and
 *       incrementing the R register by 2. »
 *
 * Ce sont des **NOP documentés**, pas des opcodes invalides. Le premier `ED FF`
 * rencontré dans une ROM de boot CPC interrompait l'émulation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI C'EST RESTÉ TANT DE TEMPS CACHÉ
 * ─────────────────────────────────────────────────────────────────────────────
 * ZEXALL passe 67/67 et ne teste **rien** de tout ça : recherche binaire sur
 * `tests/fixtures/zexall.com`, 0 occurrence de `ED FF`, `ED 00`, `ED 77`,
 * `ED 7F` et `ED C0`. C'est l'angle mort annoncé au §9.7 du rapport, jamais
 * atteint parce que le code réellement exécuté au boot ne touchait pas ces
 * séquences. Le bug est préexistant : il n'est apparu qu'une fois l'émulateur
 * assez correct pour aller jusque-là.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CE QUE CE FICHIER GARDE
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Aucun des 256 `ED` ne lève. C'est la propriété qui aurait dû exister.
 * 2. Les non documentés sont des NOP : aucun registre, drapeau ou octet de
 *    mémoire touché, 2 octets consommés, 2 T-states internes.
 * 3. `R` progresse de 2 — « incrementing the R register by 2 ».
 * 4. Les opcodes documentés gardent leur sémantique : le défaut NOP est posé
 *    *avant* la section `ED OPCODES`, et ce test vérifie que les surcharges ont
 *    bien survécu. (Une inversion de cet ordre écraserait silencieusement 78
 *    opcodes fonctionnels par des NOP — c'est exactement l'erreur commise une
 *    première fois pendant le correctif.)
 */

import { describe, it, expect } from 'vitest';
import { TestMachine } from '../helpers/z80-harness.mjs';

const m = new TestMachine();

/**
 * Exécute un bloc depuis 0x0100 sur une machine remise à zéro, et renvoie les
 * T-states consommés ainsi que le PC final.
 * @param {number[]} code
 * @param {object} [avant] état à installer avant l'exécution
 * @returns {{ticks: number, pc: number, cpu: object, machine: object}}
 */
function executer(code, avant = {}) {
  m.cpu.reset();
  m.cpu.regPC = 0x0100;
  m.cpu.regSP = 0xFFFE;
  m.cpu.ioWriteState = 0;
  m.mem.fill(0);                    // AVANT load : sinon on efface le programme
  m.load(code, 0x0100);
  for (const [cle, valeur] of Object.entries(avant)) {
    // `r8` doit être renseigné index par index : l'affectation directe
    // remplacerait le Uint8Array du CPU par un tableau ordinaire, et les
    // lectures suivantes rendraient 0xC4 === -60.
    if (cle === 'r8') valeur.forEach((v, i) => { m.cpu.r8[i] = v; });
    else if (cle === 'mem') m.mem[valeur.adresse] = valeur.valeur;
    else m.cpu[cle] = valeur;
  }
  const avant_ = m.ticks;
  m.step();
  return { ticks: m.ticks - avant_, pc: m.cpu.regPC, cpu: m.cpu, machine: m };
}

/** Instantané complet de l'état CPU, pour prouver qu'un NOP ne touche à rien. */
function instantane(cpu) {
  return JSON.stringify({
    r8: Array.from(cpu.r8),
    r16: Array.from(cpu.r16),
    f: cpu.r8[6],
    sp: cpu.regSP,
    i: cpu.regI,
    im: cpu.regIM,
    iff1: cpu.iff1,
    iff2: cpu.iff2,
    wz: cpu.regWZ,
  });
}

/** Les opcodes ED réellement implémentés avant le correctif. */
const DOCUMENTES = new Set([
  // LD A,I / LD A,R / LD I,A / LD R,A
  0x57, 0x5f, 0x47, 0x4f,
  // LD rr,(nn) et LD (nn),rr pour BC/DE/HL/SP
  0x4b, 0x5b, 0x6b, 0x7b, 0x43, 0x53, 0x63, 0x73,
  // SBC HL,rr / ADC HL,rr
  0x42, 0x52, 0x62, 0x72, 0x4a, 0x5a, 0x6a, 0x7a,
  // LDI/LDD/LDIR/LDDR et CPI/CPD/CPIR/CPDR
  0xa0, 0xa8, 0xb0, 0xb8, 0xa1, 0xa9, 0xb1, 0xb9,
  // NEG
  0x44, 0x4c, 0x54, 0x5c, 0x64, 0x6c, 0x74, 0x7c,
  // IM 0 / IM 1 / IM 2 (+ variantes non documentées 4E/6E)
  0x46, 0x4e, 0x66, 0x6e, 0x56, 0x76, 0x5e, 0x7e,
  // RRD / RLD
  0x6f, 0x67,
  // RETN (+ variante non documentée 55/5D/65/6D/75/7D) et RETI
  0x45, 0x55, 0x5d, 0x65, 0x6d, 0x75, 0x7d, 0x4d,
  // IN r,(C) / OUT (C),r
  0x40, 0x48, 0x50, 0x58, 0x60, 0x68, 0x70, 0x78,
  0x41, 0x49, 0x51, 0x59, 0x61, 0x69, 0x71, 0x79,
  // INI/INIR/IND/INDR et OUTI/OTIR/OUTD/OTDR
  0xa2, 0xb2, 0xaa, 0xba, 0xa3, 0xb3, 0xab, 0xbb,
]);
/** Les opcodes ED non documentés : tous les octets sauf ceux documentés. */
const NON_DOCUMENTES = (() => {
  const liste = [];
  for (let op = 0x00; op <= 0xff; op++) liste.push(op);
  return liste.filter((op) => !DOCUMENTES.has(op));
})();


describe('Z80 — ED non documentés (NOP sur 2 octets)', () => {
  it('aucun des 256 opcodes ED ne lève', () => {
    const coupables = [];
    for (let op = 0x00; op <= 0xff; op++) {
      try {
        m.cpu.reset();
        m.cpu.opcodesED[op]();
      } catch (e) {
        coupables.push(`ED ${op.toString(16).toUpperCase().padStart(2, '0')}: ${e.message}`);
      }
    }
    expect(coupables, coupables.join('\n')).toEqual([]);
  });

  it('ne touche aucun registre ni drapeau', () => {
    // Tous les non documentés d'un coup : 178 exécutions d'affilée, chacune
    // devant laisser la machine strictement dans le même état.
    const avant = instantane(m.cpu);
    for (const op of NON_DOCUMENTES) {
      m.cpu.reset();
      m.cpu.r16[2] = 0x2000;      // HL pointé sur la mémoire
      m.mem[0x2000] = 0x5a;
      m.cpu.r8[7] = 0x3c;          // A non nul
      m.cpu.r8[6] = 0xff;          // tous drapeaux
      const ref = instantane(m.cpu);
      m.cpu.opcodesED[op]();
      expect(instantane(m.cpu), `ED ${op.toString(16).toUpperCase()}`).toBe(ref);
      void avant;
    }
  });

  it('consomme 2 octets et 2 T-states internes', () => {
    for (const op of NON_DOCUMENTES) {
      const r = executer([0xed, op]);
      expect(r.ticks, `ED ${op.toString(16).toUpperCase()}`).toBe(2);
      expect(r.pc, `ED ${op.toString(16).toUpperCase()}`).toBe(0x0102);
    }
  });

  it('incrémente R de 2', () => {
    // « incrementing the R register by 2 » — les deux fetchOpcode le font déjà.
    const r = executer([0xed, 0xff], { regR: 0x10 });
    expect(r.cpu.regR).toBe(0x12);
  });

  it('ne touche pas la mémoire pointée par HL', () => {
    const r = executer([0xed, 0xff], { r16: [0x2000, 0, 0x2000], mem: { adresse: 0x2000, valeur: 0x21 } });
    expect(r.machine.mem[0x2000]).toBe(0x21);
  });

  it('les opcodes documentés survivent au défaut NOP', () => {
    // Non-régression de l'ordre d'initialisation : le NOP est posé AVANT la
    // section « ED OPCODES », et ces surcharges doivent rester effectives.
    //
    // Attendues MESURÉES sur le cœur (A = 0x3C, HL = 0x2000 pointant 0x21,
    // BC = 0x0001) — et non déduites de la spec : `ED 57` est LD A,I et non
    // LD SP,HL ( confusion faite une fois en rédigeant ce test ).
    const attendu = [
      ['NEG        ED 4C', [0xed, 0x4c], (r) => r.cpu.r8[7] === 0xc4 && (r.cpu.r8[6] & 0x80) !== 0],
      ['IM 0       ED 46', [0xed, 0x46], (r) => r.cpu.regIM === 0],
      ['IM 1       ED 56', [0xed, 0x56], (r) => r.cpu.regIM === 1],
      ['IM 2       ED 5E', [0xed, 0x5e], (r) => r.cpu.regIM === 2],
      ['LD A,I     ED 57', [0xed, 0x57], (r) => r.cpu.r8[7] === 0x00],       // I vaut 0
      ['LD I,A     ED 47', [0xed, 0x47], (r) => r.cpu.regI === 0x3c],
      ['RRD        ED 67', [0xed, 0x67], (r) => r.cpu.r8[7] === 0x31 && r.machine.mem[0x2000] === 0xc2],
      ['LDI        ED A0', [0xed, 0xa0, 0x00, 0x00], (r) => r.cpu.r16[2] === 0x2001 && r.cpu.r16[0] === 0],
      ['RETN       ED 45', [0xed, 0x45], (r) => r.cpu.regPC === 0x0000],
      ['LD (nn),BC ED 43', [0xed, 0x43, 0x00, 0x20], (r) => r.machine.mem[0x2000] === 0x01],
    ];
    const echecs = [];
    for (const [label, code, verifie] of attendu) {
      const r = executer(code, {
        r8: [0, 0, 0, 0, 0, 0, 0, 0x3c],
        r16: [0x0001, 0x0002, 0x2000],
        mem: { adresse: 0x2000, valeur: 0x21 },
      });
      if (!verifie(r)) echecs.push(`${label} (A=${r.cpu.r8[7]}, F=${r.cpu.r8[6]}, PC=0x${r.cpu.regPC.toString(16)})`);
    }
    expect(echecs, `opcodes neutralisés à tort : ${echecs.join(', ')}`).toEqual([]);
  });
});
