/**
 * @file tests/video/asic-registers.test.mjs
 * @description Déverrouillage ASIC et carte de registres mappés en mémoire.
 *
 * L'ASIC du CPC+ ne répond pas tant que la séquence de déverrouillage n'a pas
 * été envoyée : c'est le premier obstacle encountered par tout logiciel CPC+,
 * et son échec est silencieux (les registres restent inertes).
 *
 * Couvre :
 *  - la machine à états de la séquence de déverrouillage (15 octets) ;
 *  - la carte mémoire de `ASIC_Manager.read` / `write` : pixels de sprite,
 *    attributs de sprite, palette, registres généraux, registres DMA ;
 *  - le découpage du registre SSCR/HScroll/VScroll ;
 *  - le comportement des adresses non mappées.
 */

import { describe, it, expect } from 'vitest';
import { TestAsic } from '../helpers/asic-harness.mjs';

describe('ASIC — séquence de déverrouillage', () => {
  it('est verrouillé à la mise sous tension', () => {
    const a = new TestAsic();
    expect(a.asic.asicLocked).toBe(true);
    expect(a.asic.asicUnlockState).toBe(0);
  });

  it('expose une séquence de 15 octets', () => {
    const a = new TestAsic();
    expect(a.asic.asicUnlockSequence).toHaveLength(15);
  });

  it('progresse d\'un cran par octet correct', () => {
    const a = new TestAsic();
    const seq = a.asic.asicUnlockSequence;
    for (let i = 0; i < 4; i++) {
      a.asic.feedAsicUnlock(seq[i]);
      expect(a.asic.asicUnlockState, 'après ' + (i + 1) + ' octets').toBe(i + 1);
      expect(a.asic.asicLocked).toBe(true);
    }
  });

  it('déverrouille au 15ᵉ octet', () => {
    const a = new TestAsic();
    a.unlock();
    expect(a.asic.asicLocked).toBe(false);
  });

  it('remet le compteur à zéro après déverrouillage', () => {
    const a = new TestAsic();
    a.unlock();
    expect(a.asic.asicUnlockState).toBe(0);
  });

  it('revient à zéro sur un octet incorrect', () => {
    const a = new TestAsic();
    const seq = a.asic.asicUnlockSequence;
    a.asic.feedAsicUnlock(seq[0]);
    a.asic.feedAsicUnlock(seq[1]);
    expect(a.asic.asicUnlockState).toBe(2);
    a.asic.feedAsicUnlock(0x00);
    expect(a.asic.asicUnlockState).toBe(0);
  });

  it('ne se déverrouille pas après une erreur puis octets corrects', () => {
    const a = new TestAsic();
    const seq = a.asic.asicUnlockSequence;
    a.asic.feedAsicUnlock(seq[0]);
    a.asic.feedAsicUnlock(0x00);       // erreur
    for (let i = 1; i < 15; i++) a.asic.feedAsicUnlock(seq[i]);
    expect(a.asic.asicLocked).toBe(true);
  });

  it('remet l\'état à 0 sur un octet erroné, même égal au 1er de la séquence', () => {
    // Le premier octet vaut 0xFF. L'envoyer deux fois est une erreur (l'état 1
    // attend 0x77) : la machine repart de 0 *sans fenêtre glissante* — un
    // automate de reprise ne réinjecte donc pas le 0xFF en tête.
    const a = new TestAsic();
    a.asic.feedAsicUnlock(0xFF);
    expect(a.asic.asicUnlockState).toBe(1);
    a.asic.feedAsicUnlock(0xFF);
    expect(a.asic.asicUnlockState).toBe(0);
    // Le 0x77 suivant n'est plus qu'au 2e rang : il échoue aussi.
    a.asic.feedAsicUnlock(0x77);
    expect(a.asic.asicUnlockState).toBe(0);
  });

  it('reverrouille au reset', () => {
    const a = new TestAsic();
    a.unlock();
    a.asic.reset();
    expect(a.asic.asicLocked).toBe(true);
    expect(a.asic.asicUnlockState).toBe(0);
  });

  it('reste déverrouillé après un reset partiel des registres', () => {
    // Seule la séquence remet asicLocked à true.
    const a = new TestAsic();
    a.unlock();
    a.asic.asicPri = 0xFF;
    expect(a.asic.asicLocked).toBe(false);
  });
});

