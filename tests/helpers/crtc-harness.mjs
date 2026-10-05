/**
 * @file tests/helpers/crtc-harness.mjs
 * @description Harnais de test pour le CRTC (site/js/core/video/MC6845.js).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CHARGEMENT MANUEL
 * ─────────────────────────────────────────────────────────────────────────────
 * Même raison que pour `Z80.js` et `GateArray.js` : `MC6845.js` est un script
 * classique sans `export`. On l'évalue via `vm.runInThisContext` en lui
 * ajoutant une expression d'export. Le `filename` permet d'attribuer la
 * couverture au vrai fichier source.
 *
 * Le fichier déclare **cinq** symboles : `CRTC_Manager` et les quatre variantes
 * `CRTC_Type0` à `CRTC_Type3`. Ils doivent tous être extraits en un seul
 * passage : rejouer le fichier serait une `SyntaxError` de redeclaration.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI LA BANQUE DE REGISTRES EST PARTAGÉE
 * ─────────────────────────────────────────────────────────────────────────────
 * `CRTC_Manager.registers` est un unique `Uint8Array(18)`. `P()` ne copie que
 * les *méthodes* de la variante : le stock de registres est commun. C'est
 * exactement ce que fait le moteur réel, et une suite qui oublierait ce point
 * testerait une autre machine qu'en production.
 *
 * Conséquence pour les tests : après `P(CRTC_Type1)`, les registres leftover
 * de Type0 sont toujours là. `reset()` est donc appelé systématiquement.
 */

/* eslint-disable no-new-func */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Chemin absolu du CRTC sous test. */
export const CRTC_SOURCE_PATH = resolve(HERE, '../../site/js/core/video/MC6845.js');

const _SYMBOLS = ['CRTC_Manager', 'CRTC_Type0', 'CRTC_Type1', 'CRTC_Type2', 'CRTC_Type3'];

/** Cache des symboles, dans le contexte global (jamais effacé — cf. GateArray). */
const _CACHE_KEY = '__CRTC_EXPORT__';

let _core = null;

/**
 * Charge (une seule fois) le CRTC et ses quatre variantes.
 * @returns {object} les cinq symboles
 */
export function loadCrtc() {
  if (_core !== null) return _core;
  if (globalThis[_CACHE_KEY]) return globalThis[_CACHE_KEY];

  // `MC6845.js` appelle `toHex8` (Tools_Formatters) dans `updateUI()`, la
  // projection de la sidebar de debug. Même convention que le harnais ASIC
  // pour `toHex16` : on pose un stub plutôt que de charger un module de plus.
  // Il reproduit la casse du vrai (`toString(16)` → minuscules) pour que les
  // tests d'affichage ne valident pas un format que la page ne produit pas.
  if (typeof globalThis.toHex8 !== 'function') {
    globalThis.toHex8 = (n) => (n & 0xff).toString(16).padStart(2, '0');
  }

  const source = readFileSync(CRTC_SOURCE_PATH, 'utf8');
  const assignments = _SYMBOLS
    .map((s) => `globalThis[${JSON.stringify(_CACHE_KEY)}][${JSON.stringify(s)}] = ${s};`)
    .join('\n');
  runInThisContext(`${source}\n;globalThis[${JSON.stringify(_CACHE_KEY)}] = {};\n${assignments}`, {
    filename: CRTC_SOURCE_PATH,
  });

  const loaded = globalThis[_CACHE_KEY];
  for (const s of _SYMBOLS) {
    if (loaded[s] === undefined) {
      throw new Error(
        `crtc-harness: ${s} introuvable dans ${CRTC_SOURCE_PATH}. ` +
          'Le fichier source a peut-être changé de forme.',
      );
    }
  }
  _core = loaded;
  return _core;
}/**
 * Jeu de registres correspondant au mode vidéo CPC standard (Mode 1,
 * 40 colonnes × 25 lignes), tel que le BIOS l'écrit.
 *
 * Ce n'est pas une valeur « officielle » : c'est la configuration de travail
 * que tous les programmes CPC utilisent, et elle sert de point de départ
 * lisible aux tests. `type` est le nom du mode (`type1` = 4 couleurs, etc.).
 * @param {string} [type='type1']
 * @returns {Uint8Array} les 18 registres
 */
