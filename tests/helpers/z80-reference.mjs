/**
 * @file tests/helpers/z80-reference.mjs
 * @description Sémantique de référence du Z80, écrite indépendamment du cœur.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI RÉÉCRIRE LES FLAGS PLUTÔT QUE DE COPIER LES VALEURS ATTENDUES
 * ─────────────────────────────────────────────────────────────────────────────
 * Une suite de non-régression qui recopie la sortie du cœur ne détecte rien :
 * elle figerait les bugs. Ici on implémente les règles du Z80 à partir de la
 * documentation matérielle, et on compare **deux implémentations indépendantes**
 * sur l'espace d'entrée complet (256 × 256 pour les opérations ALU).
 *
 * Un accord sur 65 536 cas par opération est une preuve bien plus forte
 * qu'une table de valeurs figées : un désaccord localise immédiatement
 * l'instruction et l'opérande fautifs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DISPOSITION DES DRAPEAUX (registre F)
 * ─────────────────────────────────────────────────────────────────────────────
 *   bit 7  S   bit 6  Z   bit 5  Y   bit 4  H
 *   bit 3  X   bit 2  PV  bit 1  N   bit 0  C
 *
 * Y (bit 5) et X (bit 3) sont des *copies* des bits 5 et 3 de la valeur du
 * résultat — c'est ce qui permet de.shift() et d'afficher lesflags en binaire
 * pendant un débogage BASIC sur matériel réel.
 */

/** Drapeaux du Z80. */
export const F = Object.freeze({
  S: 0x80, Z: 0x40, Y: 0x20, H: 0x10,
  X: 0x08, PV: 0x04, N: 0x02, C: 0x01,
});

/**
 * Drapeaux S, Z, Y, X et parité d'une valeur 8 bits.
 *
 * @param {number} v 0..255
 * @returns {number} masque F
 */
export function szxyp(v) {
  const parity = popcount(v & 0xFF) & 1 ? 0 : F.PV;
  return (v & F.S) | (v === 0 ? F.Z : 0) | (v & F.Y) | (v & F.X) | parity;
}

/**
 * Drapeaux S, Z et parité seuls (utilisés par CP, qui prend Y/X de l'opérande).
 * @param {number} v 0..255
 * @returns {number}
 */
export function szp(v) {
  const parity = popcount(v & 0xFF) & 1 ? 0 : F.PV;
  return (v & F.S) | (v === 0 ? F.Z : 0) | parity;
}

/**
 * Compte les bits à 1.
 * @param {number} v entier non négatif
 * @returns {number}
 */
export function popcount(v) {
  let n = 0;
  for (let i = 0; i < 32; i++) n += (v >>> i) & 1;
  return n;
}

/**
 * ADD A,n — avec ou sans retenue.
 * @param {number} a    accumulateur 0..255
 * @param {number} b    opérande 0..255
 * @param {number} [carry=0] retenue entrante
 * @returns {{a:number, f:number}} nouvel A et F
 */
export function refAdd(a, b, carry = 0) {
  const res = a + b + carry;
  const r8 = res & 0xFF;
  const half = ((a & 0x0F) + (b & 0x0F) + carry) > 0x0F;
  const overflow = (~(a ^ b) & (a ^ r8) & F.S) !== 0;
  const f = szxyp(r8) & ~F.PV            // parité remplacée par l'overflow
           | (half ? F.H : 0)
           | (overflow ? F.PV : 0)
           | (res > 0xFF ? F.C : 0);     // N reste à 0
  return { a: r8, f: f & ~F.N };
}

/**
 * SUB A,n / SBC A,n — résultat identique, seule la retenue d'entrée change.
 * @param {number} a accumulateur
 * @param {number} b opérande
 * @param {number} [borrow=0] retenue entrante
 * @returns {{a:number, f:number}}
 */
