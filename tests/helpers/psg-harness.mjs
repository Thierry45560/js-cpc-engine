/**
 * @file tests/helpers/psg-harness.mjs
 * @description Harnais de test pour le PSG AY-3-8910 (site/js/core/audio/AY38910.js).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CHARGEMENT MANUEL
 * ─────────────────────────────────────────────────────────────────────────────
 * Comme `Z80.js`, `GateArray.js`, `MC6845.js` et `ASIC.js`, `AY38910.js` est un
 * script classique sans `export`. On l'évalue via `vm.runInThisContext` en lui
 * ajoutant une expression d'export.
 *
 * Le fichier ne déclare qu'un seul symbole : `PSG_Sound_AY38910`. Il est en
 * `"use strict"` (ligne 1) et n'a aucune dépendance externe (ni jQuery, ni DOM,
 * ni WebAudio) : seul `link()` est à câbler.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SINGLETON
 * ─────────────────────────────────────────────────────────────────────────────
 * `PSG_Sound_AY38910` est un singleton de module. Deux instances vivantes se
 * voleraient leur `link()` et produiraient des zéros silencieux. Le harnais
 * périme l'instance précédente et lève une erreur au moindre accès.
 */

/* eslint-disable no-new-func */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Chemin absolu du PSG sous test. */
export const PSG_SOURCE_PATH = resolve(HERE, '../../site/js/core/audio/AY38910.js');

const _SYMBOL = 'PSG_Sound_AY38910';
const _CACHE_KEY = '__PSG_EXPORT__';

let _core = null;

/**
 * Charge (une seule fois) le PSG.
 * @returns {object} l'espace de noms `PSG_Sound_AY38910` lui-même
 */
export function loadPsg() {
  if (_core !== null) return _core;
  if (globalThis[_CACHE_KEY]) return globalThis[_CACHE_KEY];

  const source = readFileSync(PSG_SOURCE_PATH, 'utf8');
  runInThisContext(
    `${source}\n;globalThis[${JSON.stringify(_CACHE_KEY)}] = ${_SYMBOL};`,
    { filename: PSG_SOURCE_PATH },
  );

  const loaded = globalThis[_CACHE_KEY];
  if (!loaded) {
    throw new Error(
      `psg-harness: ${_SYMBOL} introuvable dans ${PSG_SOURCE_PATH}. ` +
        'Le fichier source a peut-être changé de forme.',
    );
  }
  _core = loaded;
  return _core;
}

let _activeInstance = null;

/**
 * PSG de test : le singleton câblé sur un faux port PPI et un faux clavier.
 */
export class TestPsg {
  /**
   * @param {object} [options]
   * @param {number} [options.ppiPortC=0] valeur initiale du port C du PPI
   * @param {number} [options.keyboardRow=0xFF] valeur lue sur le port A
   */
  constructor({ ppiPortC = 0, keyboardRow = 0xFF } = {}) {
    if (_activeInstance !== null) _activeInstance._stale = true;

    const core = loadPsg();

    Object.defineProperty(this, 'psg', {
      get: () => { this._assertLive(); return core; },
    });

    this._stale = false;
    _activeInstance = this;

    /** Valeur courante du port C du PPI (bits 7:6 = mode PSG). */
    this.portC = ppiPortC;
    /** Nombre de lignes de lecture du clavier. */
    this.keyboardReads = 0;

    const self = this;
    this.psg.link({
      getPpiPortC: () => self.portC,
      readKeyboardRow: () => { self.keyboardReads++; return keyboardRow; },
    });
    this.psg.reset();
  }

  /**
   * Vérifie que cette instance est encore celle qui détient le câblage.
   */
  _assertLive() {
    if (this._stale) {
      throw new Error(
        "psg-harness: cette TestPsg est périmée. PSG_Sound_AY38910 est un " +
          'singleton : une instance par test, et dispose() avant d\'en créer ' +
          'une autre.',
      );
    }
  }

  /** Marque l'instance comme libérée. @returns {this} */
  dispose() {
    if (_activeInstance === this) _activeInstance = null;
    this._stale = true;
    return this;
  }

  /**
   * Positionne le port C du PPI et renvoie le mode correspondant (bits 7:6).
   * @param {number} mode 0, 1, 2 ou 3
   * @returns {this}
   */
  setMode(mode) {
    this.portC = (this.portC & 0x3F) | ((mode & 3) << 6);
    return this;
  }

  /**
   * Écrit une valeur sur le bus de données du PSG, comme le ferait le CPU.
   * @param {number} val
   * @returns {this}
   */
  write(val) {
    this.psg.writePort(val);
    return this;
  }

  /**
   * Sélectionne un registre via le bus de données (mode 11).
   * @param {number} idx
   * @returns {this}
   */
  select(idx) {
    this.setMode(3);
    this.write(idx);
    this.setMode(2);
    return this;
  }

  /**
   * Écrit une valeur dans un registre (mode 10).
   * @param {number} idx
   * @param {number} val
   * @returns {this}
   */
  setReg(idx, val) {
    return this.select(idx).write(val);
  }

  /**
   * Programme la période d'un canal (12 bits).
   * Sur le AY-3-8910, R0 est l'accord fin et R1 l'accord grossier : la
   * période vaut donc `R1 << 8 | R0`.
   * @param {number} ch 0, 1 ou 2
   * @param {number} p 0-4095
   * @returns {this}
   */
  setPeriod(ch, p) {
    const base = ch * 2;
    this.setReg(base, p & 0xFF);
    return this.setReg(base + 1, (p >>> 8) & 0x0F);
  }

  /**
   * Fait avancer le PSG de n pas d'horloge.
   * @param {number} [n=1]
   * @returns {this}
   */
  clock(n = 1) {
    for (let i = 0; i < n; i++) this.psg.Clock_Cycle();
    return this;
  }
}