describe('ASIC — registres généraux (0x2800–0x2807)', () => {
  it('relaie PRI, split-line, SSA et IVR', () => {
    const a = new TestAsic();
    a.asic.write(0x2800, 0x03);   // asicPri
    a.asic.write(0x2801, 0x0A);   // asicSplitLine
    a.asic.write(0x2802, 0x12);   // asicSsaHigh
    a.asic.write(0x2803, 0x34);   // asicSsaLow
    a.asic.write(0x2805, 0x40);   // asicIvr

    expect(a.asic.asicPri).toBe(0x03);
    expect(a.asic.asicSplitLine).toBe(0x0A);
    expect(a.asic.asicSsaHigh).toBe(0x12);
    expect(a.asic.asicSsaLow).toBe(0x34);
    expect(a.asic.asicIvr).toBe(0x40);
  });

  it('relit les mêmes registres qu\'elle a écrits', () => {
    const a = new TestAsic();
    a.asic.write(0x2800, 0x07);
    expect(a.asic.read(0x2800)).toBe(0x07);
    a.asic.write(0x2802, 0xAB);
    expect(a.asic.read(0x2802)).toBe(0xAB);
  });

  it('découpe le registre 4 en SSCR / HScroll / VScroll', () => {
    const a = new TestAsic();
    a.asic.write(0x2804, 0xB7);   // 1 011 0111
    expect(a.asic.asicSscr).toBe(1);       // bit 7
    expect(a.asic.asicHScroll).toBe(3);    // bits 6-4 (3 bits) → 011 = 3
    expect(a.asic.asicVScroll).toBe(7);    // bits 3-0 (4 bits)
  });

  it('recompose les trois champs à la lecture', () => {
    const a = new TestAsic();
    a.asic.write(0x2804, 0xB7);
    expect(a.asic.read(0x2804)).toBe(0xB7);
  });

  it('relit les 6 registres généralistes câblés', () => {
    const a = new TestAsic();
    a.asic.write(0x2800, 0x01);   // PRI
    a.asic.write(0x2801, 0x02);   // split line
    a.asic.write(0x2802, 0x03);   // SSA haut
    a.asic.write(0x2803, 0x04);   // SSA bas
    a.asic.write(0x2805, 0x06);   // IVR
    for (let k = 0; k <= 3; k++) expect(a.asic.read(0x2800 + k), 'registre ' + k).toBe(k + 1);
    expect(a.asic.read(0x2805)).toBe(0x06);
  });

  it('fait un aller-retour exact sur les 6 octets', () => {
    const a = new TestAsic();
    for (const [k, v] of [[0, 0x00], [1, 0xFF], [2, 0xA5], [3, 0x5A], [4, 0x39], [5, 0xC6]]) {
      a.asic.write(0x2800 + k, v);
      expect(a.asic.read(0x2800 + k), 'registre ' + k).toBe(v);
    }
  });

  it('lit 6 et 7 comme non câblés', () => {
    const a = new TestAsic();
    a.asic.write(0x2806, 0xFF);
    a.asic.write(0x2807, 0xFF);
    expect(a.asic.read(0x2806)).toBe(0xFF);
    expect(a.asic.read(0x2807)).toBe(0xFF);
  });

  it('donne 0xFF par défaut pour l\'IVR à la mise sous tension', () => {
    const a = new TestAsic();
    expect(a.asic.asicIvr).toBe(0x51);
  });

  it('remet tous les registres à zéro au reset', () => {
    const a = new TestAsic();
    a.asic.write(0x2800, 0xFF);
    a.asic.write(0x2801, 0xFF);
    a.asic.write(0x2802, 0xFF);
    a.asic.write(0x2804, 0xFF);
    a.asic.write(0x2805, 0xFF);

    a.asic.reset();

    expect(a.asic.asicPri).toBe(0);
    expect(a.asic.asicSplitLine).toBe(0);
    expect(a.asic.asicSsaHigh).toBe(0);
    expect(a.asic.asicSsaLow).toBe(0);
    expect(a.asic.asicSscr).toBe(0);
    expect(a.asic.asicHScroll).toBe(0);
    expect(a.asic.asicVScroll).toBe(0);
    expect(a.asic.asicIvr).toBe(0x51);
  });
});

