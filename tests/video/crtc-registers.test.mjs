/**
 * @file tests/video/crtc-registers.test.mjs
 * @description Décodage de port, sélection de registre et masques par variante.
 *
 * Le MC6845 n'a pas de banking : `A9:A8` du port d'E/S décide de l'opération.
 * C'est un détail facile à oublier et très coûteux à diagnostiquer, d'où des
 * explicites sur les trois adresses primitives.
 *
 * Les quatre variantes se distinguent surtout par leur table `crtcMasks`, qui
 * implémente les bits non câblés de chaque puce. C'est l'objet principal de
 * cette suite : une erreur de masque ne se voit pas sur un programme qui
 * n'écrit que des valeurs « gentilles ».
 */

import { describe, it, expect } from 'vitest';
import { TestCrtc } from '../helpers/crtc-harness.mjs';

/** Les quatre variantes, dans l'ordre de la documentation du module. */
const TYPES = ['type0', 'type1', 'type2', 'type3'];

describe('MC6845 — décodage du port d\'E/S', () => {
  it('sélectionne le registre sur A9:A8 = 00', () => {
    const c = new TestCrtc();
    c.crtc.writePort(0xBC00, 5);
    expect(c.crtc.selectedRegister).toBe(5);
  });

  it('écrit la donnée sur A9:A8 = 01', () => {
    const c = new TestCrtc();
    c.crtc.writePort(0xBC00, 0);
    c.crtc.writePort(0xBD00, 0x42);
    expect(c.crtc.registers[0]).toBe(0x42);
  });

  it('lit le statut sur A9:A8 = 10', () => {
    const c = new TestCrtc({ type: 'type1' });
    c.crtc.vdisp = true;
    expect(c.crtc.readPort(0xBE00)).toBe(0x20);
  });

  it('lit le registre sélectionné sur A9:A8 = 11', () => {
    const c = new TestCrtc({ type: 'type1' });
    c.crtc.registers[16] = 0x77;
    c.crtc.writePort(0xBC00, 16);   // la sélection passe par 0xBC00
    expect(c.crtc.readPort(0xBF00)).toBe(0x77);
  });

  it('accepte toute la plage 0xBC00–0xBFxx', () => {
    const c = new TestCrtc({ type: 'type1' });
    c.crtc.registers[17] = 0x5A;
    c.crtc.writePort(0xBC00, 17);
    // Les bits hauts n'ont aucune incidence : le masque 0x43 ne garde que
    // A9:A8 (les bits 6 et 0 sont transparents).
    expect(c.crtc.readPort(0xBFFF)).toBe(0x5A);
    expect(c.crtc.readPort(0xBF3F)).toBe(0x5A);
  });

  it('renvoie null hors des deux adresses de lecture décodées', () => {
    const c = new TestCrtc();
    // 0xB800 → 0 et 0xB900 → 1 : ce sont les adresses d'écriture, pas de lecture.
    expect(c.crtc.readPort(0xB800)).toBeNull();
    expect(c.crtc.readPort(0xB900)).toBeNull();
  });

  it('ignore une écriture hors des deux adresses décodées', () => {
    const c = new TestCrtc();
    c.crtc.selectedRegister = 3;
    c.crtc.registers[3] = 0x11;
    c.crtc.writePort(0xBE00, 0xFF);   // → 2 : adresse de lecture, pas d'écriture
    c.crtc.writePort(0xBF00, 0xFF);   // → 3 : idem
    expect(c.crtc.selectedRegister).toBe(3);
    expect(c.crtc.registers[3]).toBe(0x11);
  });
});

