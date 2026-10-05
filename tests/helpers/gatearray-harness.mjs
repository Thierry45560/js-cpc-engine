/**
 * @file tests/helpers/gatearray-harness.mjs
 * @description Harnais de test pour le Gate Array (site/js/core/video/GateArray.js).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI UN CHARGEMENT MANUEL
 * ─────────────────────────────────────────────────────────────────────────────
 * Comme `Z80.js`, `GateArray.js` est un script classique destiné au navigateur :
 * il n'a ni `export` ni `import` et déclare `const Palette_Colors` dans le scope
 * lexical global — donc `import` Node échouerait (`no matching export`).
 *
 * On lit le fichier et on l'évalue via `vm.runInThisContext`, en lui ajoutant
 * seulement une expression d'export. Le code est exécuté à l'identique, sans
 * transformation ni shim : ce que teste la suite est ce qui tourne en prod.
 * `vm` (et non `new Function`) car `vm` accepte un `filename`, ce qui permet à
 * V8 d'attribuer la couverture au vrai fichier source au lieu d'afficher 0 %.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI `Memory.js` EST CHARGÉ AUSSI
 * ─────────────────────────────────────────────────────────────────────────────
 * La « sélection de banque » du CPC n'est pas un calcul interne au Gate Array :
 * le GA décode l'octet de contrôle et *délègue* à `ROM_Manager`
 * (`updateRomConfig`, `selectAsicRom`). Tester la banque en isolant le GA ne
 * testerait que la délégation — c'est-à-dire rien.
 *
 * On charge donc aussi `Memory.js` et on reproduit le câblage réel de
 * `site/js/core/bus/CPC_Bus.js` (lignes 92-135), y compris la boucle de retour
 * `ROM_Manager.updatePaletteRom → Palette_Colors.romConfig` qui relie le mode
 * vidéo au Flag de configuration ROM. C'est cette boucle qui fait qu'un
 * `OUT (0x7F00),n` change simultanément le mode vidéo et la visibilité des
 * ROM : la tester, c'est tester le bus, pas une moitié de module.
 *
 * ⚠ Ces deux fichiers sont des singletons de module. `beforeEach` doit donc
 *   rappeler `link()` + `reset()`, ce que fait le constructeur de `TestVideo`.
 */

/* eslint-disable no-new-func */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Chemin absolu du Gate Array sous test. */
export const GATEARRAY_SOURCE_PATH = resolve(HERE, '../../site/js/core/video/GateArray.js');

/** Chemin absolu du gestionnaire mémoire (chargé pour le test de banque). */
export const MEMORY_SOURCE_PATH = resolve(HERE, '../../site/js/core/memory/Memory.js');

/**
 * Palette « moniteur » de 4096 entrées, identité.
 *
 * Le vrai tableau est produit par `Video_Hardware.init()` (correction gamma
 * RGB) et vit dans le DOM. On n'en a pas besoin ici : ce que le Gate Array
 * teste, c'est *l'index* qu'il demande (`monitorPalette[hwColorIndex[pen]]`).
 * L'identité rend cet index directement lisible dans les assertions.
 */
export const MONITOR_PALETTE = Object.freeze(
  Array.from({ length: 4096 }, (_, i) => i),
);

/**
 * Évalue un script classique et en exporte une ou plusieurs déclarations
 * globales vers `globalThis[global]`.
 *
 * Le cache vit dans le `globalThis` du contexte et n'est **jamais** effacé :
 * un `const` de niveau module vit dans le *scope lexical global*, il n'est pas
 * une propriété de `globalThis` et ne peut donc être ni détecté ni supprimé.
 * Rejouer le fichier serait une `SyntaxError` de redeclaration.
 *
 * Corollaire : il faut charger chaque fichier **une seule fois**, et en extraire
 * tous les symboles choisis dans ce même passage (`Memory.js` déclare
 * `Memory_Manager` *et* `ROM_Manager`).
 *
 * @param {string} path    chemin du fichier
 * @param {string} global  nom de la globale temporaire
 * @param {string[]} symbols  symboles à exporter
 * @returns {object} un objet { symbole → valeur }
 */