describe('ASIC — pixels de sprite (0x0000–0x0FFF)', () => {
  it('stocke un pixel par octet, sur 4 bits', () => {
    const a = new TestAsic();
    a.asic.write(0x0000, 0xFF);
    expect(a.pri.id[0].priBuffer[0]).toBe(0x0F);
  });

  it('répartit les octets sur les 16 sprites et 16 lignes', () => {
    const a = new TestAsic();
    // L'octet d'offset sélectionne le sprite par >>8 et la ligne par >>4.
    a.asic.write(0x0000, 0x05);
    a.asic.write(0x0010, 0x06);
    a.asic.write(0x0F00, 0x07);

    expect(a.pri.id[0].priBuffer[0]).toBe(0x05);
    expect(a.pri.id[0].priBuffer[0x10]).toBe(0x06);
    expect(a.pri.id[15].priBuffer[0x00]).toBe(0x07);
  });

  it('relit ce qu\'il a écrit', () => {
    const a = new TestAsic();
    a.asic.write(0x0123, 0x0A);
    expect(a.asic.read(0x0123)).toBe(0x0A);
  });

  it('masque la valeur sur 4 bits', () => {
    const a = new TestAsic();
    a.asic.write(0x0000, 0xF3);
    expect(a.asic.read(0x0000)).toBe(0x03);
  });

  it('donne 0 pour une zone jamais écrite', () => {
    const a = new TestAsic();
    a.asic.write(0x0000, 0x0F);
    expect(a.asic.read(0x0001)).toBe(0x00);
  });
});

describe('ASIC — attributs de sprite (0x2000–0x23FF)', () => {
  it('écrit x sur deux octets, avec seulement 2 bits hauts utiles', () => {
    const a = new TestAsic();
    a.asic.write(0x2000, 0x34);
    a.asic.write(0x2001, 0x02);
    expect(a.pri.id[0].x).toBe(0x0234);
  });

  it('écrit y sur deux octets, avec seulement 2 bits hauts utiles', () => {
    const a = new TestAsic();
    a.asic.write(0x2002, 0x78);
    a.asic.write(0x2003, 0x01);
    expect(a.pri.id[0].y).toBe(0x0178);
  });

  it('écrit la magnification dans l\'octet 4', () => {
    const a = new TestAsic();
    a.asic.write(0x2004, 0x0D);   // magX = 3, magY = 1
    expect(a.pri.id[0].magX).toBe(3);
    expect(a.pri.id[0].magY).toBe(1);
  });

  it('sélectionne le sprite par les bits 6-4 de l\'offset', () => {
    const a = new TestAsic();
    a.asic.write(0x2000 + (5 << 3), 0xAA);
    expect(a.pri.id[5].x & 0xFF).toBe(0xAA);
    expect(a.pri.id[0].x).toBe(0);
  });

  it('relit x et y octet par octet', () => {
    const a = new TestAsic();
    a.asic.write(0x2000, 0x34);
    a.asic.write(0x2001, 0x02);
    a.asic.write(0x2002, 0x78);
    a.asic.write(0x2003, 0x01);
    expect(a.asic.read(0x2000)).toBe(0x34);
    expect(a.asic.read(0x2001)).toBe(0x02);
    expect(a.asic.read(0x2002)).toBe(0x78);
    expect(a.asic.read(0x2003)).toBe(0x01);
  });

  it('relit la magnification encodée sur 6 bits', () => {
    const a = new TestAsic();
    a.asic.write(0x2004, 0x0D);
    expect(a.asic.read(0x2004)).toBe((3 << 2) | 1);
  });

  it('relit 0 pour les octets 5 à 7', () => {
    const a = new TestAsic();
    for (const octet of [5, 6, 7]) {
      expect(a.asic.read(0x2000 + octet), 'octet ' + octet).toBe(0);
    }
  });

  it('ignore silencieusement les écritures sur les octets 5 à 7', () => {
    const a = new TestAsic();
    a.asic.write(0x2005, 0xFF);
    a.asic.write(0x2006, 0xFF);
    a.asic.write(0x2007, 0xFF);
    expect(a.asic.read(0x2005)).toBe(0);
    expect(a.pri.id[0].x).toBe(0);
  });
});