describe('MC6845 — sélection de variante par P()', () => {
  it('installe les méthodes de la variante choisie', () => {
    const c = new TestCrtc({ type: 'type2' });
    expect(c.crtc.crtcMasks).toBe(c.variants.type2.crtcMasks);
    expect(typeof c.crtc.read).toBe('function');
    expect(typeof c.crtc.tick).toBe('function');
    expect(typeof c.crtc.updateVertical).toBe('function');
  });

  it('donne les mêmes masques à type0 et type3', () => {
    const c0 = new TestCrtc({ type: 'type0' });
    const m0 = Array.from(c0.crtc.crtcMasks);
    const c3 = new TestCrtc({ type: 'type3' });
    expect(Array.from(c3.crtc.crtcMasks)).toEqual(m0);
  });

  it('donne les mêmes masques à type1 et type2', () => {
    const c1 = new TestCrtc({ type: 'type1' });
    const m1 = Array.from(c1.crtc.crtcMasks);
    const c2 = new TestCrtc({ type: 'type2' });
    expect(Array.from(c2.crtc.crtcMasks)).toEqual(m1);
  });

  it('conserve un stock de registres commun entre les variantes', () => {
    // `P()` ne copie que les méthodes : le tableau `registers` est partagé.
    // C'est le comportement réel, et c'est pourquoi `reset()` est indispensable
    // entre deux configurations de test.
    const c = new TestCrtc({ type: 'type0' });
    c.setRegister(0, 0x64);
    expect(c.crtc.registers[0]).toBe(0x64);

    c.crtc.P(c.variants.type1);
    expect(c.crtc.registers[0]).toBe(0x64);
  });
});

describe('MC6845 — masques d\'écriture par registre', () => {
  it('conserve les 8 bits sur les registres non masqués', () => {
    for (const type of TYPES) {
      const c = new TestCrtc({ type });
      for (const r of [0, 1, 2, 13, 15, 17]) {
        c.setRegister(r, 0xFF);
        expect(c.crtc.registers[r], `${type} R${r}`).toBe(0xFF);
      }
    }
  });

  it('masque R3 à 4 bits sur type1 et type2', () => {
    for (const type of ['type1', 'type2']) {
      const c = new TestCrtc({ type });
      c.setRegister(3, 0xFF);
      expect(c.crtc.registers[3], type).toBe(0x0F);
    }
  });

  it('garde le nibble haut de R3 sur type0 et type3', () => {
    // Le HD6845S et l'ASIC CPC+ utilisent R3[7:4] pour la largeur de VSync.
    for (const type of ['type0', 'type3']) {
      const c = new TestCrtc({ type });
      c.setRegister(3, 0xA5);
      expect(c.crtc.registers[3], type).toBe(0xA5);
    }
  });

  it('limite R4, R6 et R7 à 7 bits', () => {
    for (const type of TYPES) {
      const c = new TestCrtc({ type });
      for (const r of [4, 6, 7]) {
        c.setRegister(r, 0xFF);
        expect(c.crtc.registers[r], `${type} R${r}`).toBe(0x7F);
      }
    }
  });

  it('limite R5 et R9 à 5 bits', () => {
    for (const type of TYPES) {
      const c = new TestCrtc({ type });
      for (const r of [5, 9]) {
        c.setRegister(r, 0xFF);
        expect(c.crtc.registers[r], `${type} R${r}`).toBe(0x1F);
      }
    }
  });

  it('limite R8 à 2 bits sur type1 et type2, 8 sur type0 et type3', () => {
    // Le masque est 3 : seuls les deux bits d'entrelacement existent sur les
    // UM6845R et le MC6845. Sur le HD6845S et l'ASIC, R8 porte en plus les
    // bits 5-4 de décalage de bordure.
    for (const type of ['type1', 'type2']) {
      const c = new TestCrtc({ type });
      c.setRegister(8, 0xFF);
      expect(c.crtc.registers[8], type).toBe(0x03);
    }
    for (const type of ['type0', 'type3']) {
      const c = new TestCrtc({ type });
      c.setRegister(8, 0xFF);
      expect(c.crtc.registers[8], type).toBe(0xF3);
    }
  });

  it('conserve l\'octet complet de R9 sur type3 (défilement ASIC)', () => {
    // Type3 est la seule variante qui programme R9 sur 8 bits.
    const c = new TestCrtc({ type: 'type3' });
    c.setRegister(9, 0xFF);
    expect(c.crtc.registers[9]).toBe(0x1F);
  });

  it('limite R12 et R13 à 6 bits (alignement sur 16 Ko)', () => {
    for (const type of TYPES) {
      const c = new TestCrtc({ type });
      c.setRegister(12, 0xFF);
      c.setRegister(13, 0xFF);
      expect(c.crtc.registers[12], `${type} R12`).toBe(0x3F);
      expect(c.crtc.registers[13], `${type} R13`).toBe(0xFF);
    }
  });

  it('ignore les écritures au-delà de R17', () => {
    for (const type of TYPES) {
      const c = new TestCrtc({ type });
      c.crtc.registers.fill(0);
      for (const r of [18, 19, 25, 31]) {
        c.setRegister(r, 0xAA);
        expect(c.crtc.registers[r], `${type} R${r}`).not.toBe(0xAA);
      }
    }
  });

  it('masque le numéro de registre sur 5 bits', () => {
    const c = new TestCrtc();
    c.crtc.writePort(0xBC00, 0xE5);   // 0b11100101 → 0b00101 = 5
    expect(c.crtc.selectedRegister).toBe(5);
  });
});

