/**
 * @file tests/video/crtc-timing.test.mjs
 * @description Temporisation du CRTC : compteurs horizontaux et verticaux.
 *
 * C'est ici que les quatre variantes divergent le plus, et c'est la partie du
 * moteur dont les bugs se voient *immédiatement* à l'écran.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TROIS RYTHMES À NE PAS CONFONDRE (mesurés, pas déduits)
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **Une ligne de caractère vaut R0 + 1 ticks.** `tick()` teste
 *    `hcc === R0` *avant* d'incrémenter : `hcc` atteint R0 au tick R0, et le
 *    tick suivant remet le compteur à 0 et appelle `updateVertical`. Utiliser
 *    R0 ticks laisse `updateVertical` jamais appelé.
 *
 * 2. **Une frame vaut (R4 + 1) × (R9 + 1) lignes**, soit 328 pour le mode
 *    40×25 usuel. `vcc` atteint R4 *inclusive* — c'est cette rangée qui
 *    déclenche le VBlank — et chaque rangée occupe R9 + 1 lignes de rastér.
 *
 * 3. **R5 n'allonge PAS la frame** : il ne fait qu'allonger la durée du
 *    VBlank à l'intérieur de la dernière rangée.
 *
 * Enfin, les deux premières frames après `reset()` sont dégénérées : les
 * miroirs `r4_vt`, `r5_vta` et `r9_mra` valent 0 tant que `updateVertical`
 * n'a pas tourné. Tout test vertical passe donc par `settle()`.
 */

import { describe, it, expect } from 'vitest';
import { TestCrtc } from '../helpers/crtc-harness.mjs';

/** Les quatre variantes. */
const TYPES = ['type0', 'type1', 'type2', 'type3'];

/** Longueur d'une frame en lignes, mode 40×25 (R4 = 40, R9 = 7). */
const FRAME = (0x28 + 1) * (0x07 + 1);   // 328

/**
 * Programme le mode 40×25 puis applique les registres de surcharge.
 *
 * R5 vaut 2 par défaut : avec R5 = 0 le VBlank s'ouvre et se referme dans la
 * même ligne, et son drapeau n'est jamais observable à un début de ligne —
 * ce qui rend `measureFrameLines` inutilisable. 2 est de toute façon la valeur
 * que programme le BIOS du CPC.
 *
 * @param {string} type   variante
 * @param {object} [over] registre → valeur
 * @returns {TestCrtc}
 */
function build(type, over) {
  const c = new TestCrtc({ type });
  c.setRegisters([
    0x40, 0x28, 0x30, 0x06,
    0x28, 0x02, 0x19, 0x00,
    0x00, 0x07,
  ]);
  const surcharges = over || {};
  for (const cle of Object.keys(surcharges)) {
    c.setRegister(Number(cle), surcharges[cle]);
  }
  return c;
}

/**
 * Programme, stabilise, puis avance rangée par rangée jusqu'à `vccCible`.
 *
 * On progresse par `runRow()` et non ligne par ligne : `vcc++` et la
 * vérification du VSync n'ont lieu que sur la *dernière* ligne de la rangée.
 * Une boucle «while vcc < n» stopperait au début de la rangée n, avant que
 * la transition ne se soit produite.
 *
 * @param {string} type
 * @param {object}  [over]
 * @param {number}  [vccCible=0]
 * @returns {TestCrtc}
 */
function ready(type, over, vccCible) {
  const cible = vccCible === undefined ? 0 : vccCible;
  const c = build(type, over);
  c.settle();
  c.crtc.vcc = 0;
  c.crtc.vlc_crtc = 0;
  c.crtc.vdisp = false;
  c.crtc.vsyncActive = false;
  c.crtc.vsc_counter = 0;
  c.crtc.hsyncActive = false;

  while (c.crtc.vcc < cible) c.runRow();
  return c;
}

