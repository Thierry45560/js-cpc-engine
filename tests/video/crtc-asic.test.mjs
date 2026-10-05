/**
 * @file tests/video/crtc-asic.test.mjs
 * @description Extensions ASIC du CRTC type3 : HScroll, split-screen, SSCR.
 *
 * Le type3 est le seul CRTC à piloter l'ASIC du CPC+ : c'est lui qui
 * implémente le défilement logiciel, le split-screen et le signal de remise
 * à zéro du défilement. Aucune de ces trois fonctions n'est couverte ailleurs.
 *
 * Couvre :
 *  - le défilement horizontal : `vlc = (vlc_crtc + asicHScroll) & 31` ;
 *  - le split-screen : redirection de l'adresse vidéo à la ligne programmée ;
 *  - le registre de contrôle SSCR et le signal de remise à zéro ;
 *  - le compteur de rendu ASIC appelé à chaque front de rangée.
 */

import { describe, it, expect } from 'vitest';
import { TestCrtc } from '../helpers/crtc-harness.mjs';

/**
 * Programme le mode 40×25 puis active le ASIC.
 * @param {object} [asic] valeurs de la maquette ASIC
 * @returns {TestCrtc}
 */
function build(asic) {
  const c = new TestCrtc({ type: 'type3', machineType: 4 });
  c.setRegisters([
    0x40, 0x28, 0x30, 0x06,
    0x28, 0x02, 0x19, 0x00,
    0x00, 0x07,
  ]);
  const valeurs = asic || {};
  for (const cle of Object.keys(valeurs)) c.asic[cle] = valeurs[cle];
  return c;
}

describe('ASIC — défilement horizontal (HScroll)', () => {
  it('décale vlc de asicHScroll', () => {
    const c = build({ hScroll: 3 });
    c.settle();
    c.crtc.vlc_crtc = 0;
    c.crtc.tick();          // un seul tick : runLine() ferait avancer vlc_crtc
    expect(c.crtc.vlc).toBe(3);
  });

  it('additionne au vlc_crtc courant, pas à un compte séparé', () => {
    const c = build({ hScroll: 2 });
    c.settle();
    c.crtc.vlc_crtc = 5;
    c.crtc.tick();
    expect(c.crtc.vlc).toBe(7);
  });

  it('enveloppe le résultat sur 5 bits', () => {
    const c = build({ hScroll: 4 });
    c.settle();
    c.crtc.vlc_crtc = 0x1F;
    c.crtc.tick();
    expect(c.crtc.vlc).toBe(3);   // (0x1F + 4) & 31
  });

  it('ne bouge rien si asicHScroll vaut 0', () => {
    const c = build({ hScroll: 0 });
    c.settle();
    c.crtc.vlc_crtc = 6;
    c.crtc.tick();
    expect(c.crtc.vlc).toBe(c.crtc.vlc_crtc);
  });

  it('suit les variations de asicHScroll tick par tick', () => {
    const c = build({ hScroll: 0 });
    c.settle();
    const vus = [];
    for (let i = 0; i < 4; i++) {
      c.asic.hScroll = i;
      c.crtc.vlc_crtc = 1;
      c.crtc.tick();
      vus.push(c.crtc.vlc);
    }
    expect(vus).toEqual([1, 2, 3, 4]);
  });
});

describe('ASIC — split-screen', () => {
  /**
   * Prépare un test de split : stabilise, puis remet `startAddress` et
   * `maRow` à zéro.
   *
   * ⚠ Cette remise à zéro est indispensable : `settle()` parcourt deux
   * frames complètes, pendant lesquelles le couple (vcc = 1, vlc_crtc = 2)
   * est atteint *naturellement* — donc le split se produit déjà. Un test
   * négatif qui ne réinitialise pas `startAddress` vérifierait un état déjà
   * redirigé, et passerait à tort.
   *
   * @param {object} asic  valeurs ASIC
   * @param {number} vcc
   * @param {number} vlc
   * @returns {TestCrtc}
   */
  function splitReady(asic, vcc, vlc) {
    const c = build(asic);
    c.settle();
    c.crtc.startAddress = 0x0000;
    c.crtc.maRow = 0x0000;
    c.crtc.vcc = vcc;
    c.crtc.vlc_crtc = vlc;
    return c;
  }

  /**
   * Place le CRTC juste avant hcc = R1 puis fait un tick : la redirection est
   * testée *après* l'incrément de hcc, il faut donc partir de R1 - 1.
   */
  function tickAtDisplayStart(c) {
    c.crtc.hcc_counter = c.crtc.registers[1] - 1;
    c.crtc.tick();
  }

  it('ne redirige rien si asicSplitLine vaut 0', () => {
    const c = splitReady({ splitLine: 0, ssaHigh: 0x12, ssaLow: 0x34 }, 1, 2);
    tickAtDisplayStart(c);
    expect(c.crtc.startAddress).toBe(0x0000);
  });

  it('redirige l\'adresse à la ligne programmée', () => {
    const c = splitReady({ splitLine: 0x0A, ssaHigh: 0x12, ssaLow: 0x34 }, 1, 2);
    tickAtDisplayStart(c);        // (1 << 3) | 2 = 0x0A
    expect(c.crtc.startAddress).toBe(0x1234);
    expect(c.crtc.maRow).toBe(0x1234);
  });

  it('ne redirige pas sur les autres lignes', () => {
    const c = splitReady({ splitLine: 0x0A, ssaHigh: 0x12, ssaLow: 0x34 }, 1, 5);
    tickAtDisplayStart(c);        // (1 << 3) | 5 = 0x0D, pas 0x0A
    expect(c.crtc.startAddress).toBe(0x0000);
  });

  it('ne redirige qu\'au passage par hcc = R1', () => {
    const c = splitReady({ splitLine: 0x0A, ssaHigh: 0x12, ssaLow: 0x34 }, 1, 2);
    c.crtc.hcc_counter = 0x05;     // loin de R1
    c.crtc.tick();
    expect(c.crtc.startAddress).toBe(0x0000);
  });

  it('compose l\'adresse de split depuis les deux octets ASIC', () => {
    for (const [haut, bas, attendu] of [
      [0x00, 0x00, 0x0000], [0x3F, 0xC0, 0x3FC0], [0x20, 0x10, 0x2010],
    ]) {
      const c = splitReady({ splitLine: 0x0A, ssaHigh: haut, ssaLow: bas }, 1, 2);
      tickAtDisplayStart(c);
      expect(c.crtc.startAddress, 'SSA=' + haut + ':' + bas).toBe(attendu);
    }
  });
});