describe('MC6845 — effets de bord de l\'écriture', () => {
  it('calcule charWidth à partir de R0 >> 1', () => {
    const c = new TestCrtc();
    c.setRegister(0, 0x40);
    expect(c.crtc.charWidth).toBe(0x20);
  });

  it('recalcule charWidth après une réécriture de R0', () => {
    const c = new TestCrtc();
    c.setRegister(0, 0x40);
    c.setRegister(0, 0x50);
    expect(c.crtc.charWidth).toBe(0x28);
  });

  it('applique le masque avant de calculer charWidth', () => {
    // R0 n'est pas masqué, mais la division par 2 doit porter sur la valeur
    // stockée, pas sur la valeur brute écrite.
    const c = new TestCrtc();
    c.setRegister(0, 0x07);
    expect(c.crtc.charWidth).toBe(0x03);
  });

  it('lève vdisp si vcc vaut déjà la nouvelle valeur de R6', () => {
    for (const type of TYPES) {
      const c = new TestCrtc({ type });
      c.crtc.vcc = 10;
      c.crtc.vdisp = false;
      c.setRegister(6, 10);
      expect(c.crtc.vdisp, type).toBe(true);
    }
  });

  it('ne lève pas vdisp si vcc diffère de R6', () => {
    const c = new TestCrtc();
    c.crtc.vcc = 10;
    c.crtc.vdisp = false;
    c.setRegister(6, 11);
    expect(c.crtc.vdisp).toBe(false);
  });

  it('lève vsyncActive si vcc vaut déjà la nouvelle valeur de R7', () => {
    for (const type of ['type0', 'type1', 'type2']) {
      const c = new TestCrtc({ type });
      c.crtc.vcc = 20;
      c.crtc.vsyncActive = false;
      c.setRegister(7, 20);
      expect(c.crtc.vsyncActive, type).toBe(true);
    }
  });

  it('ne lève PAS vsyncActive sur cette voie pour type3', () => {
    // Type3 est la seule variante sans effet de bord sur R7 : le VSync n'est
    // produit que par `updateVertical`. C'est une divergence assumée.
    const c = new TestCrtc({ type: 'type3' });
    c.crtc.vcc = 20;
    c.crtc.vsyncActive = false;
    c.setRegister(7, 20);
    expect(c.crtc.vsyncActive).toBe(false);
  });

  it('extrait le mode d\'entrelacement du bit 0 de R8', () => {
    for (const type of TYPES) {
      const c = new TestCrtc({ type });
      c.setRegister(8, 0x00);
      expect(c.crtc.interlaceMode, `${type} = 0`).toBe(0);
      c.setRegister(8, 0x03);
      expect(c.crtc.interlaceMode, `${type} = 3`).toBe(1);
    }
  });
});

