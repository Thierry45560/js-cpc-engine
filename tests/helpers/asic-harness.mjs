/**
 * @file tests/helpers/asic-harness.mjs
 * @description Harnais de test pour l'ASIC du CPC+ (site/js/core/video/ASIC.js).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CHARGEMENT MANUEL
 * ─────────────────────────────────────────────────────────────────────────────
 * Comme `Z80.js`, `GateArray.js` et `MC6845.js`, `ASIC.js` est un script
 * classique sans `export`. On l'évalue via `vm.runInThisContext`, en lui
 * ajoutant une expression d'export.
 *
 * ⚠ `ASIC.js` est en `"use strict"` (ligne 31), comme `Z80.js`, `GateArray.js`
 * et `MC6845.js`.
 *
 * Le fichier déclare **trois** symboles : `ASIC_Manager`,
 * `ASIC_DMA_Controller` et `PriManager`. Ils doivent tous être extraits en un
 * seul passage : rejouer le fichier serait une `SyntaxError` de redeclaration.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SINGLETONS
 * ─────────────────────────────────────────────────────────────────────────────
 * Les trois espaces de noms sont des singletons de module. Comme pour le Gate
 * Array, deux instances vivantes se voleraient leur `link()`. Le harnais
 * périme l'instance précédente et lève une erreur au moindre accès.
 */

/* eslint-disable no-new-func */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Chemin absolu de l'ASIC sous test. */
export const ASIC_SOURCE_PATH = resolve(HERE, '../../site/js/core/video/ASIC.js');

const _SYMBOLS = ['ASIC_Manager', 'ASIC_DMA_Controller', 'PriManager'];
const _CACHE_KEY = '__ASIC_EXPORT__';

let _core = null;

/**
 * Charge (une seule fois) l'ASIC et ses deux sous-modules.
 * @returns {object} les trois symboles
 */
export function loadAsic() {
  if (_core !== null) return _core;
  if (globalThis[_CACHE_KEY]) return globalThis[_CACHE_KEY];

  // `ASIC.js` appelle `toHex16` (Tools_Formatters) sur le chemin d'erreur du
  // DMA. Le stub ci-dessous évite d'avoir à charger un module de plus ; les
  // tests qui atteignent ce chemin le font volontairement.
  if (typeof globalThis.toHex16 !== 'function') {
    globalThis.toHex16 = (n) => n.toString(16).padStart(4, '0');
  }

  const source = readFileSync(ASIC_SOURCE_PATH, 'utf8');
  const assignments = _SYMBOLS
    .map((s) => `globalThis[${JSON.stringify(_CACHE_KEY)}][${JSON.stringify(s)}] = ${s};`)
    .join('\n');
  runInThisContext(`${source}\n;globalThis[${JSON.stringify(_CACHE_KEY)}] = {};\n${assignments}`, {
    filename: ASIC_SOURCE_PATH,
  });

  const loaded = globalThis[_CACHE_KEY];
  for (const s of _SYMBOLS) {
    if (loaded[s] === undefined) {
      throw new Error(
        `asic-harness: ${s} introuvable dans ${ASIC_SOURCE_PATH}. ` +
          'Le fichier source a peut-être changé de forme.',
      );
    }
  }
  _core = loaded;
  return _core;
}

let _activeInstance = null;

/**
 * Machine ASIC de test : les trois espaces de noms câblés ensemble, avec une
 * RAM, une palette et un journal PSG.
 */