export function standardModeRegisters(type = 'type1') {
  const r = new Uint8Array(18);
  if (type === 'type1' || type === 'type2') {
    // Mode 1 : 4 couleurs en 40×25.
    r[0] = 0x40;   // 64 caractères par ligne
    r[1] = 0x28;   // 40 affichés
    r[2] = 0x30;   // position HSync
    r[3] = 0x00;   // largeur HSync 0 (surchargée selon la variante)
    r[4] = 0x28;   // 40 lignes totales
    r[5] = 0x00;   // ajustement
    r[6] = 0x19;   // 25 lignes affichées
    r[7] = 0x00;   // position VSync (ligne 0)
    r[8] = 0x00;   // pas d'entrelacement
    r[9] = 0x07;   // 8 lignes de rastér par rang
  } else {
    // Mode 2 : 2 couleurs, 80×25.
    r[0] = 0x50;   // 80 caractères
    r[1] = 0x50;   // 80 affichés
    r[2] = 0x40;
    r[3] = 0x00;
    r[4] = 0x28;
    r[5] = 0x00;
    r[6] = 0x19;
    r[7] = 0x00;
    r[8] = 0x00;
    r[9] = 0x07;
  }
  return r;
}

/**
 * Machine CRTC de test : gestionnaire + variante sélectionnée, avec une ASIC
 * maquette (déverrouillage, HScroll, split-screen, SSCR).
 */
export class TestCrtc {
  /**
   * @param {object} [options]
   * @param {string} [options.type='type1']  type0 | type1 | type2 | type3
   * @param {number} [options.machineType=2] 2 = 6128, 4 = CPC+
   */
  constructor({ type = 'type1', machineType = 2 } = {}) {
    const core = loadCrtc();

    /** @type {object} Le dispatcher central. */
    this.crtc = core.CRTC_Manager;
    /** Les quatre variantes, indexées par nom. @type {object} */
    this.variants = {
      type0: core.CRTC_Type0,
      type1: core.CRTC_Type1,
      type2: core.CRTC_Type2,
      type3: core.CRTC_Type3,
    };

    /** Maquette ASIC. @type {object} */
    this.asic = {
      hScroll: 0,
      splitLine: 0,
      ssaHigh: 0,
      ssaLow: 0,
      sscr: 0,
      unlockFeed: [],
    };
    /** Nombre d'appels à `renderAsicSplit`. @type {number} */
    this.asicSplitRenders = 0;

    const self = this;
    const variant = this.variants[type];
    if (!variant) {
      throw new Error(`crtc-harness: type CRTC inconnu '${type}'`);
    }
    this.typeName = type;

    this.crtc.link({
      machineType,
      feedUnlock: (val) => { self.asic.unlockFeed.push(val); },
      getAsicHScroll: () => self.asic.hScroll,
      getAsicSplitLine: () => self.asic.splitLine,
      getAsicSsaHigh: () => self.asic.ssaHigh,
      getAsicSsaLow: () => self.asic.ssaLow,
      getAsicSscr: () => self.asic.sscr,
      renderAsicSplit: () => { self.asicSplitRenders++; },
    });

    this.crtc.reset();
    this.crtc.P(variant);
  }

  /**
   * Écrit une valeur dans un registre via le chemin normal du Z80
   * (port de sélection puis port de données).
   * @param {number} index 0–17
   * @param {number} value 0–255
   * @returns {this}
   */
  setRegister(index, value) {
    this.crtc.writePort(0xBC00, index);
    this.crtc.writePort(0xBD00, value);
    return this;
  }

  /**
   * Écrit un jeu complet de registres (les 18, dans l'ordre).
   * @param {Uint8Array|number[]} values
   * @returns {this}
   */
  setRegisters(values) {
    for (let i = 0; i < values.length; i++) this.setRegister(i, values[i]);
    return this;
  }

  /**
   * Programme le mode vidéo standard CPC correspondant à la variante active.
   * @param {string} [mode='type1'] 'type1' = Mode 1, 'type2' = Mode 2
   * @returns {this}
   */
  programStandardMode(mode) {
    return this.setRegisters(standardModeRegisters(mode));
  }

  /**
   * Simule un caractère (un tick horizontal complet).
   * C'est l'unité de temps du CRTC : `hcc_counter` va de 0 à R0.
   */
  tickChar() {
    this.crtc.tick();
  }

  /**
   * Simule une ligne de caractères complète.
   *
   * ⚠ Une ligne vaut **R0 + 1** ticks, pas R0. `tick()` teste `hcc === R0`
   * *avant* d'incrémenter : `hcc` atteint donc R0 au tick R0, et le tick
   * suivant — le (R0+1)-ième — remet le compteur à 0 et appelle
   * `updateVertical`. Utiliser R0 ticks laisserait `updateVertical` jamais
   * appelé et tous les tests verticaux silencieusement faux.
   *
   * @param {number} [chars] nombre de ticks ; par défaut R0 + 1
   */
  runLine(chars) {
    const n = chars === undefined ? this.crtc.registers[0] + 1 : chars;
    for (let i = 0; i < n; i++) this.crtc.tick();
  }