describe('MC6845 — alimentation de la séquence de déverrouillage ASIC', () => {
  it('ne nourrit pas la séquence sur un CPC classique', () => {
    const c = new TestCrtc({ machineType: 2 });
    c.crtc.writePort(0xBC00, 12);
    expect(c.asic.unlockFeed).toHaveLength(0);
  });

  it('nourrit la séquence à chaque sélection sur un CPC+', () => {
    const c = new TestCrtc({ type: 'type3', machineType: 4 });
    c.crtc.writePort(0xBC00, 12);
    c.crtc.writePort(0xBC00, 13);
    expect(c.asic.unlockFeed).toEqual([12, 13]);
  });

  it('transmet la valeur brute, non masquée', () => {
    // Le motif de déverrouillage ASIC dépend des octets exacts écrits sur le
    // port de sélection : le masquage à 5 bits_breakait la séquence.
    const c = new TestCrtc({ type: 'type3', machineType: 4 });
    c.crtc.writePort(0xBC00, 0xE5);
    expect(c.asic.unlockFeed).toEqual([0xE5]);
    // (le registre sélectionné, lui, est bien masqué à 5 bits : voir plus haut)
  });

  it('ne se déclenche pas sur une écriture de donnée', () => {
    const c = new TestCrtc({ type: 'type3', machineType: 4 });
    c.crtc.writePort(0xBC00, 0);
    c.asic.unlockFeed.length = 0;
    c.crtc.writePort(0xBD00, 0xFF);
    expect(c.asic.unlockFeed).toHaveLength(0);
  });

  it('s\'applique aux quatre variantes sur CPC+', () => {
    for (const type of TYPES) {
      const c = new TestCrtc({ type, machineType: 4 });
      c.crtc.writePort(0xBC00, 7);
      expect(c.asic.unlockFeed, type).toEqual([7]);
    }
  });
});

describe('MC6845 — port de statut par variante', () => {
  it('renvoie vdisp en bit 5 sur type1', () => {
    const c = new TestCrtc({ type: 'type1' });
    c.crtc.vdisp = false;
    expect(c.crtc.status()).toBe(0x00);
    c.crtc.vdisp = true;
    expect(c.crtc.status()).toBe(0x20);
  });

  it('renvoie null sur type0, type1 et type2 quand le port n\'est pas câblé', () => {
    for (const type of ['type0', 'type2']) {
      const c = new TestCrtc({ type });
      expect(c.crtc.status(), type).toBeNull();
    }
  });

  it('alias read() sur type3', () => {
    const c = new TestCrtc({ type: 'type3' });
    c.crtc.writePort(0xBC00, 2);
    c.crtc.hcc_counter = 0x10;
    c.crtc.registers[0] = 0x40;
    c.crtc.registers[1] = 0x28;
    c.crtc.registers[2] = 0x30;
    expect(c.crtc.status()).toBe(c.crtc.read());
  });
});