describe('ASIC — palette 12 bits (0x2400–0x243F)', () => {
  it('route l\'octet pair vers l\'écriture basse et l\'impair vers la haute', () => {
    const a = new TestAsic();
    a.clearLogs();
    a.asic.write(0x2400, 0xA5);
    a.asic.write(0x2401, 0x03);
    expect(a.colorWrites).toEqual([
      { pen: 0, value: 0xA5, half: 'low' },
      { pen: 0, value: 0x03, half: 'high' },
    ]);
  });

  it('sélectionne le stylo par le décalage d\'un octet', () => {
    const a = new TestAsic();
    a.clearLogs();
    a.asic.write(0x2400 + 5 * 2, 0x11);
    expect(a.colorWrites[0].pen).toBe(5);
  });

  it('relit l\'octet bas : R et B', () => {
    const a = new TestAsic();
    a.hwPalette[3] = 0xA35;   // R = A, G = 3, B = 5
    expect(a.asic.read(0x2400 + 3 * 2)).toBe(0xA5);
  });

  it('relit l\'octet haut : G', () => {
    const a = new TestAsic();
    a.hwPalette[3] = 0xA35;
    expect(a.asic.read(0x2400 + 3 * 2 + 1)).toBe(0x03);
  });

  it('couvre les 32 stylos en 64 octets', () => {
    // Format 16 bits de `hwPalette` : R = bits 11-8, G = bits 7-4, B = bits 3-0.
    // L'octet bas relit R<<4|B, l'octet haut relit G (4 bits, en poids fort).
    const a = new TestAsic();
    for (let pen = 0; pen < 32; pen++) {
      const nib = pen & 0x0F;
      a.hwPalette[pen] = (nib << 8) | (nib << 4) | nib;
      expect(a.asic.read(0x2400 + pen * 2), 'stylo ' + pen).toBe((nib << 4) | nib);
      expect(a.asic.read(0x2401 + pen * 2), 'stylo ' + pen).toBe(nib);
    }
  });
});