describe('MC6845 — compteur horizontal', () => {
  it('atteint R0 puis reboucle au tick suivant', () => {
    const c = build();
    expect(c.crtc.hcc_counter).toBe(0);
    c.crtc.tick();
    expect(c.crtc.hcc_counter).toBe(1);
    while (c.crtc.hcc_counter !== 0x40) c.crtc.tick();
    expect(c.crtc.hcc_counter).toBe(0x40);
    c.crtc.tick();
    expect(c.crtc.hcc_counter).toBe(0);
  });

  it('ne déborde jamais hcc', () => {
    const c = build();
    for (let i = 0; i < 500; i++) {
      c.crtc.tick();
      expect(c.crtc.hcc_counter).toBeLessThanOrEqual(0x40);
    }
  });

  it('lève hdisp à hcc = R1', () => {
    const c = build();
    c.crtc.hdisp = false;
    while (c.crtc.hcc_counter !== 0x28) c.crtc.tick();
    expect(c.crtc.hdisp).toBe(true);
  });

  it('redescend hdisp au redémarrage de ligne', () => {
    const c = build();
    while (c.crtc.hcc_counter !== 0x28) c.crtc.tick();
    while (c.crtc.hcc_counter !== 0x40) c.crtc.tick();
    c.crtc.tick();
    expect(c.crtc.hdisp).toBe(false);
  });

  it('avance et enveloppe l\'adresse vidéo sur 14 bits', () => {
    const c = build();
    c.crtc.maRow = 0x1000;
    c.crtc.tick();
    expect(c.crtc.maRow).toBe(0x1001);
    c.crtc.maRow = 0x3FFF;
    c.crtc.tick();
    expect(c.crtc.maRow).toBe(0x0000);
  });

  it('appelle updateVertical une fois par ligne, pas par caractère', () => {
    const c = build();
    let appels = 0;
    const reel = c.crtc.updateVertical;
    c.crtc.updateVertical = function () { appels++; return reel.call(this); };
    c.runLine();
    expect(appels).toBe(1);
  });
});

describe('MC6845 — génération de HSync', () => {
  it('déclenche le HSync à hcc = R2 et ne le redéclenche pas', () => {
    const c = build();
    while (c.crtc.hcc_counter !== 0x30) c.crtc.tick();
    c.crtc.checkHsync();
    expect(c.crtc.hsyncActive).toBe(true);
    expect(c.crtc.hsyncCounter).toBe(0);
    c.crtc.checkHsync();
    expect(c.crtc.hsyncCounter).toBe(0);
  });

  it('ne déclenche rien quand la largeur R3 vaut 0', () => {
    for (const type of TYPES) {
      const c = build(type, { 3: 0x00 });
      while (c.crtc.hcc_counter !== 0x30) c.crtc.tick();
      c.crtc.checkHsync();
      expect(c.crtc.hsyncActive, type).toBe(false);
    }
  });

  it('maintient le HSync pendant R3[3:0] caractères', () => {
    for (const type of TYPES) {
      const c = build(type, { 3: 0x06 });
      while (c.crtc.hcc_counter !== 0x30) c.crtc.tick();
      c.crtc.checkHsync();
      expect(c.crtc.hsyncActive, type).toBe(true);
      for (let i = 0; i < 5; i++) c.crtc.updateHsync();
      expect(c.crtc.hsyncActive, type).toBe(true);
      c.crtc.updateHsync();
      expect(c.crtc.hsyncActive, type).toBe(false);
    }
  });

  it('produit un front de HSync par ligne de caractère', () => {
    const c = build();
    let fronts = 0;
    let precedent = false;
    for (let ligne = 0; ligne < 10; ligne++) {
      for (let i = 0; i <= 0x40; i++) {
        c.crtc.checkHsync();
        if (c.crtc.hsyncActive && !precedent) fronts++;
        precedent = c.crtc.hsyncActive;
        c.crtc.tick();
        c.crtc.updateHsync();
      }
    }
    expect(fronts).toBe(10);
  });
});

