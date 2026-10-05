/**
 * @file tests/audio/psg-generators.test.mjs
 * @description Tests des générateurs du PSG AY-3-8910 (`Clock_Cycle`).
 *
 * Un pas d'horloge avance, dans cet ordre : les trois diviseurs de tonalité,
 * le LFSR de bruit, la rampe d'enveloppe, puis le mixage. Les tests mesurent
 * les périodes réelles (compteur remis à 0 *après* incrément), la séquence du
 * LFSR 17 bits et les quatre formes d'enveloppe.
 */

import { describe, it, expect } from 'vitest';
import { TestPsg } from '../helpers/psg-harness.mjs';

/**
 * Calcule l'état suivant du LFSR tel que le fait le code.
 * @param {number} seed graine 17 bits
 * @returns {{seed:number, out:number}}
 */
function lfsr(seed) {
  const bit0 = seed & 1;
  const bit3 = (seed >>> 3) & 1;
  return { seed: (seed >>> 1) | ((bit0 ^ bit3) << 16), out: bit0 };
}

function voixA(a, { period = 1, volume = 15 } = {}) {
  a.setPeriod(0, period);
  a.setReg(7, 0x3E);          // tout actif sauf le ton A
  a.setReg(8, volume);
}

describe('PSG — diviseurs de tonalité', () => {
  it('bascule tous les p de coups pour une période p', () => {
    for (const p of [1, 2, 3, 5]) {
      const a = new TestPsg();
      a.setPeriod(0, p);
      expect(a.psg.chanPeriods[0], 'période ' + p).toBe(p);

      const trace = [];
      for (let i = 0; i < 2 * p + 1; i++) {
        a.clock();
        trace.push(a.psg.chanToggles[0]);
      }
      // Un front tous les p coups : au coup k le nombre de bascules vaut
      // k / p, et la sortie carrée vaut sa parité.
      for (let i = 0; i < 2 * p; i++) {
        expect(trace[i], 'p=' + p + ' coup ' + (i + 1))
          .toBe(Math.floor((i + 1) / p) % 2);
      }
    }
  });

  it('remet le compteur à zéro après le basculement', () => {
    const a = new TestPsg();
    a.setPeriod(0, 4);
    a.clock(4);
    expect(a.psg.chanCounters[0]).toBe(0);
    a.clock(2);
    expect(a.psg.chanCounters[0]).toBe(2);
  });

  it('fait tourner les trois canaux indépendamment', () => {
    const a = new TestPsg();
    a.setPeriod(0, 1).setPeriod(1, 2).setPeriod(2, 3);
    expect([...a.psg.chanPeriods]).toEqual([1, 2, 3]);

    a.clock(6);
    expect([...a.psg.chanCounters]).toEqual([0, 0, 0]);
    // 6 bascules sur A (impair -> 0), 3 sur B (impair -> 1), 2 sur C (pair -> 0).
    expect([...a.psg.chanToggles]).toEqual([0, 1, 0]);
  });

  it('une période nulle devient 1 et ne provoque jamais de division par zéro', () => {
    const a = new TestPsg();
    a.setPeriod(0, 0);
    a.clock(5);
    expect(a.psg.chanCounters[0]).toBe(0);
    expect(a.psg.chanToggles[0]).toBe(1);
  });
});

describe('PSG — générateur de bruit', () => {
  it('décale la graine tous les Period coups', () => {
    const a = new TestPsg();
    a.setReg(6, 0x01);           // période = 2
    expect(a.psg.Noise_Gen.Period).toBe(2);
    a.clock();
    expect(a.psg.Noise_Seed).toBe(0x1FFFF);
    a.clock();
    expect(a.psg.Noise_Seed).toBe(0x0FFFF);
  });

  it('suit le LFSR de Galois x^17 + x^14 + 1 sur 17 bits', () => {
    const a = new TestPsg();
    a.setReg(6, 0x00);           // période minimale : un décalage par coup
    let seed = 0x1FFFF;
    for (let i = 0; i < 20; i++) {
      const attendu = lfsr(seed);
      a.clock();
      expect(a.psg.Noise_Seed, 'pas ' + i).toBe(attendu.seed);
      expect(a.psg.Noise_Gen.Noise_Output_Bit, 'pas ' + i).toBe(attendu.out);
      seed = attendu.seed;
    }
  });

  it('ne déborde jamais sur 18 bits', () => {
    const a = new TestPsg();
    a.setReg(6, 0x00);
    for (let i = 0; i < 200; i++) {
      a.clock();
      expect(a.psg.Noise_Seed).toBeLessThan(0x20000);
      expect(a.psg.Noise_Seed).toBeGreaterThanOrEqual(0);
    }
  });

  it('produit une séquence qui change de valeur', () => {
    const a = new TestPsg();
    a.setReg(6, 0x00);
    const vus = new Set();
    for (let i = 0; i < 400; i++) {
      a.clock();
      vus.add(a.psg.Noise_Gen.Noise_Output_Bit);
    }
    expect(vus.size).toBe(2);
  });

  it('sort le bit 0 avant de décaler', () => {
    // Le bit exposé est celui qui sort de la graine, pas celui qui y entre.
    const a = new TestPsg();
    a.setReg(6, 0x00);
    a.psg.Noise_Seed = 0x10000;      // bit 0 à 0
    a.clock();
    expect(a.psg.Noise_Gen.Noise_Output_Bit).toBe(0);
    expect(a.psg.Noise_Seed).toBe(0x08000);
  });
});