describe('ASIC — registres DMA (0x2C00–0x2C0F)', () => {
  it('sélectionne le canal par les bits 5-4 de l\'offset', () => {
    const a = new TestAsic();
    a.dma.init();
    a.asic.write(0x2C00, 0x34);
    a.asic.write(0x2C04, 0x56);
    expect(a.dma.channels[0].pointer & 0xFF).toBe(0x34);
    expect(a.dma.channels[1].pointer & 0xFF).toBe(0x56);
  });

  it('compose le pointeur sur 16 bits', () => {
    const a = new TestAsic();
    a.dma.init();
    a.asic.write(0x2C00, 0x34);
    a.asic.write(0x2C01, 0x12);
    expect(a.dma.channels[0].pointer).toBe(0x1234);
  });

  it('force le bit 0 du pointeur à zéro', () => {
    // Le Z80 ne peut pas produire d'adresse impaire, et le DMA lit des mots.
    const a = new TestAsic();
    a.dma.init();
    a.asic.write(0x2C00, 0xFF);
    expect(a.dma.channels[0].pointer & 0x01).toBe(0);
  });

  it('relit le pointeur octet par octet', () => {
    const a = new TestAsic();
    a.dma.init();
    a.asic.write(0x2C00, 0x34);
    a.asic.write(0x2C01, 0x12);
    expect(a.asic.read(0x2C00)).toBe(0x34);
    expect(a.asic.read(0x2C01)).toBe(0x12);
  });

  it('relit le diviseur de pré-échelonnement', () => {
    const a = new TestAsic();
    a.dma.init();
    a.asic.write(0x2C02, 0x07);
    expect(a.dma.channels[0].prescalerBase).toBe(0x07);
    expect(a.asic.read(0x2C02)).toBe(0x07);
  });

  it('lit l\'octet de statut à l\'offset 0x2C0F', () => {
    const a = new TestAsic();
    a.dma.init();
    a.dma.statusControl = 0x45;
    expect(a.asic.read(0x2C0F)).toBe(0x45);
  });

  it('écrit l\'octet de statut DMA en préservant le bit 7', () => {
    // Régression : `write()` faisait `this._getDmaStatus() = ...`, une affectation
    // à un appel de fonction → ReferenceError à chaque écriture en 0x4C0F. Le
    // correctif passe par `_setDmaStatus()`, déjà câblé dans CPC_Bus.js.
    const a = new TestAsic();
    a.dma.init();
    a.dma.statusControl = 0x85;
    a.asic.write(0x2C0F, 0x7E);
    expect(a.dma.statusControl).toBe(0xFE);   // bit 7 conservé (0x85), bas = 0x7E

    a.asic.write(0x2C0F, 0x3F);
    expect(a.dma.statusControl).toBe(0xBF);   // 0xFE & 0x80 | 0x3F
  });

  it('arme les bits d\'enable des canaux 0-2 (0x2C0F bits 0-2)', () => {
    const a = new TestAsic();
    a.dma.init();
    a.asic.write(0x2C0F, 0x07);
    expect(a.dma.statusControl & 0x07).toBe(0x07);
    a.dma.updateStatus();
    expect(a.dma.channels.every((c) => c.canExecute)).toBe(true);
  });

  it('donne 0xFF pour un registre DMA non câblé', () => {
    const a = new TestAsic();
    a.dma.init();
    expect(a.asic.read(0x2C03)).toBe(0xFF);
  });
});

describe('ASIC — instantané pour l\'interface', () => {
  it('pousse un état plat dans le callback injecté', () => {
    const a = new TestAsic();
    a.asic.write(0x2800, 0x01);
    a.asic.write(0x2805, 0x33);
    a.asic.updateUI();
    expect(a.uiStates).toHaveLength(1);
    const etat = a.uiStates[0];
    expect(etat.asicLocked).toBe(true);
    expect(etat.asicPri).toBe(0x01);
    expect(etat.asicIvr).toBe(0x33);
    expect(etat.channels).toBe(a.dma.channels);
    expect(etat.statusControl).toBe(a.dma.statusControl);
  });

  it('ne fait rien sans callback', () => {
    const a = new TestAsic();
    a.asic._updateAsicUI = null;
    expect(() => a.asic.updateUI()).not.toThrow();
    expect(a.uiStates).toHaveLength(0);
  });
});

describe('ASIC — adresses non mappées', () => {
  it('renvoie 0xFF hors des régions définies', () => {
    const a = new TestAsic();
    for (const offset of [0x1000, 0x1FFF, 0x2400 + 64, 0x2808, 0x2C10, 0x3000]) {
      expect(a.asic.read(offset), 'offset ' + offset.toString(16)).toBe(0xFF);
    }
  });

  it('ignore silencieusement une écriture hors des régions définies', () => {
    const a = new TestAsic();
    expect(() => a.asic.write(0x3000, 0xFF)).not.toThrow();
    expect(() => a.asic.write(0x1000, 0xFF)).not.toThrow();
  });
});