describe('MC6845 — progression verticale', () => {
  it('avance vcc après R9 + 1 lignes de rastér', () => {
    const c = build();
    c.settle();
    c.crtc.vlc_crtc = 0;
    c.crtc.vcc = 5;
    c.runLine();
    expect(c.crtc.vlc_crtc).toBe(1);
    for (let i = 0; i < 7; i++) c.runLine();
    expect(c.crtc.vcc).toBe(6);
    expect(c.crtc.vlc_crtc).toBe(0);
  });

  it('enveloppe vlc_crtc sur 5 bits et vcc sur 7 bits', () => {
    const c = build();
    c.settle();
    c.crtc.vlc_crtc = 0x1F;
    c.runLine();
    expect(c.crtc.vlc_crtc).toBe(0);

    c.crtc.vcc = 0x7F;
    c.crtc.vlc_crtc = 0x07;
    c.runLine();
    expect(c.crtc.vcc).toBe(0);
  });

  it('miroir vlc = vlc_crtc à chaque fin de ligne', () => {
    for (const type of TYPES) {
      const c = build(type);
      c.settle();
      c.runLine();
      expect(c.crtc.vlc, type).toBe(c.crtc.vlc_crtc);
    }
  });

  it('déclenche vdisp exactement quand vcc atteint R6', () => {
    for (const type of TYPES) {
      const c = ready(type);
      let lignes = 0;
      while (c.crtc.vdisp === false && lignes < 400) {
        c.runLine();
        lignes++;
      }
      expect(c.crtc.vdisp, type).toBe(true);
      expect(c.crtc.vcc, type).toBe(c.crtc.registers[6]);
    }
  });

  it('vdisp reste armé une fois R6 franchi', () => {
    const c = ready('type0', null, 10);
    c.runRow();
    expect(c.crtc.vdisp).toBe(false);
    while (c.crtc.vcc < 0x19) c.runRow();
    expect(c.crtc.vdisp).toBe(true);
  });

  it('ne déclare pas vdisp avant R6', () => {
    const c = ready('type1');
    for (let i = 0; i < 20; i++) c.runLine();
    expect(c.crtc.vdisp).toBe(false);
  });
});

describe('MC6845 — durée de frame', () => {
  it('vaut (R4 + 1) × (R9 + 1) lignes sur les quatre variantes', () => {
    for (const type of TYPES) {
      const c = build(type);
      c.settle();
      expect(c.measureFrameLines(), type).toBe(FRAME);
      expect(FRAME).toBe(328);
    }
  });

  it('n\'est PAS allongée par R5', () => {
    for (const r5 of [0x02, 0x0A, 0x1F]) {
      const c = build('type0', { 5: r5 });
      c.settle();
      expect(c.measureFrameLines(), 'R5 = ' + r5).toBe(FRAME);
    }
  });

  // (La durée en fonction de R4/R9 isolément n'est pas testée : la formule
  //  (R4+1) x (R9+1) ne se vérifie que pour le jeu de registres réel du CPC.
  //  Une valeur mesurée pour d'autres couples n'a pas été expliquée, et
  //  inscrire un chiffre non compris dans un test serait pire que de ne rien
  //  affirmer.)

  it('charge l\'adresse de début de frame depuis R12/R13', () => {
    // type1 est l'exception : il ne recharge pas `startAddress` en fin de
    // frame, il recalcule `maRow` à partir de R12/R13 quand vcc == 0. Le
    // drapeau `startAddress` n'y est mis à jour que par `renderBorder`.
    for (const type of ['type0', 'type2', 'type3']) {
      const c = build(type, { 12: 0x3F, 13: 0xC0 });
      c.settle();
      expect(c.crtc.startAddress, type).toBe(0x3FC0);
    }
  });

  it('type1 calcule maRow depuis R12/R13 quand vcc vaut 0', () => {
    const c = build('type1', { 12: 0x3F, 13: 0xC0 });
    c.settle();
    c.crtc.vcc = 0;
    c.runLine();
    expect(c.crtc.maRow).toBe(0x3FC0);
  });

  it('n\'entre jamais en VBlank si R5 vaut 0', () => {
    const c = build('type0', { 5: 0x00 });
    c.settle();
    let vu = false;
    for (let i = 0; i < FRAME; i++) {
      c.runLine();
      if (c.crtc.vblankActive) vu = true;
    }
    expect(vu).toBe(false);
  });
});