function loadSymbols(path, global, symbols) {
  if (globalThis[global]) return globalThis[global];
  const source = readFileSync(path, 'utf8');
  const assignments = symbols
    .map((s) => `globalThis[${JSON.stringify(global)}][${JSON.stringify(s)}] = ${s};`)
    .join('\n');
  runInThisContext(`${source}\n;globalThis[${JSON.stringify(global)}] = {};\n${assignments}`, {
    filename: path,
  });
  // ⚠ PAS de `delete` ici : ce serait la seule preuve que le fichier a déjà
  // été évalué, et le rechargement suivant échouerait sur les `const`.
  const value = globalThis[global];
  for (const s of symbols) {
    if (value[s] === undefined) {
      throw new Error(
        `gatearray-harness: ${s} introuvable dans ${path}. ` +
          'Le fichier source a peut-être changé de forme.',
      );
    }
  }
  return value;
}

/**
 * Charge (une seule fois) le Gate Array et le gestionnaire mémoire.
 * @returns {{Palette_Colors: object, ROM_Manager: object, Memory_Manager: object}}
 */
export function loadVideoCore() {
  return {
    Palette_Colors: loadSymbols(GATEARRAY_SOURCE_PATH, '__GA_EXPORT__', ['Palette_Colors'])
      .Palette_Colors,
    ...loadSymbols(MEMORY_SOURCE_PATH, '__MEM_EXPORT__', ['Memory_Manager', 'ROM_Manager']),
  };
}

/**
 * Construit un contenu de ROM lisible : `octet i = (seed + i) & 0xFF`.
 * Deux ROM de seeds différentes ne peuvent pas être confondues.
 * @param {number} seed
 * @param {number} [size=0x4000]
 * @returns {Uint8Array}
 */
export function romImage(seed, size = 0x4000) {
  const rom = new Uint8Array(size);
  for (let i = 0; i < size; i++) rom[i] = (seed + i) & 0xFF;
  return rom;
}

/**
 * Instance de `TestVideo` actuellement câblée, ou `null`.
 *
 * ⚠ CONTRAINTE STRUCTURANTE : `Palette_Colors` et `ROM_Manager` sont des
 * singletons de module (des `const` de portée fichier). Deux `TestVideo`
 * vivants en même temps ne peuvent pas coexister : le second appel à `link()`
 * vole les dépendances au premier, qui se retrouve alors à lire les maquettes
 * CRTC/Display de l'autre instance. Résultat : des zéros silencieux, et donc
 * des tests verts et faux — le pire des Modes d'échec.
 *
 * Plutôt que de documenter la contrainte, on la rend impossible à rater : la
 * construction d'une instance **périme** l'instance précédente, et tout accès
 * à un singleton depuis une instance périmée lève une erreur explicite.
 *
 * - Construction séquentielle (une instance par test) : normale et sans coût.
 * - Deux instances vivantes simultanément : la première devient périmée, et le
 *   test qui continue à l'utiliser échoue bruyamment au lieu de lire les
 *   maquettes de l'autre et d'obtenir des zéros silencieux.
 */
let _activeInstance = null;

/**
 * Machine vidéo de test : Gate Array + gestion mémoire, avec des maquettes
 * pour le CRTC (MC6845), le gestionnaire de synchronisation (Display) et
 * l'ASIC — les trois seules sources de signaux que le GA consomme.
 *
 * Toutes les maquettes sont des objets simples dont on lit et écrit les
 * propriétés directement depuis les tests : pas de DSL, pas de spies. Les
 * effets de bord sont journalisés dans des tableaux/compteurs consultables.
 */