export function refSub(a, b, borrow = 0) {
  const res = a - b - borrow;
  const r8 = res & 0xFF;
  const half = ((a & 0x0F) - (b & 0x0F) - borrow) < 0;
  const overflow = ((a ^ b) & (a ^ r8) & F.S) !== 0;
  const f = szxyp(r8) & ~F.PV
           | (half ? F.H : 0)
           | (overflow ? F.PV : 0)
           | F.N
           | (res < 0 ? F.C : 0);
  return { a: r8, f };
}

/**
 * CP n — A est inchangé ; S/Z viennent du résultat, Y/X de l'OPÉRANDE.
 * @param {number} a accumulateur
 * @param {number} b opérande comparé
 * @returns {number} F seul
 */
export function refCp(a, b) {
  const res = a - b;
  const r8 = res & 0xFF;
  const half = ((a & 0x0F) - (b & 0x0F)) < 0;
  const overflow = ((a ^ b) & (a ^ r8) & F.S) !== 0;
  return (szp(r8) & ~F.PV)
       | (b & (F.Y | F.X))
       | (half ? F.H : 0)
       | (overflow ? F.PV : 0)
       | F.N
       | (res < 0 ? F.C : 0);
}

/**
 * AND n — H à 1, C à 0, PV = parité du résultat.
 * @param {number} a
 * @param {number} b
 * @returns {{a:number, f:number}}
 */
export function refAnd(a, b) {
  const r = a & b;
  return { a: r, f: szxyp(r) | F.H };
}

/**
 * OR n.
 * @param {number} a
 * @param {number} b
 * @returns {{a:number, f:number}}
 */
export function refOr(a, b) {
  const r = a | b;
  return { a: r, f: szxyp(r) };
}

/**
 * XOR n.
 * @param {number} a
 * @param {number} b
 * @returns {{a:number, f:number}}
 */
export function refXor(a, b) {
  const r = a ^ b;
  return { a: r, f: szxyp(r) };
}

/**
 * INC r — C préservé, PV signale le passage de 0x7F.
 * @param {number} a
 * @returns {{a:number, f:number}} f sans C ni N
 */
export function refInc(a) {
  const r = (a + 1) & 0xFF;
  return { a: r, f: (szxyp(r) & ~F.PV) | ((a & 0x0F) === 0x0F ? F.H : 0) | (a === 0x7F ? F.PV : 0) };
}

/**
 * DEC r — N mis à 1, C préservé, PV signale le passage de 0x80.
 * @param {number} a
 * @returns {{a:number, f:number}} f sans C
 */
export function refDec(a) {
  const r = (a - 1) & 0xFF;
  return { a: r, f: (szxyp(r) & ~F.PV) | ((a & 0x0F) === 0x00 ? F.H : 0) | F.N | (a === 0x80 ? F.PV : 0) };
}

/**
 * ADD HL,rr — 16 bits. Ni S ni Z ne sont modifiés.
 *
 * Point d'exattention : X et Y ne sont **pas** recopiés depuis l'ancien HL
 * mais depuis le RÉSULTAT — F3 ← bit 11 du résultat, F5 ← bit 13.
 *
 * @param {number} hl
 * @param {number} rr
 * @param {number} f F entrant
 * @returns {{hl:number, f:number}}
 */
export function refAddHl(hl, rr, f) {
  const res = hl + rr;
  const half = ((hl & 0x0FFF) + (rr & 0x0FFF)) > 0x0FFF;
  return {
    hl: res & 0xFFFF,
    f: (f & (F.S | F.Z | F.PV))
        | ((res >>> 8) & (F.Y | F.X))
        | (half ? F.H : 0)
        | (res > 0xFFFF ? F.C : 0),
  };
}

/**
 * Rotation ou décalage au niveau bit.
 * @param {number} opType 0=RLC 1=RRC 2=RL 3=RR 4=SLA 5=SRA 6=SLL 7=SRL
 * @param {number} value  0..255
 * @param {number} [carryIn=0] C entrant (pour RL/RR)
 * @returns {{value:number, f:number}}
 */
