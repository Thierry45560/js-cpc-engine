/**
 * @file tests/video/crtc-ui.test.mjs
 * @description `CRTC_Manager.updateUI()` — projection de l'état CRTC dans le DOM.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI CE TEST EXISTE
 * ─────────────────────────────────────────────────────────────────────────────
 * La migration jQuery → DOM natif a réécrit `updateUI()`, qui concentrait à lui
 * seul 16 appels `$(...)` : l'affichage de la sidebar « Debug » (18 cellules de
 * registres, 6 compteurs, 3 indicateurs d'activité et la case « border »).
 *
 * La réécriture native a **ajouté** des branches absentes de la version jQuery :
 * `if (!cellule) continue` (jQuery ne levait pas sur un sélecteur vide),
 * `if (cellule)` sur les compteurs et sur la case à cocher, et la fonction
 * locale `surligner()` avec son `classList.toggle(cls, !!actif)`. Sans test,
 * ces branches seraient du code mort non vérifié — c'est-à-dire exactement la
 * régression de couverture que la migration a provoquée sur ce fichier.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FAUX DOM
 * ─────────────────────────────────────────────────────────────────────────────
 * `MC6845.js` est un script classique évalué via `vm.runInThisContext` : son
 * `document` est résolu **à l'appel**, pas au chargement. On peut donc poser un
 * `globalThis.document` minimal et le retirer ensuite, sans toucher au harnais.
 *
 * Le faux DOM couvre volontairement l'API réellement utilisée par `updateUI()` —
 * `querySelector`, `textContent`, `classList.add/remove/toggle`, `checked` — et
 * rien d'autre : un stub plus bavard donnerait une fausse impression de couverture.
 *
 * `toHex8` est fourni par le harnais (cf. `crtc-harness.mjs`), comme `toHex16`
 * l'est pour l'ASIC.
 *
 * Cas volontairement **non** testé : l'absence de `document`. `updateUI()` est
 * une projection d'interface, elle n'a de sens que dans un navigateur ; exiger
 * qu'elle survive sans DOM reviendrait à tester un `typeof document` que rien
 * n'appelle. Le harnais CI fournit donc toujours un `document` minimal.
 */

/* eslint-disable no-new-func */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { loadCrtc } from '../helpers/crtc-harness.mjs';

/**
 * Installe un `document` minimal dont `querySelector` sert des cellules
 * tracées. Les sélecteurs inconnus renvoient `null` : c'est le cas réel quand
 * la page n'expose pas la sidebar de debug.
 * @param {Set<string>} connus sélecteurs pour lesquels renvoyer une cellule
 * @returns {Map<string, object>} sélecteur → cellule tracée
 */
function poserFauxDom(connus) {
  const cellules = new Map();
  globalThis.document = {
    querySelector(sel) {
      if (!connus.has(sel)) return null;
      if (!cellules.has(sel)) {
        const classes = new Set();
        const cellule = {
          selector: sel,
          textContent: null,
          checked: false,
          classes,
          classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            // `classList.toggle(c, force)` : l'API native accepte le booléen
            // alors que le `.toggleClass(c)` de jQuery l'ignorait.
            toggle: (c, force) => {
              const actif = force === undefined ? !classes.has(c) : !!force;
              if (actif) classes.add(c);
              else classes.delete(c);
              return actif;
            },
          },
        };
        cellules.set(sel, cellule);
      }
      return cellules.get(sel);
    },
  };
  return cellules;
}

const TOUS = new Set(
  ['#crtc_vcc', '#crtc_vlc', '#crtc_vsc', '#crtc_vtac', '#crtc_hcc', '#crtc_hsc', '#border']
    .concat(Array.from({ length: 18 }, (_, i) => `#crtc_r${i}`))
);

describe('CRTC — projection DOM', () => {
  let crtc;

  beforeEach(() => {
    crtc = loadCrtc().CRTC_Manager;
    crtc.reset();
    crtc.registers.fill(0);
  });

  afterEach(() => {
    delete globalThis.document;
  });

  it('écrit les 18 registres en hexadécimal et ne surligne que le registre sélectionné', () => {
    const cellules = poserFauxDom(TOUS);
    crtc.registers[3] = 0x2A;
    crtc.selectedRegister = 3;

    crtc.updateUI();

    expect(cellules.get('#crtc_r0').textContent).toBe('00');
    // Minuscules : `toHex8` est `toString(16).padStart(2, '0')`.
    expect(cellules.get('#crtc_r3').textContent).toBe('2a');
    expect(cellules.get('#crtc_r3').classes.has('dasm-selected')).toBe(true);
    // Les 17 autres ne doivent pas rester surlignées d'un appel précédent.
    expect(cellules.get('#crtc_r0').classes.has('dasm-selected')).toBe(false);
    expect(cellules.get('#crtc_r17').classes.has('dasm-selected')).toBe(false);
  });

  it('écrit les six compteurs', () => {
    const cellules = poserFauxDom(TOUS);
    crtc.vcc = 0x11;
    crtc.vlc_crtc = 0x22;
    crtc.vsc_counter = 0x33;
    crtc.vtac_counter = 0x44;
    crtc.hcc_counter = 0x55;
    crtc.hsyncCounter = 0x66;

    crtc.updateUI();

    expect(cellules.get('#crtc_vcc').textContent).toBe('11');
    expect(cellules.get('#crtc_vlc').textContent).toBe('22');
    expect(cellules.get('#crtc_vsc').textContent).toBe('33');
    expect(cellules.get('#crtc_vtac').textContent).toBe('44');
    expect(cellules.get('#crtc_hcc').textContent).toBe('55');
    expect(cellules.get('#crtc_hsc').textContent).toBe('66');
  });

  it('surligne chaque indicateur d\'activité selon l\'état du CRTC', () => {
    const cellules = poserFauxDom(TOUS);

    crtc.hsyncActive = true;
    crtc.vsyncActive = false;
    crtc.vblankActive = true;
    crtc.updateUI();

    expect(cellules.get('#crtc_hsc').classes.has('dasm-selected')).toBe(true);
    expect(cellules.get('#crtc_vsc').classes.has('dasm-selected')).toBe(false);
    expect(cellules.get('#crtc_vtac').classes.has('dasm-selected')).toBe(true);

    // Bascule : un second appel doit retirer la classe, pas l'ajouter deux fois.
    crtc.hsyncActive = false;
    crtc.updateUI();
    expect(cellules.get('#crtc_hsc').classes.has('dasm-selected')).toBe(false);
  });

  it('pilote la case « border » par une propriété booléenne', () => {
    const cellules = poserFauxDom(TOUS);

    crtc.border = 1;
    crtc.updateUI();
    expect(cellules.get('#border').checked).toBe(true);

    crtc.border = 0;
    crtc.updateUI();
    expect(cellules.get('#border').checked).toBe(false);
  });

  it('ne lève pas quand la sidebar de debug est absente', () => {
    poserFauxDom(new Set()); // querySelector renvoie toujours null
    expect(() => crtc.updateUI()).not.toThrow();
  });
});
