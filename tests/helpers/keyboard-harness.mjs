/**
 * @file tests/helpers/keyboard-harness.mjs
 * @description Harnais de test pour le clavier CPC et sa table de correspondance.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CHARGEMENT MANUEL
 * ─────────────────────────────────────────────────────────────────────────────
 * Même raison que pour `Z80.js` et `MC6845.js` : ce sont des scripts classiques
 * sans `export`. On les évalue via `vm.runInThisContext` en leur ajoutant une
 * expression d'export, ce qui permet aussi d'attribuer la couverture au vrai
 * fichier source via `filename`.
 *
 * `Keyboard.js` lit les tables lexicales du premier fichier : les deux scripts
 * sont évalués dans le même contexte, `cpc-keyboard-map.js` en premier.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FAUX DOM
 * ─────────────────────────────────────────────────────────────────────────────
 * `init()` enregistre des événements sur `document` et `window`. Le faux DOM
 * conserve leurs callbacks pour que les tests puissent déclencher le blur.
 */

/* eslint-disable no-new-func */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Chemin absolu de la table de correspondance. */
export const KEY_MAP_SOURCE_PATH = resolve(HERE, '../../site/js/core/peripherals/cpc-keyboard-map.js');

/** Chemin absolu du module clavier. */
export const KEYBOARD_SOURCE_PATH = resolve(HERE, '../../site/js/core/peripherals/Keyboard.js');

const _CACHE_KEY = '__KEYBOARD_EXPORT__';

let _core = null;

/**
 * Charge la table puis le module clavier, et expose leurs symboles.
 * @returns {{CPC_INPUT: object, CPC_KEYBOARD_MAPS: object, CPC_KEY_COMMON: object,
 *            CPC_MODIFIER_KEYS: object, CPC_MODIFIER_NAMES: object, CPC_LAYOUTS: string[], detectLayoutFromNavigatorLanguage: Function}}
 */
export function loadKeyboard() {
  if (_core !== null) return _core;
  if (globalThis[_CACHE_KEY]) return globalThis[_CACHE_KEY];

  // Le bootstrap du script consulte document.readyState : installer le DOM
  // minimal avant l'évaluation évite toute dépendance au navigateur réel.
  if (globalThis.window === undefined) {
    globalThis.window = { addEventListener() {}, removeEventListener() {} };
  }
  if (globalThis.document === undefined) {
    globalThis.document = {
      readyState: 'complete',
      addEventListener() {},
      getElementById: () => null,
      querySelector: () => null,
    };
  }
  if (globalThis.UI_Manager === undefined) {
    globalThis.UI_Manager = { bindKeyboard() {} };
  }

  const mapSource = readFileSync(KEY_MAP_SOURCE_PATH, 'utf8');
  runInThisContext(
    `${mapSource}\n;globalThis[${JSON.stringify(_CACHE_KEY)}] = {
       map: CPC_KEY_MAP_DATA,
       };`,
    { filename: KEY_MAP_SOURCE_PATH },
  );
  Object.assign(globalThis[_CACHE_KEY], globalThis[_CACHE_KEY].map);
  delete globalThis[_CACHE_KEY].map;

  const kbSource = readFileSync(KEYBOARD_SOURCE_PATH, 'utf8');
  runInThisContext(
    `${kbSource}\n;globalThis[${JSON.stringify(_CACHE_KEY)}].CPC_INPUT = CPC_INPUT;`,
    { filename: KEYBOARD_SOURCE_PATH },
  );

  const loaded = globalThis[_CACHE_KEY];
  for (const s of ['CPC_INPUT', 'CPC_KEYBOARD_MAPS', 'CPC_MODIFIER_KEYS']) {
    if (loaded[s] === undefined) {
      throw new Error(
        `keyboard-harness: ${s} introuvable. Le fichier source a peut-être changé de forme.`,
      );
    }
  }
  _core = loaded;
  return _core;
}

/**
 * Construit un faux `document` / `window` suffisants pour `init()`.
 * @returns {{document: object, window: object, listeners: Map<string, Function[]>}}
 */
export function fauxDom() {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map();
  const target = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
  };
  const doc = {
    readyState: 'complete',
    getElementById: () => null,
    querySelector: () => null,
    addEventListener: target.addEventListener,
  };
  return { document: doc, window: target, listeners };
}

/**
 * Installe un faux DOM global et renvoie le gestionnaire de clavier, déjà
 * initialisé et réglé sur une disposition.
 * @param {"US"|"FR"|"ES"} [lang="US"]
 * @returns {{kb: object, dom: ReturnType<fauxDom>}}
 */
export function clavierPret(lang = 'US') {
  const { CPC_INPUT } = loadKeyboard();
  const keyboard = new CPC_INPUT.Keyboard();
  const autoType = new CPC_INPUT.AutoType(keyboard);
  const dom = fauxDom();

  const saved = {
    document: globalThis.document,
    window: globalThis.window,
  };
  globalThis.document = dom.document;
  globalThis.window = dom.window;

  // `link()` injecte les deux accesseurs dont le module a besoin.
  keyboard.link({
    getSelectedRow: () => 0,
    getJoystickEnabled: () => false,
  });
  keyboard.init();
  keyboard.setLayout(lang);

  return {
    kb: keyboard,
    autoType,
    dom,
    /** Restaure le DOM global — à appeler dans un `afterEach`. */
    restaure() {
      globalThis.document = saved.document;
      globalThis.window = saved.window;
    },
  };
}

/**
 * Construit un faux `KeyboardEvent`.
 * @param {string} code
 * @returns {{code: string, preventDefault: Function, defaultPrevented: boolean}}
 */
export function evenement(code) {
  return {
    code,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
}