export function refShift(opType, value, carryIn = 0) {
  let r;
  let f;
  switch (opType) {
    case 0: // RLC
      r = ((value << 1) | (value >>> 7)) & 0xFF;
      f = szxyp(r) | (value >>> 7);
      break;
    case 1: // RRC
      r = ((value >>> 1) | (value << 7)) & 0xFF;
      f = szxyp(r) | (value & 1);
      break;
    case 2: // RL
      r = ((value << 1) | carryIn) & 0xFF;
      f = szxyp(r) | (value >>> 7);
      break;
    case 3: // RR
      r = ((value >>> 1) | (carryIn << 7)) & 0xFF;
      f = szxyp(r) | (value & 1);
      break;
    case 4: // SLA
      r = (value << 1) & 0xFF;
      f = szxyp(r) | (value >>> 7);
      break;
    case 5: // SRA — le bit 7 est préservé (signe)
      r = ((value >>> 1) | (value & 0x80)) & 0xFF;
      f = szxyp(r) | (value & 1);
      break;
    case 6: // SLL — undocumented, bit 0 forcé à 1
      r = ((value << 1) | 1) & 0xFF;
      f = szxyp(r) | (value >>> 7);
      break;
    default: // SRL
      r = (value >>> 1) & 0xFF;
      f = szxyp(r) | (value & 1);
      break;
  }
  return { value: r, f };
}

/**
 * BIT b,r — teste un bit sans le modifier.
 *   S = 0, Z = 1 si le bit testé est à 0, H = 1,
 *   Y/X copiés depuis la valeur testée, PV = 0 (TOUJOURS), N = 0, C préservé.
 * @param {number} bit  0..7
 * @param {number} value 0..255
 * @param {number} [fIn=0] F entrant (C préservé)
 * @returns {number} F
 */
export function refBit(bit, value, fIn = 0) {
  const isSet = (value & (1 << bit)) !== 0;
  return (isSet ? 0 : F.Z)
       | (value & (F.Y | F.X))
       | F.H
       | (fIn & F.C);
}

/**
 * DAA — ajustement décimal après une opération BCD.
 *
 * Point subtil et souvent mal implémenté : les conditions de correction
 * (ajouter 0x06 / 0x60) dépendent de H, C et des nibbles de A, mais
 * **pas** du drapeau N. Après une soustraction, un nibble bas > 9 doit
 * igualmente être corrigé.
 *
 * @param {number} a accumulateur
 * @param {number} f F avant DAA
 * @returns {{a:number, f:number}}
 */
export function refDaa(a, f) {
  const n = (f & F.N) !== 0;
  const cIn = (f & F.C) !== 0;
  const hIn = (f & F.H) !== 0;

  let correction = 0;
  if (hIn || (a & 0x0F) > 9) correction |= 0x06;

  const carry = cIn || a > 0x99;
  if (carry) correction |= 0x60;

  const r = n ? (a - correction) & 0xFF : (a + correction) & 0xFF;
  const h = ((a ^ r) & F.H) !== 0 ? F.H : 0;

  return { a: r, f: szxyp(r) | (n ? F.N : 0) | h | (carry ? F.C : 0) };
}

/**
 * Formate un drapeau en binaire pour les messages d'échec lisibles.
 * @param {number} f
 * @returns {string} ex. "SZ5H3PNC"
 */
export function formatFlags(f) {
  return (f & F.S ? 'S' : '-')
       + (f & F.Z ? 'Z' : '-')
       + (f & F.Y ? '5' : '-')
       + (f & F.H ? 'H' : '-')
       + (f & F.X ? '3' : '-')
       + (f & F.PV ? 'P' : '-')
       + (f & F.N ? 'N' : '-')
       + (f & F.C ? 'C' : '-');
}