describe('PSG — enveloppe : cadencement', () => {
  it('n\'avance la rampe qu\'un cran sur Envelope_Period coups', () => {
    const a = new TestPsg();
    a.setReg(11, 0x03).setReg(12, 0x00).setReg(13, 0x00);
    expect(a.psg.Envelope_Gen.Envelope_Period).toBe(3);
    const trace = [];
    for (let i = 0; i < 7; i++) {
      a.clock();
      trace.push(a.psg.Envelope_Gen.Counter_Val + '/' + a.psg.Envelope_Gen.Update_Cycles);
    }
    expect(trace).toEqual(['0/1', '0/2', '1/0', '1/1', '1/2', '2/0', '2/1']);
  });

  it('remonte le compteur de cycles à zéro au cran', () => {
    const a = new TestPsg();
    a.setReg(11, 0x02).setReg(12, 0x00);
    a.clock(6);
    expect(a.psg.Envelope_Gen.Counter_Val).toBe(3);
    expect(a.psg.Envelope_Gen.Update_Cycles).toBe(0);
  });
});

describe('PSG — enveloppe : formes', () => {
  /**
   * Relit les 20 premiers niveaux d'une forme.
   * @param {number} r13
   * @param {number} [n=20]
   * @returns {number[]}
   */
  function niveaux(r13, n = 20) {
    const a = new TestPsg();
    a.setReg(11, 0x01).setReg(12, 0x00).setReg(13, r13);
    const out = [];
    for (let i = 0; i < n; i++) {
      a.clock();
      out.push(a.psg.Envelope_Gen.Volume_Level);
    }
    return out;
  }

  it('décroissance continue (CONT=0) : se fige au silence', () => {
    expect(niveaux(0x00)).toEqual([
      14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it('croissance continue (CONT=0, ATT=1) : retombe au silence', () => {
    // Divergence notable : sans CONT, une enveloppe en attaque devrait rester
    // à 15 ; ici le passage du cran 16 force le volume à 0.
    const a = new TestPsg();
    a.setReg(11, 0x01).setReg(12, 0x00).setReg(13, 0x04);
    const trace = [];
    for (let i = 0; i < 20; i++) { a.clock(); trace.push(a.psg.Envelope_Gen.Volume_Level); }
    expect(trace).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 0, 0, 0, 0]);
  });

  it('CONT=1 sans HOLD : la décroissance redémarre au maximum', () => {
    // Divergence notable : au passage par 0, le niveau remonte d'un coup à 15,
    // ce qui produit une dents-de-scie et non une relance en montée.
    expect(niveaux(0x08)).toEqual([
      14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 15, 14, 13, 12, 11,
    ]);
  });

  it('CONT=1 + HOLD : le niveau est gelé', () => {
    const trace = niveaux(0x09, 22);
    expect(trace.slice(0, 16)).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0]);
    expect(trace.slice(16)).toEqual(new Array(6).fill(0));
    expect(niveaux(0x0D, 20)[19]).toBe(15);       // ATT=1 -> gelé au maximum
  });

  it('CONT=1 + ALT : alterne montée et descente', () => {
    const trace = niveaux(0x0A, 34);
    expect(trace.slice(0, 16)).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0]);
    expect(trace.slice(16, 32)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 15]);
    expect(trace[32]).toBe(14);
  });

  it('CONT=1 + ALT + HOLD : reste figé sur la valeur alternée', () => {
    // 0x0B = CONT + ALT + HOLD : au cran 16 le code fige le volume sur la
    // valeur donnée par ALT (ici 15) sans jamais rebasculer.
    const trace = niveaux(0x0B, 34);
    expect(trace.slice(0, 16)).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 15]);
    expect(trace.slice(16)).toEqual(new Array(18).fill(15));
  });

  it('CONT + ATT + HOLD : reste figé au maximum', () => {
    expect(niveaux(0x0D, 20).slice(16)).toEqual(new Array(4).fill(15));
  });
});