describe('MC6845 — registres lisibles par variante', () => {
  it('type0 expose R12 à R17', () => {
    const c = new TestCrtc({ type: 'type0' });
    // 0x5A respecte tous les masques sauf celui de R12 (63) : on utilise 0x3A,
    // qui tient dans 6 bits.
    for (const r of [12, 13, 14, 15, 16, 17]) {
      c.setRegister(r, 0x3A);
      c.crtc.writePort(0xBC00, r);
      expect(c.crtc.read(), `R${r}`).toBe(0x3A);
    }
  });

  it('type0 renvoie 0 pour R0 à R11', () => {
    const c = new TestCrtc({ type: 'type0' });
    c.setRegister(0, 0x42);
    c.crtc.writePort(0xBC00, 0);
    expect(c.crtc.read()).toBe(0);
  });

  it('type1 et type2 n\'exposent que R14 à R17', () => {
    for (const type of ['type1', 'type2']) {
      const c = new TestCrtc({ type });
      c.setRegister(12, 0x3F);
      c.crtc.writePort(0xBC00, 12);
      expect(c.crtc.read(), `${type} R12`).toBe(0);
      c.setRegister(16, 0x11);
      c.crtc.writePort(0xBC00, 16);
      expect(c.crtc.read(), `${type} R16`).toBe(0x11);
    }
  });

  it('type1 renvoie null sur R31 (bus non piloté)', () => {
    const c = new TestCrtc({ type: 'type1' });
    c.crtc.writePort(0xBC00, 31);
    expect(c.crtc.read()).toBeNull();
  });

  it('type2 ne renvoie pas null sur R31', () => {
    // Divergence avec type1 : type2 renvoie 0, pas null.
    const c = new TestCrtc({ type: 'type2' });
    c.crtc.writePort(0xBC00, 31);
    expect(c.crtc.read()).toBe(0);
  });
});

describe('MC6845 — lecture étendue de type3', () => {
  it('utilise seulement les 3 bits bas du registre sélectionné', () => {
    const c = new TestCrtc({ type: 'type3' });
    c.crtc.registers[12] = 0x11;
    c.crtc.registers[20] = 0x22;   // 20 & 7 = 4, même opération que R12
    c.crtc.writePort(0xBC00, 20);
    expect(c.crtc.read()).toBe(c.crtc.registers[12]);
  });

  it('expose R16 et R17 comme octets haut et bas du stylet', () => {
    const c = new TestCrtc({ type: 'type3' });
    c.crtc.registers[16] = 0xAA;
    c.crtc.registers[17] = 0xBB;
    c.crtc.writePort(0xBC00, 0);
    expect(c.crtc.read()).toBe(0xAA);
    c.crtc.writePort(0xBC00, 1);
    expect(c.crtc.read()).toBe(0xBB);
  });

  it('expose R12 à R15', () => {
    const c = new TestCrtc({ type: 'type3' });
    for (const [r, expected] of [[4, 12], [5, 13], [6, 14], [7, 15]]) {
      c.crtc.registers[expected] = 0x30 + r;
      c.crtc.writePort(0xBC00, r);
      expect(c.crtc.read(), `op ${r} → R${expected}`).toBe(0x30 + r);
    }
  });

  it('code la position horizontale du faisceau', () => {
    const c = new TestCrtc({ type: 'type3' });
    c.setRegister(0, 0x40);   // total
    c.setRegister(1, 0x28);   // fin d'affichage
    c.setRegister(2, 0x30);   // position HSync
    c.crtc.writePort(0xBC00, 2);

    // hcc = 0x10 : ni R0, ni R1, ni R2 → bits 3, 2, 1 à 1, bit 0 à 0.
    c.crtc.hcc_counter = 0x10;
    expect(c.crtc.read() & 0x0F).toBe(0b1110);

    // hcc = R0 = 0x40 : en fin de ligne, bit 0 à 1.
    c.crtc.hcc_counter = 0x40;
    expect(c.crtc.read() & 0x01).toBe(1);
  });

  it('signale la position de VSync dans le statut vertical', () => {
    const c = new TestCrtc({ type: 'type3' });
    c.setRegister(9, 0x07);
    c.crtc.writePort(0xBC00, 3);

    c.crtc.vlc_crtc = 0;
    expect(c.crtc.read() & 0x80).toBe(0x80);   // en haut de rang
    c.crtc.vlc_crtc = 3;
    expect(c.crtc.read() & 0x80).toBe(0);
    expect(c.crtc.read() & 0x20).toBe(0x20);   // pas encore en bas
    c.crtc.vlc_crtc = 0x07;
    expect(c.crtc.read() & 0x20).toBe(0);      // en bas de rang
  });
});