export class TestVideo {
  /**
   * @param {object}  [options]
   * @param {number}  [options.machineType=2]  2 = 6128, 4 = 6128+ (CPC+)
   * @param {boolean} [options.ramExpansion]    extension RAM 512 Ko
   */
  constructor({ machineType = 2, ramExpansion = false } = {}) {
    // L'instance précédente devient périmée (voir la note sur les singletons).
    if (_activeInstance !== null) _activeInstance._stale = true;

    const { Palette_Colors, ROM_Manager, Memory_Manager } = loadVideoCore();
    this._stale = false;
    _activeInstance = this;

    // Singletons exposés via des accesseurs : c'est le seul endroit où l'on
    // peut détecter un usage depuis une instance périmée.
    Object.defineProperty(this, 'ga', {
      get: () => { this._assertLive('ga'); return Palette_Colors; },
    });
    Object.defineProperty(this, 'rom', {
      get: () => { this._assertLive('rom'); return ROM_Manager; },
    });
    Object.defineProperty(this, 'mem', {
      get: () => { this._assertLive('mem'); return Memory_Manager; },
    });
    /** RAM ASIC mappée en page 1 sur CPC+. @type {Uint8Array} */
    this.asicRam = new Uint8Array(0x4000);

    /** Maquette CRTC (MC6845). @type {object} */
    this.crtc = {
      hsyncActive: false,
      vsyncActive: false,
      vcc: 0,
      vlc: 0,
      vlcCrtc: 0,
      maRow: 0,
      border: false,
    };

    /** Maquette gestionnaire de synchronisation (Display). @type {object} */
    this.display = {
      pixelIndex: 0,
      lineBufferOffset: 0,
      lineBufferLimit: 0x100,
      vblankCounter: 0,
      advancePixel: 0,
      syncPhase: 0,
      triggerVBlank: 0,
      adjustPLL: 0,
    };

    /** Maquette ASIC + contrôleur DMA. @type {object} */
    this.asic = { locked: false, pri: 0, ivr: 0, statusControl: 0, dmaUpdate: 0 };

    /** Journal des écritures de palette. @type {{pen:number, value:number}[]} */
    this.paletteWrites = [];
    /** Journal des changements de mode de rendu. @type {number[]} */
    this.renderModes = [];
    /** Journal des mots de 16 bits passés au renderer. @type {number[]} */
    this.renderedWords = [];
    /** Compteurs de rendu. @type {{blank:number, border:number, skip:number}} */
    this.rendered = { blank: 0, border: 0, skip: 0 };
    /** Appels à `selectAsicRom`. @type {number[]} */
    this.selectAsicRomCalls = [];
    /** Appels à `updateRomConfig`. @type {number[]} */
    this.updateRomConfigCalls = [];

    const self = this;

    // ── Câblage, reproduit à l'identique de CPC_Bus.js ──────────────────────
    // Memory_Manager porte `machineType` et `ramExpansion` : sans ce link(),
    // `updateBanking` testerait toujours les valeurs par défaut (6128 sans
    // extension), et les tests de banque RAM passeraient pour une raison
    // entièrement fausse.
    Memory_Manager.link({ machineType, ramExpansion });

    ROM_Manager.link({
      machineType,
      ramExpansion,
      updatePaletteRom: (val) => { self.ga.romConfig = val; },
      readAsic: (offset) => self.asicRam[offset],
      writeAsic: (offset, val) => { self.asicRam[offset] = val; },
    });

    Palette_Colors.link({
      machineType,
      getMonitorPalette: () => MONITOR_PALETTE,
      getHsyncActive: () => self.crtc.hsyncActive,
      getVsyncActive: () => self.crtc.vsyncActive,
      getVcc: () => self.crtc.vcc,
      getVlcCrtc: () => self.crtc.vlcCrtc,
      getBorder: () => self.crtc.border,
      getMaRow: () => self.crtc.maRow,
      getVlc: () => self.crtc.vlc,
      getRamArrayRef: () => Memory_Manager.ramData,
      getPixelIndex: () => self.display.pixelIndex,
      getLineBufferOffset: () => self.display.lineBufferOffset,
      getLineBufferLimit: () => self.display.lineBufferLimit,
      getVblankCounter: () => self.display.vblankCounter,
      syncPhase: () => { self.display.syncPhase++; },
      triggerVBlank: () => { self.display.triggerVBlank++; },
      adjustPLL: () => { self.display.adjustPLL++; },
      advancePixel: () => { self.display.advancePixel++; },
      renderBlank: () => { self.rendered.blank++; },
      renderBorder: () => { self.rendered.border++; },
      skipRender: () => { self.rendered.skip++; },
      renderPixelFunc: (word) => { self.renderedWords.push(word); },
      setHwPalette: (pen, val) => { self.paletteWrites.push({ pen, value: val }); },
      setRenderMode: (mode) => { self.renderModes.push(mode); },
      getAsicLocked: () => self.asic.locked,
      getAsicPri: () => self.asic.pri,
      getAsicIvr: () => self.asic.ivr,
      getDmaStatusControl: () => self.asic.statusControl,
      setDmaStatusControl: (val) => { self.asic.statusControl = val; },
      triggerAsicDmaUpdate: () => { self.asic.dmaUpdate++; },
      selectAsicRom: (n) => { self.selectAsicRomCalls.push(n); ROM_Manager.selectAsicRom(n); },
      updateRomConfig: (cfg) => {
        self.updateRomConfigCalls.push(cfg);
        ROM_Manager.updateRomConfig(cfg);
      },
    });

    this.ga.init();
    this.ga.reset();
    ROM_Manager.reset();
    Memory_Manager.reset();
  }