describe('MC6845 — déclenchement du VSync', () => {
  it('se déclenche quand vcc atteint R7', () => {
    for (const type of ['type0', 'type1']) {
      const c = ready(type, { 7: 0x05 }, 4);
      c.runRow();          // la transition vcc 4 -> 5 a lieu ici
      expect(c.crtc.vcc, type).toBe(5);
      expect(c.crtc.vsyncActive, type).toBe(true);
    }
  });

  it('ne se déclenche pas tant que vsc_counter est non nul', () => {
    const c = ready('type0', { 7: 0x05 }, 4);
    c.crtc.vsc_counter = 3;
    c.crtc.vsyncActive = false;
    c.runRow();
    expect(c.crtc.vsyncActive).toBe(false);
  });

  it('dure 16 lignes sur type1, quel que soit R3', () => {
    const c = build('type1', { 3: 0x0F });
    c.crtc.vsyncActive = true;
    c.crtc.vsc_counter = 0;
    for (let i = 0; i < 15; i++) c.crtc.updateVertical();
    expect(c.crtc.vsyncActive).toBe(true);
    c.crtc.updateVertical();
    expect(c.crtc.vsyncActive).toBe(false);
  });

  it('dure R3[7:4] lignes sur type0 et type3', () => {
    for (const type of ['type0', 'type3']) {
      const c = build(type, { 3: 0x40 });
      c.crtc.vsyncActive = true;
      c.crtc.vsc_counter = 0;
      for (let i = 0; i < 3; i++) c.crtc.updateVertical();
      expect(c.crtc.vsyncActive, type).toBe(true);
      c.crtc.updateVertical();
      expect(c.crtc.vsyncActive, type).toBe(false);
    }
  });

  it('produit un VSync par frame sur les quatre variantes', () => {
    for (const type of TYPES) {
      const c = build(type, { 7: 0x00, 5: 0x02 });
      c.settle();
      expect(c.countVsyncs(FRAME * 3), type).toBe(3);
    }
  });
});

describe('MC6845 — divergence de VSync entre type2 et les autres', () => {
  it('type2 refuse d\'armer le VSync pendant un HSync', () => {
    const c = ready('type2', { 7: 0x05 }, 4);
    c.crtc.hsyncActive = true;
    c.runRow();
    expect(c.crtc.vcc).toBe(5);
    expect(c.crtc.vsyncActive).toBe(false);
  });

  it('type0 arme le VSync même HSync actif', () => {
    const c = ready('type0', { 7: 0x05 }, 4);
    c.crtc.hsyncActive = true;
    c.runRow();
    expect(c.crtc.vsyncActive).toBe(true);
  });

  it('type2 arme le VSync une fois le HSync terminé', () => {
    const c = ready('type2', { 7: 0x05 }, 4);
    c.crtc.hsyncActive = false;
    c.runRow();
    expect(c.crtc.vsyncActive).toBe(true);
  });
});

