/**
 * JS CPC Module: Tools_Formatters  (ES6)
 * ─────────────────────────────────────────────────────────────────────────────
 * Fonctions utilitaires de formatage : conversions numériques (hex, binaire,
 * décimal) et helpers HTML pour le désassembleur / débogueur.
 * Aucune dépendance externe - module pur sans état.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

// ─── Helpers numériques bas niveau ───────────────────────────────────────────

/**
 * Ajoute des zéros à gauche jusqu'à atteindre la longueur cible.
 * @param {string} str          - Chaîne source (résultat de .toString(base))
 * @param {number} targetLength - Largeur souhaitée
 * @returns {string}
 */
const padLeft = (str, targetLength) => str.padStart(targetLength, "0");

/**
 * Convertit une valeur 8 bits en hexadécimal sur 2 caractères.
 * Exemple : 7  → "07"
 * @param {number} value
 * @returns {string}
 */
const toHex8 = (value) => padLeft((value & 0xFF).toString(16), 2);

/**
 * Convertit une valeur 16 bits en hexadécimal sur 4 caractères.
 * Exemple : 4096 → "1000"
 * @param {number} value
 * @returns {string}
 */
const toHex16 = (value) => padLeft((value & 0xFFFF).toString(16), 4);

/**
 * Convertit une valeur en binaire sur 8 caractères.
 * Exemple : 7 → "00000111"
 * @param {number} value
 * @returns {string}
 */
const toBinary8 = (value) => padLeft((value & 0xFF).toString(2), 8);

/**
 * Formate un nombre en décimal sur 3 chiffres (utilisé pour le compteur de bande).
 * Exemple : 5 → "005"
 * @param {number} value
 * @returns {string}
 */
const toDecimal3 = (value) => padLeft(value.toString(10), 3);

// ─── Lecture Little-Endian depuis un buffer ───────────────────────────────────

/**
 * Lit un entier 16 bits en Little-Endian depuis un buffer.
 * @param {Uint8Array} buffer
 * @param {number}     offset
 * @returns {number}
 */
const read16bitLE = (buffer, offset) =>
  (buffer[offset + 1] << 8) | buffer[offset];

/**
 * Lit un entier 24 bits en Little-Endian depuis un buffer.
 * @param {Uint8Array} buffer
 * @param {number}     offset
 * @returns {number}
 */
const read24bitLE = (buffer, offset) =>
  (buffer[offset + 2] << 16) | (buffer[offset + 1] << 8) | buffer[offset];

/**
 * Lit un entier 32 bits (DWord) en Little-Endian depuis un buffer.
 * Note : l'opérateur >>> 0 garantit un résultat non signé.
 * @param {Uint8Array} buffer
 * @param {number}     offset
 * @returns {number}
 */
const read32bitLE = (buffer, offset) =>
  (((buffer[offset + 3] << 24) |
    (buffer[offset + 2] << 16) |
    (buffer[offset + 1] <<  8) |
     buffer[offset]) >>> 0);

// ─── Conversion de tableaux ───────────────────────────────────────────────────

/**
 * Convertit une séquence d'octets en chaîne ASCII.
 * @param {Uint8Array} buffer
 * @param {number}     offset - Indice de début
 * @param {number}     length - Nombre de caractères à lire
 * @returns {string}
 */
const bytesToString = (buffer, offset, length) =>
  Array.from({ length }, (_, i) =>
    String.fromCharCode(buffer[offset + i])
  ).join("");

/**
 * Convertit un tableau d'octets en chaîne hexadécimale lisible  [xx,xx,…]
 * Utile pour les logs du contrôleur de disquette (FDC).
 * @param {Uint8Array|number[]} byteArray
 * @returns {string}  ex. "[FF,3A,00]"
 */
const arrayToHexString = (byteArray) =>
  "[" + Array.from(byteArray).map(toHex8).join(",") + "]";

// ─── Helpers HTML pour le désassembleur Z80 ──────────────────────────────────
// Ces fonctions injectent des balises <span> permettant la coloration
// syntaxique dans l'interface du débogueur.

/** Enveloppe un texte arbitraire dans un span .reg */
const fmtHtmlReg  = (a) => `<span class="reg">${a}</span>`;

/** Enveloppe un nom de condition dans un span .cond */
const fmtHtmlCond = (a) => `<span class="cond">${a}</span>`;

/** Formate le nom d'un registre 8 bits par index. */
const fmtReg8Name = (a) => `<span class="reg">${reg8Names[a]}</span>`;

/**
 * Formate le nom d'un registre 8 bits en tenant compte du registre d'index
 * courant (IX/IY → IXh, IXl, IYh, IYl) ou d'un registre ordinaire.
 * @param {number} a - Index de registre
 * @returns {string}
 */
const fmtIndexReg8Name = (a) => {
  let name;
  if      (a === REG_INDEX_HIGH) name = `${CPU_Z80.indexReg.name}h`;
  else if (a === REG_INDEX_LOW)  name = `${CPU_Z80.indexReg.name}l`;
  else                           name = reg8Names[a];
  return `<span class="reg">${name}</span>`;
};

/**
 * Formate un déplacement signé par rapport au registre d'index courant.
 * Exemple : +5  ou  -3 avec IX → "(IX+5)"
 * @param {number} a - Déplacement (signé)
 * @returns {string}
 */
const fmtIndexDisplacement = (a) => {
  const sign = a >= 0 ? `+${a}` : `${a}`;
  return `<span class="reg">${CPU_Z80.indexReg.name}</span>` +
         `<span class="int">${sign}</span>`;
};

/** Formate uniquement le nom du registre d'index courant (IX ou IY). */
const fmtIndexRegName = () =>
  `<span class="reg">${CPU_Z80.indexReg.name}</span>`;

/** Formate une paire de registres (famille AF : AF, BC, DE, HL). */
const fmtRegPairNameAF = (a) =>
  `<span class="reg">${regPairNamesAF[a]}</span>`;

/** Formate une paire de registres (famille SP : BC, DE, HL, SP). */
const fmtRegPairNameSP = (a) =>
  `<span class="reg">${regPairNamesSP[a]}</span>`;

/**
 * Formate une paire de registres qui peut être IX/IY (PAIR_IXY_IDX)
 * ou une paire ordinaire de la famille SP.
 * @param {number} a
 * @returns {string}
 */
const fmtIndexPairName = (a) =>
  a === PAIR_IXY_IDX
    ? `<span class="reg">${CPU_Z80.indexReg.name}</span>`
    : `<span class="reg">${regPairNamesSP[a]}</span>`;

/** Formate un entier littéral (valeur immédiate). */
const fmtInt  = (a) => `<span class="int">${a}</span>`;

/** Formate un immédiat 8 bits en hexadécimal préfixé "$". */
const fmtHex8 = (a) => `<span class="int">$${toHex8(a)}</span>`;

/** Formate un immédiat 16 bits en hexadécimal préfixé "$". */
const fmtHex16 = (a) => `<span class="int">$${toHex16(a)}</span>`;

/** Formate un nom de condition Z80 (NZ, Z, NC, C, PO, PE, P, M). */
const fmtConditionName = (a) =>
  `<span class="cond">${z80ConditionNames[a]}</span>`;
