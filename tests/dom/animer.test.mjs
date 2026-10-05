/**
 * @file tests/dom/animer.test.mjs
 * @description `animer()` — helper d'apparition/disparition (Web Animations API).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI UN TEST À PART
 * ─────────────────────────────────────────────────────────────────────────────
 * `animer()` est le seul helper de `UI_DOM.js` sans équivalent direct en DOM
 * natif : jQuery fournissait `fadeIn` / `fadeOut` / `slideUp` / `slideDown` en
 * interne. C'est donc le point le plus susceptible d'une divergence silencieuse
 * : la Web Animations API ne ressemble pas au moteur d'animation de jQuery.
 *
 * Deux différences ont été corrigées à la relecture du diff (et sont donc
 * verrouillées ici) :
 *
 * 1. **Composition au lieu de remplacement.** jQuery annulait l'animation en
 *    cours avant d'en lancer une autre. `element.animate()` *compose* les
 *    animations : un `fadeIn` suivi d'un `fadeOut` laisse les deux vivantes, et
 *    avec `fill: 'forwards'` la première pousse toujours l'opacité vers 1 après
 *    que la seconde a fini. Symptôme : un double-clic rapide sur « Settings »
 *    laisse le panneau bloqué à moitié visible.
 * 2. **Élément déjà masqué.** `.fadeOut()` sur un élément caché ne faisait
 *    rien ; l'équivalent naïf aurait lancé une animation invisible.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FAUX DOM
 * ─────────────────────────────────────────────────────────────────────────────
 * `UI_DOM.js` est un script classique évalué via `vm.runInThisContext` : son
 * `document` est résolu à l'appel. On pose donc un `globalThis.document` qui
 * reproduit *fidèlement* la partie de la Web Animations API utilisée — c'est le
 * point : un stub qui ne modéliserait pas la composition ne testerait rien.
 */

/* eslint-disable no-new-func */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UI_SOURCE = resolve(RACINE, 'site/js/adapters/dom/UI_DOM.js');
const CACHE = '__UI_DOM_EXPORT__';

/**
 * Charge `UI_DOM.js` et récupère `animer`.
 * `UI_DOM.js` ne référence le DOM qu'à l'appel (jamais au chargement), donc
 * aucun autre global n'est nécessaire ici.
 * @returns {(selecteur: string, afficher: boolean, ms: number) => void}
 */
function chargerAnimer() {
  if (globalThis[CACHE]) return globalThis[CACHE].animer;
  const source = readFileSync(UI_SOURCE, 'utf8');
  runInThisContext(
    `${source}\n;globalThis[${JSON.stringify(CACHE)}] = { animer: animer };`,
    { filename: UI_SOURCE },
  );
  return globalThis[CACHE].animer;
}

/**
 * Nœud factice exposant l'API réellement utilisée par `animer()`.
 * `getAnimations()` renvoie les animations encore vivantes — c'est ce qui
 * permet de vérifier que la précédente est bien annulée.
 *
 * `cssDisplay` modélise ce que la feuille de style impose, `style.display` ce
 * que le script pose en inline. C'est la distinction qui compte : les modales
 * de `cpc-blank.html` sont masquées par `.modal { display: none }`, jamais en
 * inline, si bien que lire `style.display` seul croyait la modale visible.
 *
 * @param {{cssDisplay?: string, display?: string, tag?: string}} [opts]
 */
function fauxNoeud({ cssDisplay = '', display = '', tag = 'DIV' } = {}) {
  const noeud = {
    tagName: tag,
    cssDisplay,
    style: { display },
    animations: [],
    // Le style calculé suit la cascade : l'inline l'emporte sur la feuille.
    get displayCalcule() { return this.style.display || this.cssDisplay; },
    getAnimations() {
      return this.animations.filter((a) => !a.annulee);
    },
    animate(keyframes, options) {
      const anim = {
        keyframes,
        options,
        annulee: false,
        onfinish: null,
        cancel() { this.annulee = true; },
        // Simule la fin d'une animation : appelle `onfinish` si elle a survécu.
        finir() { if (!this.annulee && this.onfinish) this.onfinish(); },
      };
      this.animations.push(anim);
      return anim;
    },
  };
  return noeud;
}