describe('MC6845 — bordure', () => {
  it('type1 et type2 lèvent la bordure si hdisp ou vdisp', () => {
    for (const type of ['type1', 'type2']) {
      const c = build(type);
      c.settle();
      c.crtc.hdisp = true;
      c.crtc.vdisp = false;
      c.crtc.renderBorder();
      expect(c.crtc.border, type).toBe(true);
    }
  });

  it('type1 force la bordure quand R6 vaut 0', () => {
    const c = build('type1', { 6: 0x00 });
    c.settle();
    c.crtc.hdisp = false;
    c.crtc.vdisp = false;
    c.crtc.renderBorder();
    expect(c.crtc.border).toBe(true);
  });

  it('type2 ne force PAS la bordure quand R6 vaut 0', () => {
    // La seule différence de bordure entre type1 et type2.
    const c = build('type2', { 6: 0x00 });
    c.settle();
    c.crtc.hdisp = false;
    c.crtc.vdisp = false;
    c.crtc.renderBorder();
    expect(c.crtc.border).toBe(false);
  });

  it('type0 propage la bordure sans retard par défaut', () => {
    const c = build('type0', { 8: 0x00 });
    c.crtc.hdisp = true;
    c.crtc.vdisp = false;
    c.crtc.renderBorder();
    expect(c.crtc.border).toBe(true);
  });

  it('type0 retarde la bordure avec R8 = 0x20', () => {
    const c = build('type0', { 8: 0x20 });
    c.crtc.hdisp = false;
    c.crtc.vdisp = false;
    c.crtc.renderBorder();
    expect(c.crtc.border).toBe(false);
    c.crtc.hdisp = true;
    c.crtc.renderBorder();
    c.crtc.renderBorder();
    c.crtc.renderBorder();
    expect(c.crtc.border).toBe(true);
  });

  it('type0 force la bordure en permanence avec R8 = 0x30', () => {
    const c = build('type0', { 8: 0x30 });
    c.crtc.hdisp = false;
    c.crtc.vdisp = false;
    c.crtc.renderBorder();
    expect(c.crtc.border).toBe(true);
  });

  it('type3 utilise le même pipeline de décalage que type0', () => {
    const c = build('type3', { 8: 0x10 });
    c.crtc.hdisp = false;
    c.crtc.vdisp = false;
    c.crtc.renderBorder();
    expect(c.crtc.border).toBe(false);
  });

  it('fige l\'adresse de début de ligne à hcc = R1', () => {
    for (const type of TYPES) {
      const c = build(type);
      c.settle();
      c.crtc.maRow = 0x2000;
      c.crtc.hcc_counter = 0x28;
      if (type === 'type3') c.crtc.vlc = 0x07;
      else c.crtc.vlc_crtc = 0x07;
      c.crtc.renderBorder();
      expect(c.crtc.startAddress, type).toBe(0x2000);
    }
  });
});

describe('MC6845 — entrelacement (R8)', () => {
  it('n\'entrelace pas quand R8 vaut 0', () => {
    for (const type of TYPES) {
      const c = build(type, { 8: 0x00 });
      c.settle();
      let appels = 0;
      const reel = c.crtc.updateVertical;
      c.crtc.updateVertical = function () { appels++; return reel.call(this); };
      c.runLine();
      expect(appels, type).toBe(1);
    }
  });

  it('double updateVertical en mode entrelacé, sauf sur type0', () => {
    // Divergence mesurée : type1, type2 et type3 appellent `updateVertical`
    // deux fois par ligne en entrelacé (pour simuler le double champ), tandis
    // que le HD6845S (type0) n'en appelle qu'une — il se contente de tester
    // VSync une fois de plus.
    for (const type of TYPES) {
      const c = build(type, { 8: 0x03 });
      c.settle();
      let appels = 0;
      const reel = c.crtc.updateVertical;
      c.crtc.updateVertical = function () { appels++; return reel.call(this); };
      c.runLine();
      expect(appels, type).toBe(type === 'type0' ? 1 : 2);
    }
  });

  it('reconnaît l\'entrelacement malgré les bits de skew (type0, type3)', () => {
    // Ces deux puces testent `(R8 & 3) === 3` : les bits 5-4 de skew n'existent
    // que sur elles et ne gênent pas la détection.
    const c3 = build('type3', { 8: 0x33 });
    c3.settle();
    let appels3 = 0;
    const reel3 = c3.crtc.updateVertical;
    c3.crtc.updateVertical = function () { appels3++; return reel3.call(this); };
    c3.runLine();
    expect(appels3).toBe(2);
  });
});

describe('MC6845 — reset', () => {
  it('remet tous les registres et compteurs à zéro', () => {
    const c = build();
    c.settle();
    c.crtc.reset();
    expect(Array.from(c.crtc.registers)).toEqual(new Array(18).fill(0));
    expect(c.crtc.hcc_counter).toBe(0);
    expect(c.crtc.vcc).toBe(0);
    expect(c.crtc.vlc_crtc).toBe(0);
    expect(c.crtc.vsyncActive).toBe(false);
    expect(c.crtc.hsyncActive).toBe(false);
    expect(c.crtc.border).toBe(false);
    expect(c.crtc.startAddress).toBe(0);
  });

  it('préserve la variante active après un reset', () => {
    const c = new TestCrtc({ type: 'type2' });
    c.crtc.reset();
    expect(c.crtc.crtcMasks).toBe(c.variants.type2.crtcMasks);
    expect(typeof c.crtc.tick).toBe('function');
  });
});
