/**
 * @file tests/system/config-rom.test.mjs
 * @description Changement de firmware — purge du cache et rechargement automatique.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI UN RECHARGEMENT DE PAGE
 * ─────────────────────────────────────────────────────────────────────────────
 * Changer de ROM ne consiste pas à recharger un fichier : le firmware injecte
 * du code, sélectionne un slot, configure la palette, et modifie l'état global
 * de dizaines d'objets. Rejouer tout cela à chaud laissait derrière lui des
 * états incohérents — et c'est ce qui obligeait l'utilisateur à rafraîchir la
 * page à la main.
 *
 * La seule remise à zéro vraiment fiable étant de reconstruire le contexte
 * JavaScript, le rechargement de page est la bonne réponse : il n'y a plus
 * d'état résiduel puisqu'il n'y a plus de contexte.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LE PIÈGE : NE PAS PERDRE LE CHOIX
 * ─────────────────────────────────────────────────────────────────────────────
 * Un rechargement efface le formulaire… et le cookie lui survit. C'est
 * précisément ce qui rend l'opération possible : `loadConfiguration()` relit
 * `getCookie("firmware")` au démarrage et recharge la ROM correspondante. Le
 * cookie doit donc être POSÉ AVANT de recharger, sinon la page repartirait sur
 * le firmware précédent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI LE MODULE EST ÉVALUÉ À CHAQUE TEST
 * ─────────────────────────────────────────────────────────────────────────────
 * `Config.js` est un script classique sans `export`, évalué via
 * `vm.runInNewContext`. On l'évalue dans un CONTEXNE NEUF à chaque test : le
 * contexte global de Node est partagé, et un second `const Config_Manager`
 * y serait une redéclaration — sans compter que les stubs du premier test
 * resteraient en place pour les suivants.
 */

/* eslint-disable no-new-func */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const CONFIG_SOURCE = resolve(process.cwd(), 'site/js/core/system/Config.js');

/** Les globals que `applyConfiguration()` touche, et qu'on restaure après coup. */
const GLOBAUX = [
  'alert', 'location', 'getCookie', 'setCookie', 'document', 'window',
  'CPC_INPUT', 'ROM_Manager', 'Video_Hardware', 'Palette_Colors',
  'Audio_Output', 'CRTC_Manager', 'CRTC_Type0', 'CRTC_Type1', 'CRTC_Type2',
  'CRTC_Type3', 'Floppy_Drive_A', 'Floppy_Drive_B', 'Tape_Recorder',
  'Memory_Manager', 'Machine_Type',
];

function scenario(firmwareChoisi, firmwareActif) {
  const cookies = {};
  let rechargements = 0;
  const fichiers = { 'ROM/english/464.ROM': 'ancienne image' };

  const radios = {
    brand: 'amstrad', firmware: firmwareChoisi, monitor: 'colour',
    audio: 'stereo', crtc: 'type1',
  };

  // Le sandbox fournit tous les globals que le script attend. `window` et
  // `document` sont de simples objets : le code ne fait que lire dessus.
  const sandbox = {
    alert: () => {},
    getCookie: (nom) => cookies[nom],
    setCookie: (nom, valeur) => { cookies[nom] = valeur; },
    location: { reload() { rechargements++; } },
    window: { files: fichiers },

    CPC_INPUT: {
      keyboard: { setLayout: () => {} },
      detectLayoutFromNavigatorLanguage: () => 'US',
    },
    ROM_Manager: { loadROMs() {} },
    Video_Hardware: {
      paletteColor: ['PAL_C'], paletteGreen: ['PAL_V'], paletteGray: ['PAL_N'],
      hwPalette: new Array(32).fill(0),
    },
    Palette_Colors: {
      hwColorIndex: new Array(32).fill(0), PAL_C: 0, PAL_V: 0, PAL_N: 0,
    },
    Audio_Output: { Mono() {}, Stereo() {}, setVolume() {} },
    CRTC_Manager: { P() {} },
    CRTC_Type0: 'T0', CRTC_Type1: 'T1',
    CRTC_Type2: 'T2', CRTC_Type3: 'T3',
    Floppy_Drive_A: {}, Floppy_Drive_B: {},
    Tape_Recorder: {}, Memory_Manager: {},
    Machine_Type: 0,

    document: {
      querySelector(sel) {
        const m = /name=([^\]]+)/.exec(sel);
        if (m) {
          return { value: radios[m[1]], checked: true, getClientRects: () => [{}] };
        }
        return { checked: false, getClientRects: () => [], style: {}, click() {} };
      },
    },
  };

  // `Config.js` déclare `const Config_Manager` : c'est une binding LEXICALE du
  // script, pas une propriété du sandbox. On ne peut donc pas la lire
  // comme `sandbox.Config_Manager` — il faut faire évaluer une expression qui
  // la renvoie, comme le font les autres harnais du projet.
  runInNewContext(
    `${readFileSync(CONFIG_SOURCE, 'utf8')}
;globalThis.__sortie = { Config_Manager };`,
    sandbox,
    { filename: CONFIG_SOURCE },
  );

  const { Config_Manager } = sandbox.__sortie;
  delete sandbox.__sortie;

  // Palette et bancs de mémoire exigent un émulateur complet ; ce test ne porte
  // que sur le rechargement de page.
  Config_Manager.updatePalette = () => {};
  Config_Manager.updateMemoryConfig = () => {};
  Config_Manager.language = firmwareActif;

  return {
    Config_Manager,
    rechargements: () => rechargements,
    cookies,
    fichiers: () => sandbox.window.files,
  };
}