describe('UI_DOM — animer()', () => {
  let animer;
  let noeuds;
  let noeud;

  beforeEach(() => {
    animer = chargerAnimer();
    noeud = fauxNoeud();
    noeuds = [noeud];
    globalThis.document = { querySelectorAll: () => noeuds };
    globalThis.getComputedStyle = (n) => ({ display: n.displayCalcule });
  });

  afterEach(() => {
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  });

  it('affiche un élément masqué puis anime de 0 à 1', () => {
    noeud.style.display = 'none';
    animer('#panneau', true, 200);

    // Le masquage est levé en posant explicitement le display du type : c'est
    // ce qui prend le dessus sur un éventuel `display: none` de la feuille.
    expect(noeud.style.display).toBe('block');
    expect(noeud.animations).toHaveLength(1);
    expect(noeud.animations[0].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(noeud.animations[0].options).toEqual({ duration: 200, fill: 'forwards' });
  });

  it('masque un élément visible une fois l\'animation terminée', () => {
    animer('#panneau', false, 150);

    // Tant que l'animation court, l'élément reste dans le flux.
    expect(noeud.style.display).toBe('');
    noeud.animations[0].finir();
    expect(noeud.style.display).toBe('none');
  });

  it('annule l\'animation précédente avant d\'en lancer une', () => {
    // Le scénario du bug : double-clic sur « Settings ». Le panneau est
    // `display:none` au chargement (cpc-minimal.html:544), donc le premier clic
    // joue bien le fadeIn, et le second 50 ms plus tard joue le fadeOut.
    noeud.style.display = 'none';
    animer('#panneau', true, 200);
    expect(noeud.animations).toHaveLength(1);
    animer('#panneau', false, 200);

    expect(noeud.animations).toHaveLength(2);
    expect(noeud.animations[0].annulee).toBe(true);   // le fadeIn est annulé
    expect(noeud.animations[1].annulee).toBe(false);  // le fadeOut reste actif

    // Et surtout : le fadeIn annulé ne rappelle pas son `onfinish`…
    noeud.animations[0].finir();
    expect(noeud.style.display).not.toBe('none');     // …ni ne masque le panneau
    // …tandis que le fadeOut, lui, masque bien.
    noeud.animations[1].finir();
    expect(noeud.style.display).toBe('none');
  });

  it('ne fait rien sur un élément déjà dans l\'état demandé', () => {
    // jQuery : `.fadeOut()` sur un élément déjà masqué est un no-op.
    noeud.style.display = 'none';
    animer('#panneau', false, 200);
    expect(noeud.animations).toHaveLength(0);

    // Symétriquement, `.fadeIn()` sur un élément déjà visible. C'est le cas au
    // chargement de `#printer-output`, laissé vide mais affiché.
    noeud.style.display = '';
    animer('#panneau', true, 200);
    expect(noeud.animations).toHaveLength(0);
  });

  it('traite tous les éléments du sélecteur', () => {
    noeuds = [fauxNoeud(), fauxNoeud({ display: 'none' })];
    animer('#panneau', true, 200);
    expect(noeuds[0].animations).toHaveLength(0);  // déjà visible : no-op
    expect(noeuds[1].animations).toHaveLength(1);  // était masqué : animé
    expect(noeuds[1].style.display).toBe('block');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // RÉGRESSION — le bouton « Configuration » mettait le Z80 en pause sans
  // afficher la fenêtre.
  //
  // `#option-panel` et `#option-panel-overlay` sont masqués par la FEUILLE DE
  // STYLE (`.modal { display: none }`), et non par un `style` inline. Or
  // `animer()` lisait `noeud.style.display`, qui est vide au chargement : le
  // test « déjà visible » disait donc vrai, la fonction retournait aussitôt,
  // et rien ne s'affichait. Seule la ligne précédente — `pauseEmulator()` —
  // s'exécutait, ce qui produit exactement le symptôme rapporté : le moteur se
  // met en pause, la fenêtre reste fermée.
  //
  // La visibilité se lit donc sur le style CALCULÉ, qui tient compte de la
  // cascade, et non plus sur le style inline.
  // ───────────────────────────────────────────────────────────────────────────
  it('détecte un élément masqué par la feuille de style, pas seulement en inline', () => {
    noeud = fauxNoeud({ cssDisplay: 'none' });
    noeuds = [noeud];

    animer('#panneau', true, 200);

    expect(noeud.animations).toHaveLength(1);
    expect(noeud.animations[0].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    // Le masquage CSS doit être levé en inline pour que la modale apparaisse.
    expect(noeud.style.display).not.toBe('');
  });

  it('masque en inline un élément que la feuille de style cachait', () => {
    noeud = fauxNoeud({ cssDisplay: 'none' });
    noeuds = [noeud];

    animer('#panneau', true, 200);
    animer('#panneau', false, 200);

    // Tant que le fondu de sortie court, la modale reste dans le flux…
    expect(noeud.style.display).not.toBe('none');
    noeud.animations[1].finir();
    // …puis disparaît vraiment.
    expect(noeud.style.display).toBe('none');
  });

  it('reste inerte sur une modale déjà ouverte', () => {
    // Symétrique du précédent : la feuille de style ne la cache pas, l'inline
    // non plus — `.fadeIn()` dessus ne doit donc rien lancer.
    noeud = fauxNoeud({ cssDisplay: 'block' });
    noeuds = [noeud];

    animer('#panneau', true, 200);
    expect(noeud.animations).toHaveLength(0);
  });
});
