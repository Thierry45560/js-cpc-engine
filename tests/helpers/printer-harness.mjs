/**
 * @file tests/helpers/printer-harness.mjs
 * @description Harnais de test pour l'imprimante virtuelle du CPC.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CHARGEMENT MANUEL
 * ─────────────────────────────────────────────────────────────────────────────
 * Même raison que pour le clavier : `Printer.js` est un script classique sans
 * `export`. On l'évalue via `vm.runInThisContext` en lui ajoutant une expression
 * d'export, ce qui attribue aussi la couverture au vrai fichier source.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FAUX DOM
 * ─────────────────────────────────────────────────────────────────────────────
 * `VirtualPrinter` écrit directement dans le DOM (`#printer-output`) et lit
 * `#printer-card`. Le harnais fournit un `document` minimal et un objet
 * `sortie` qui enregistre les lignes produites, afin de pouvoir asserter sur le
 * contenu sans disposer d'un DOM complet.
 */

/* eslint-disable no-new-func */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Chemin absolu du module imprimante. */
export const PRINTER_SOURCE_PATH = resolve(HERE, '../../site/js/core/peripherals/Printer.js');

const _CACHE_KEY = '__PRINTER_EXPORT__';

let _printer = null;

/**
 * Charge `Printer.js` et expose `VirtualPrinter`.
 * @returns {object} L'objet `VirtualPrinter`.
 */
export function loadPrinter() {
  if (_printer !== null) return _printer;

  const source = readFileSync(PRINTER_SOURCE_PATH, 'utf8');
  runInThisContext(
    `${source}\n;globalThis[${JSON.stringify(_CACHE_KEY)}] = VirtualPrinter;`,
    { filename: PRINTER_SOURCE_PATH },
  );

  _printer = globalThis[_CACHE_KEY];
  if (_printer === undefined) {
    throw new Error(
      'printer-harness: VirtualPrinter introuvable. Le fichier source a peut-être changé de forme.',
    );
  }
  return _printer;
}

/**
 * Construit un faux DOM contenant la carte imprimante et sa zone de sortie.
 * @returns {object} Faux document, carte, zone de sortie et lignes produites.
 */
export function fauxDomImprimante() {
  /** Lignes actuellement présentes dans la zone de sortie. @type {Array} */
  const lignes = [];

  const sortie = {
    _html: '',
    scrollTop: 0,
    scrollHeight: 0,
    /** Nœud d'attente, distinct des lignes imprimées. */
    _idle: null,

    /**
     * `innerHTML = ''` doit vider la zone : c'est ainsi que `clear()` efface
     * le listing. Un simple champ ne le ferait pas, et le test « Vider »
     * passerait à vide.
     * @returns {string} Contenu courant.
     */
    get innerHTML() { return sortie._html; },
    set innerHTML(valeur) {
      sortie._html = valeur;
      lignes.length = 0;
      sortie._idle = null;
    },

    /**
     * Simule `appendChild` sur un élément unique.
     * @param {object} noeud Nœud à ajouter.
     */
    appendChild(noeud) {
      // L'état d'attente est un nœud unique : il ne doit pas s'empiler dans la
      // liste des lignes imprimées.
      if (noeud.className === 'printer-idle') {
        sortie._idle = noeud;
        return;
      }
      sortie._idle = null;
      lignes.push(noeud);
    },

    /**
     * Ne prend en charge que le sélecteur utilisé par `Printer.js`.
     * @param {string} sel Sélecteur demandé.
     * @returns {object|null} Nœud correspondant, ou null.
     */
    querySelector(sel) {
      if (sel === '.printer-idle') return sortie._idle;
      return null;
    },
  };

  /**
   * Nœud créé par `createElement`. `remove()` doit_exists : `printLine()`
   * retire l'état d'attente par cette méthode avant d'ajouter sa ligne.
   */
  class NoeudSortie {
    /** @param {string} className Classe CSS du nœud. */
    constructor(className) {
      this.className = className;
      this.textContent = '';
    }

    /** Retire le nœud de la zone de sortie. */
    remove() {
      const index = lignes.indexOf(this);
      if (index >= 0) lignes.splice(index, 1);
      if (sortie._idle === this) sortie._idle = null;
    }
  }

  const card = { style: { display: '' } };

  const doc = {
    getElementById(id) {
      if (id === 'printer-card') return card;
      if (id === 'printer-output') return sortie;
      return null;
    },
    createElement() {
      return new NoeudSortie('');
    },
  };

  return { document: doc, card, sortie, lignes };
}

/**
 * Charge l'imprimante et installe un faux DOM.
 * @returns {{printer: object, dom: object, restaure: Function}} Contexte de test.
 */
export function imprimantePret() {
  const printer = loadPrinter();
  const savedDocument = globalThis.document;
  const dom = fauxDomImprimante();
  globalThis.document = dom.document;

  printer.buffer = '';
  dom.sortie.innerHTML = '';
  dom.sortie._idle = null;
  dom.lignes.length = 0;

  return {
    printer,
    dom,
    /** Restaure le DOM global — à appeler dans un `afterEach`. */
    restaure() {
      globalThis.document = savedDocument;
    },
  };
}

/**
 * Simule une écriture sur le port imprimante (A12 = 0).
 *
 * Le firmware envoie chaque caractère deux fois : passe strobe haute
 * (bit 7 = 1, donnée valide) puis passe strobe basse (bit 7 = 0, donnée
 * verrouillée). Seul le bit 7 = 1 est traité, faute de quoi chaque caractère
 * serait compté deux fois.
 *
 * @param {object} printer Instance `VirtualPrinter`.
 * @param {string} texte Texte à envoyer (sans retour à la ligne).
 * @param {number} [adresse=0x4000] Adresse du port (A12 doit être à 0).
 */
export function ecrirePort(printer, texte, adresse = 0x4000) {
  for (const code of texte) {
    printer.writePort(adresse, 0x80 | code.charCodeAt(0));
  }
}