export class TestAsic {
  /**
   * @param {object} [options]
   * @param {number} [options.machineType=4] 4 = CPC+
   */
  constructor({ machineType = 4 } = {}) {
    if (_activeInstance !== null) _activeInstance._stale = true;

    const core = loadAsic();

    Object.defineProperty(this, 'asic', {
      get: () => { this._assertLive('asic'); return core.ASIC_Manager; },
    });
    Object.defineProperty(this, 'dma', {
      get: () => { this._assertLive('dma'); return core.ASIC_DMA_Controller; },
    });
    Object.defineProperty(this, 'pri', {
      get: () => { this._assertLive('pri'); return core.PriManager; },
    });

    this._stale = false;
    _activeInstance = this;

    /** RAM 64 Ko vue par le fetch DMA. @type {Uint8Array} */
    this.ram = new Uint8Array(0x10000);
    /** Palette matérielle 32 entrées, indexée par stylo. @type {Uint16Array} */
    this.hwPalette = new Uint16Array(32);
    /** Journal des écritures PSG issues du DMA. @type {{reg:number, value:number}[]} */
    this.psgWrites = [];
    /** Bits d'interruption levés sur le Gate Array. @type {number} */
    this.gaIntStatus = 0;
    /** Journal des écritures de palette ASIC. @type {{pen:number, value:number, half:string}[]} */
    this.colorWrites = [];
    /** Maquette CRTC. @type {object} */
    this.crtc = { vcc: 0, vlcCrtc: 0 };
    /** T-states écoulés. @type {number} */
    this.tstates = 0;
    /** Journal des opcodes DMA invalides. @type {string[]} */
    this.invalidOpcodes = [];
    /** Instantanés transmis à `updateAsicUI`. @type {object[]} */
    this.uiStates = [];
    /** Déclenchements de DMA demandés via le bus. @type {number} */
    this.dmaTriggers = 0;

    const self = this;

    this.asic.link({
      machineType,
      getHwPalette: (i) => self.hwPalette[i],
      writeColorLow: (pen, val) => {
        self.colorWrites.push({ pen, value: val, half: 'low' });
      },
      writeColorHigh: (pen, val) => {
        self.colorWrites.push({ pen, value: val, half: 'high' });
      },
      setGaIntStatus: (bits) => { self.gaIntStatus |= bits; },
      getAsicRamEnabled: () => false,
      setAsicRamEnabled: () => {},
      readMemory: (addr) => self.ram[addr & 0xFFFF],
      getDmaStatus: () => self.dma.statusControl,
      setDmaStatus: (val) => { self.dma.statusControl = val; },
      getDmaChannels: () => self.dma.channels,
      triggerDma: () => { self.dmaTriggers++; },
      getTStates: () => self.tstates,
      executeTicks: (n) => { self.tstates += n; },
      getVlcCrtc: () => self.crtc.vlcCrtc,
      updateAsicUI: (state) => { self.uiStates.push(state); },
    });

    this.dma.link({
      machineType,
      readMemory: (addr) => self.ram[addr & 0xFFFF],
      writePsgDma: (reg, val) => { self.psgWrites.push({ reg, value: val }); },
      setGaIntStatus: (bits) => { self.gaIntStatus |= bits; },
      executeTicks: (n) => { self.tstates += n; },
      getTStates: () => self.tstates,
    });

    this.pri.link({
      getVcc: () => self.crtc.vcc,
      getVlcCrtc: () => self.crtc.vlcCrtc,
    });

    this.pri.init();
    this.asic.reset();
    this.dma.init();
    this.pri.reset();
  }

  /**
   * Vérifie que cette instance est encore celle qui détient le câblage.
   * @param {string} quoi  nom du singleton
   */
  _assertLive(quoi) {
    if (this._stale) {
      throw new Error(
        `asic-harness: cette TestAsic est périmée (accès à '${quoi}'). ` +
          'Les espaces de noms de ASIC.js sont des singletons : une instance ' +
          'par test, et dispose() avant d\'en créer une autre.',
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
   * Écrit un mot de 16 bits en little-endian dans la RAM DMA.
   * @param {number} addr
   * @param {number} word
   * @returns {this}
   */
  setRamWord(addr, word) {
    this.ram[addr & 0xFFFF] = word & 0xFF;
    this.ram[(addr + 1) & 0xFFFF] = (word >>> 8) & 0xFF;
    return this;
  }

  /**
   * Envoie la séquence complète de déverrouillage de l'ASIC.
   * @returns {this}
   */
  unlock() {
    for (const octet of this.asic.asicUnlockSequence) this.asic.feedAsicUnlock(octet);
    return this;
  }

  /** Vide les journaux. @returns {this} */
  clearLogs() {
    this.psgWrites.length = 0;
    this.colorWrites.length = 0;
    this.invalidOpcodes.length = 0;
    this.uiStates.length = 0;
    return this;
  }
}