describe('PSG — mixage et sorties', () => {
  it('ne sort rien tant que le volume du canal est nul', () => {
    const a = new TestPsg();
    voixA(a, { volume: 0 });
    a.clock(8);
    expect(a.psg.Output_ChanA).toBe(0);
  });

  it('suit la table logarithmique quand la tonalité est active', () => {
    const a = new TestPsg();
    voixA(a, { volume: 15 });
    a.clock();
    expect(a.psg.Output_ChanA).toBe(1);      // ton actif, toggle à 1
    a.clock();
    expect(a.psg.Output_ChanA).toBe(0);      // toggle revenu à 0
  });

  it('suit la table logarithmique sur les trois canaux', () => {
    const a = new TestPsg();
    a.setReg(7, 0x3F);
    a.setReg(8, 0x03).setReg(9, 0x07).setReg(10, 0x0B);
    a.clock();
    expect(a.psg.Output_ChanA).toBe(a.psg.Volume_Log_Table[3]);
    expect(a.psg.Output_ChanB).toBe(a.psg.Volume_Log_Table[7]);
    expect(a.psg.Output_ChanC).toBe(a.psg.Volume_Log_Table[11]);
  });

  it('un ton coupé force le signal à 1', () => {
    const a = new TestPsg();
    a.setReg(7, 0x3F);            // tous les tons coupés
    a.setReg(8, 0x0F);
    a.clock(6);
    expect(a.psg.Output_ChanA).toBe(1);
  });

  it('un bruit coupé force le signal à 1', () => {
    const a = new TestPsg();
    a.setReg(7, 0x37);            // bits 3-5 = 1 -> bruits A et B coupés
    a.setReg(8, 0x0F);
    a.clock(2);
    expect(a.psg.Output_ChanA).toBe(1);
  });

  it('prend le volume de l\'enveloppe quand le bit 4 est armé', () => {
    const a = new TestPsg();
    a.setPeriod(0, 1);
    a.setReg(11, 0x01).setReg(12, 0x00).setReg(13, 0x00);
    a.setReg(7, 0x3E);
    a.setReg(8, 0x1F);            // bit 4 : piloté par l'enveloppe
    expect(a.psg.chanMixerEnable[0]).toBe(1);
    const T = a.psg.Volume_Log_Table;
    a.clock();
    expect(a.psg.Output_ChanA).toBe(T[14]);   // ton haut, rampe à 14
    a.clock();
    expect(a.psg.Output_ChanA).toBe(0);       // ton bas
    a.clock();
    expect(a.psg.Output_ChanA).toBe(T[12]);
  });

  it('ignore le volume fixe quand l\'enveloppe est armée', () => {
    const a = new TestPsg();
    a.setPeriod(0, 1);
    a.setReg(11, 0x01).setReg(13, 0x00);
    a.setReg(7, 0x3E);
    a.setReg(8, 0x1F);            // volume fixe demandé : 15
    a.clock(15);                  // l'enveloppe est descendue à 0
    expect(a.psg.Envelope_Gen.Volume_Level).toBe(0);
    a.clock();                   // ton haut, volume d'enveloppe nul
    expect(a.psg.Output_ChanA).toBe(0);
  });

  it('mélange les trois canaux séparément', () => {
    const a = new TestPsg();
    a.setReg(7, 0x3F);            // tout coupé
    a.setReg(8, 0x0F);
    a.setReg(9, 0x0A);
    a.setReg(10, 0x05);
    a.clock();
    expect(a.psg.Output_ChanA).toBe(1);
    expect(a.psg.Output_ChanB).toBe(a.psg.Volume_Log_Table[10]);
    expect(a.psg.Output_ChanC).toBe(a.psg.Volume_Log_Table[5]);
  });

  it('les trois sorties restent dans [0, 1]', () => {
    const a = new TestPsg();
    a.setReg(11, 0x01).setReg(13, 0x0E);
    a.setReg(7, 0x00);            // tons et bruits actifs
    for (let i = 0; i < 500; i++) {
      a.clock();
      for (const v of [a.psg.Output_ChanA, a.psg.Output_ChanB, a.psg.Output_ChanC]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('produit une vraie porteuse carrée sur le canal A', () => {
    const a = new TestPsg();
    a.setPeriod(0, 2);
    a.setReg(7, 0x3E);
    a.setReg(8, 0x0F);
    const trace = [];
    for (let i = 0; i < 8; i++) { a.clock(); trace.push(a.psg.Output_ChanA); }
    expect(trace).toEqual([0, 1, 1, 0, 0, 1, 1, 0]);
  });
});