  /**
   * Simule une rangée de caractères complète (R9 + 1 lignes).
   *
   * C'est l'unité verticale : le passage à la rangée suivante (et donc
   * `vcc++`, ainsi que la vérification du VSync) n'a lieu que sur la
   * *dernière* ligne de la rangée. Sans cette unité, viser `vcc = n` demande
   * un compte de lignes difficile à raisonner.
   * @returns {this}
   */
  runRow() {
    for (let i = 0; i <= this.crtc.registers[9]; i++) this.runLine();
    return this;
  }

  /**
   * Simule une frame complète et rend le CRTC à un régime établi.
   *
   * ⚠ Une frame vaut **(R4 + 1) × (R9 + 1) + R5** lignes de caractère, pas
   * R4 + R5 : `vcc` atteint la valeur R4 *inclusive* (c'est la rangée qui
   * déclenche le VBlank), et chaque rangée occupe R9 + 1 lignes de rastér.
   * Avec le mode 40×25 usuel (R4 = 40, R9 = 7, R5 = 2) cela fait 330 lignes.
   *
   * Les deux premières frames après `reset()` sont dégénérées : les miroirs
   * `r4_vt`, `r5_vta` et `r9_mra` valent 0 tant que `updateVertical` n'a pas
   * tourné, ce qui fait porter la comparaison VBlank sur la ligne 0. Tout test
   * vertical doit donc passer par `settle()` avant de mesurer.
   *
   * @param {number} [n=2] nombre de frames à Bringing à stabiliser
   * @returns {this}
   */
  settle(n = 2) {
    const lignes = (this.crtc.registers[4] + 1) * (this.crtc.registers[9] + 1)
                 + this.crtc.registers[5];
    for (let f = 0; f < n; f++) {
      for (let i = 0; i < lignes; i++) this.runLine();
    }
    return this;
  }

  /**
   * Durée d'une frame en lignes de caractère, mesurée entre deux débuts de
   * VBlank successifs.
   *
   * ⚠ Mesurer le retour de `(vcc, vlc_crtc)` ne fonctionne PAS : les R5 lignes
   * de VBlank partagent toutes le même couple (R4, 0), donc la période mesurée
   * serait trop courte de R5 lignes. Le front de VBlank est, lui, unique.
   *
   * @param {number} [max=4000] garde-fou anti-boucle
   * @returns {number}
   */
  measureFrameLines(max = 4000) {
    // Se placer juste après un début de VBlank.
    let n = 0;
    while (!this.crtc.vblankActive && n < max) { this.runLine(); n++; }
    while (this.crtc.vblankActive && n < max) { this.runLine(); n++; }

    // Puis compter jusqu'au VBlank suivant.
    n = 0;
    while (!this.crtc.vblankActive && n < max) { this.runLine(); n++; }
    return n;
  }

  /**
   * Simule une frame approximative (nombre de lignes libre).
   * @param {number} [lines=330]
   * @returns {this}
   */
  runFrame(lines = 330) {
    for (let i = 0; i < lines; i++) this.runLine();
    return this;
  }

  /**
   * Compte les fronts VSync observés sur une durée donnée.
   * @param {number} lines nombre de lignes de caractères à simuler
   * @returns {number}
   */
  /**
   * Compte les fronts VSync sur `lignes` lignes de caractère.
   *
   * L'alignement préalable est indispensable : sans lui, le compteur dépend
   * de la phase de départ et renvoie `n` ou `n-1` pour la même durée.
   * @param {number} lines
   * @returns {number}
   */
  countVsyncs(lines) {
    // Se placer juste après un début de VSync.
    let garde = 0;
    while (!this.crtc.vsyncActive && garde < 2000) { this.runLine(); garde++; }
    while (this.crtc.vsyncActive && garde < 2000) { this.runLine(); garde++; }

    let n = 0;
    let previous = this.crtc.vsyncActive;
    for (let i = 0; i < lines; i++) {
      this.runLine();
      if (this.crtc.vsyncActive && !previous) n++;
      previous = this.crtc.vsyncActive;
    }
    return n;
  }

  /** @returns {number[]} copie des 18 registres, pour comparaison lisible */
  get registers() {
    return Array.from(this.crtc.registers);
  }
}