  /**
   * Synchronise l'état interne du Gate Array avec les maquettes.
   *
   * ⚠ `tick()` recalcule `videoAddress` et `border` depuis le CRTC **à la
   * fin** de la fonction. Un seul `tick()` après avoir changé `crtc.maRow` ou
   * `crtc.border` lit donc encore l'adresse et le drapeau du tick précédent.
   * Pour partir d'un état cohérent, il faut deux ticks : le premier aligne,
   * le second produit l'effet observé.
   *
   * @returns {this}
   */
  prime() {
    this.ga.tick();
    return this;
  }

  /**
   * Simule une ligne de scan : front montant de HSync, `cycles` T-states de
   * pixel, puis front descendant (qui est ce qui fait avancer `tickScanline`).
   *
   * L'ordre est celui de `Emulator_Core.executeTicks` : `pal.checkInterrupts()`
   * est appelé à chaque T-state, une fois le CRTC à jour.
   * @param {number} [cycles=10] T-states entre les deux fronts
   */
  runScanline(cycles = 10) {
    this.crtc.hsyncActive = true;
    this.ga.checkInterrupts();
    for (let i = 0; i < cycles; i++) this.ga.checkInterrupts();
    this.crtc.hsyncActive = false;
    this.ga.checkInterrupts();
  }

  /**
   * Simule `lines` lignes de scan complètes.
   * @param {number} [lines=312] 312 = une frame CPC
   * @param {number} [cycles=10]
   */
  runFrame(lines = 312, cycles = 10) {
    for (let i = 0; i < lines; i++) this.runScanline(cycles);
  }

  /**
   * Déclenche (ou lève) VSync et propage l'état au Gate Array.
   * @param {boolean} active
   */
  setVsync(active) {
    this.crtc.vsyncActive = active;
    this.ga.checkInterrupts();
  }

  /**
   * Écrit un `OUT (port), valeur` sur le Gate Array.
   * @param {number} addr  adresse de port (doit avoir A15:A14 = 01)
   * @param {number} data  octet de commande
   */
  gaOut(addr, data) {
    this.ga.writePort(addr, data);
  }

  /**
   * Vérifie que cette instance est encore celle qui détient le câblage.
   * @param {string} quoi  nom du singleton, pour le message d'erreur
   */
  _assertLive(quoi) {
    if (this._stale) {
      throw new Error(
        `gatearray-harness: cette TestVideo est périmée (accès à '${quoi}'). ` +
          'Une autre instance a été construite entre-temps et a repris le ' +
          'câblage des singletons du moteur. Les deux instances ne peuvent pas ' +
          'coexister : n\'en utilisez qu\'une à la fois, et appelez dispose() ' +
          'avant d\'en créer une autre dans le même test.',
      );
    }
  }

  /**
   * Rend l'instance sans changer le câblage. Utile pour documenter qu'on a
   * fini avec elle ; la construction d'une nouvelle instance la périmerait de
   * toute façon.
   * @returns {this}
   */
  dispose() {
    if (_activeInstance === this) _activeInstance = null;
    this._stale = true;
    return this;
  }

  /** @returns {boolean} le bit 7 (interruption en attente) est-il levé ? */
  get irqPending() {
    return (this.ga.gaIntStatus & 0x80) !== 0;
  }

  /** Vide les journaux sans toucher à l'état. @returns {this} */
  clearLogs() {
    this.paletteWrites.length = 0;
    this.renderModes.length = 0;
    this.renderedWords.length = 0;
    this.rendered.blank = 0;
    this.rendered.border = 0;
    this.rendered.skip = 0;
    this.selectAsicRomCalls.length = 0;
    this.updateRomConfigCalls.length = 0;
    return this;
  }
}