describe('ASIC — registre de contrôle SSCR', () => {
  it('signale la remise à zéro du défilement à hcc = 0', () => {
    const c = build({ sscr: 1 });
    c.settle();
    c.crtc.hcc_counter = 0;
    expect(c.crtc.renderBorder()).toBe(true);
  });

  it('ne signale rien si SSCR vaut autre chose que 1', () => {
    for (const valeur of [0, 2, 255]) {
      const c = build({ sscr: valeur });
      c.settle();
      c.crtc.hcc_counter = 0;
      expect(c.crtc.renderBorder(), 'SSCR = ' + valeur).toBeUndefined();
    }
  });

  it('ne signale rien ailleurs qu\'à hcc = 0', () => {
    const c = build({ sscr: 1 });
    c.settle();
    c.crtc.hcc_counter = 5;
    expect(c.crtc.renderBorder()).toBeUndefined();
  });

  it('renvoie `true` avant de calculer la bordure', () => {
    // Le retour précoce court-circuite le pipeline de décalage : à hcc = 0
    // avec SSCR armé, `border` n'est pas recalculé par cet appel.
    const c = build({ sscr: 1, hScroll: 0 });
    c.settle();
    c.crtc.border = false;
    c.crtc.hdisp = true;
    c.crtc.vdisp = true;
    c.crtc.hcc_counter = 0;
    c.crtc.renderBorder();
    expect(c.crtc.border).toBe(false);
  });
});

describe('ASIC — compteur de rendu split-screen', () => {
  it('appelle renderAsicSplit à chaque front de rangée', () => {
    const c = build();
    c.settle();
    const avant = c.asicSplitRenders;
    c.runRow();
    expect(c.asicSplitRenders).toBeGreaterThan(avant);
  });

  it('n\'est appelé par aucun autre type', () => {
    for (const type of ['type0', 'type1', 'type2']) {
      const c = new TestCrtc({ type });
      c.setRegisters([
        0x40, 0x28, 0x30, 0x06,
        0x28, 0x02, 0x19, 0x00,
        0x00, 0x07,
      ]);
      c.settle();
      expect(c.asicSplitRenders, type).toBe(0);
    }
  });
});

describe('ASIC — type3 utilise vlc (et non vlc_crtc) pour figer la ligne', () => {
  it('fige startAddress avec le vlc décalé', () => {
    // Type3 est la seule variante dont renderBorder compare `this.vlc` — donc
    // qui tient compte du défilement ASIC. Avec hScroll = 0, vlc == vlc_crtc.
    const c = build({ hScroll: 0 });
    c.settle();
    c.crtc.maRow = 0x2000;
    c.crtc.hcc_counter = c.crtc.registers[1];
    c.crtc.vlc = c.crtc.registers[9];
    c.crtc.renderBorder();
    expect(c.crtc.startAddress).toBe(0x2000);
  });

  it('ne fige pas la ligne si vlc décalé ne vaut pas R9', () => {
    const c = build({ hScroll: 0 });
    c.settle();
    c.crtc.maRow = 0x2000;
    c.crtc.hcc_counter = c.crtc.registers[1];
    c.crtc.vlc = 0x03;            // différent de R9 = 7
    c.crtc.renderBorder();
    expect(c.crtc.startAddress).not.toBe(0x2000);
  });
});