describe('Config_Manager — changement de firmware', () => {

  it('recharge la page quand le firmware choisi diffère du firmware actif', () => {
    const s = scenario('french', 'english');
    s.Config_Manager.applyConfiguration();

    expect(s.rechargements()).toBe(1);
  });

  it('ne recharge PAS la page quand le firmware est inchangé', () => {
    // Sans cette garde, le simple fait de fermer la fenêtre de réglage
    // rechargerait la page — et ferait perdre la partie en cours.
    const s = scenario('french', 'french');
    s.Config_Manager.applyConfiguration();

    expect(s.rechargements()).toBe(0);
  });

  it('écrit le cookie firmware AVANT de recharger', () => {
    // L'ordre est essentiel : `loadConfiguration()` relit ce cookie au
    // démarrage. S'il n'était pas posé, la page repartirait sur l'ancien
    // firmware et le changement serait sans effet.
    const s = scenario('spanish', 'english');
    s.Config_Manager.applyConfiguration();

    expect(s.cookies.firmware).toBe('spanish');
    expect(s.rechargements()).toBe(1);
  });

  it('purges le cache des ROM avant de recharger', () => {
    // `window.files` mémoïse les images par chemin : sans purge, la nouvelle
    // machine repartirait avec les anciennes en mémoire.
    const s = scenario('french', 'english');
    expect(s.fichiers()).not.toEqual({});

    s.Config_Manager.applyConfiguration();

    expect(s.fichiers()).toEqual({});
  });

  it('ne boucle pas au premier chargement, où aucun firmware n\'est encore actif', () => {
    // Au boot, `Config_Manager.language` vaut `null` : `loadConfiguration()`
    // n'a pas encore tourné. Recharger sur cette base ferait boucler la page
    // indéfiniment — le cas le plus grave possible ici.
    const s = scenario('french', null);

    s.Config_Manager.applyConfiguration();
    expect(s.rechargements()).toBe(0);

    // Le firmware est bien activo, et les appels suivants ne rechargent plus.
    expect(s.Config_Manager.language).toBe('french');
    s.Config_Manager.applyConfiguration();
    expect(s.rechargements()).toBe(0);
  });

  it('applique le changement au second appel, une fois le rechargement effectué', () => {
    // Séquence complète : un changement déclenche le rechargement, puis la page
    // redémarre et applique normalement le choix porté par le cookie — sans
    // déclencher un second rechargement.
    const s = scenario('french', 'english');
    s.Config_Manager.applyConfiguration();
    expect(s.rechargements()).toBe(1);

    // Nouveau contexte de page : `language` repart à null.
    const apres = scenario('french', null);
    apres.Config_Manager.applyConfiguration();
    expect(apres.rechargements()).toBe(0);
    expect(apres.cookies.firmware).toBeUndefined();
  });
});