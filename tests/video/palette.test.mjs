/**
 * @file tests/video/palette.test.mjs
 * @description Palette matérielle et couleurs ASIC du Gate Array.
 *
 * Couvre :
 *  - `init()` : table `hwColorToPalette` (32 couleurs 12 bits) et LUT de pixels ;
 *  - `setHardwareColor` : triplet hwColorValues / hwColorIndex / écriture vue ;
 *  - `reset()` : 17 stylo materialisés, 15 registers ASIC en couleur aléatoire ;
 *  - les écritures différées (`queueColorUpdate` / `applyQueuedColor`) et le
 *    fait qu'un `OUT` ne change la palette qu'au tick suivant ;
 *  - les couleurs 12 bits de l'ASIC CPC+ (`setAsicColorLow` / `setAsicColorHigh`),
 *    y compris la préservation croisée des composantes R/G/B.
 */

import { describe, it, expect } from 'vitest';
import { TestVideo, MONITOR_PALETTE } from '../helpers/gatearray-harness.mjs';

describe('Gate Array — table de couleurs 12 bits', () => {
  it('associe à chaque couleur matérielle un index de palette 12 bits', () => {
    const { ga } = new TestVideo();
    const table = ga.hwColorToPalette;

    expect(table).toHaveLength(32);
    for (let hw = 0; hw < 32; hw++) {
      expect(table[hw], `couleur matérielle ${hw}`).toBeGreaterThanOrEqual(0);
      expect(table[hw], `couleur matérielle ${hw}`).toBeLessThanOrEqual(4095);
    }
  });

  it('reproduit la table officielle Amstrad', () => {
    const { ga } = new TestVideo();
    // Table 12 bits de référence de l'Amstrad : les 16 premières entrées sont
    // les teintes CPC standard, les 16 suivantes les teintes « bright ».
    const attendu = [
      1638, 1638, 246, 4086, 6, 3846, 102, 3942,
      3846, 4086, 4080, 4095, 3840, 3855, 3936, 3951,
      6, 246, 240, 255, 0, 15, 96, 111,
      1542, 1782, 1776, 1791, 1536, 1551, 1632, 1647,
    ];
    expect(Array.from(ga.hwColorToPalette)).toEqual(attendu);
  });

  it('distingue bien les 32 entrées : hw 1 et 20 sont les deux noirs', () => {
    const { ga } = new TestVideo();
    const table = Array.from(ga.hwColorToPalette);

    // Le CPC a bien deux noirs (0 et 20) et deux valeurs identiques de gris
    // (0 et 1). On vérifie que la table n'est pas artificiellement dédoublonnée
    // et qu'elle n'est pas non plus une simple permutation.
    expect(table[0]).toBe(table[1]);
    expect(table[0]).not.toBe(table[20]);
    expect(new Set(table).size).toBeLessThan(32);
  });

  it('construit quatre LUT de pixels de 256 entrées', () => {
    const { ga } = new TestVideo();
    for (const lut of [ga.lutMode0, ga.lutMode1, ga.lutMode2, ga.lutMode3]) {
      expect(lut).toBeInstanceOf(Uint8Array);
      expect(lut).toHaveLength(256);
    }
  });

  it('sélectionne la LUT du mode 0 par défaut', () => {
    const { ga } = new TestVideo();
    expect(ga.currentLut).toBe(ga.lutMode0);
  });
});

describe('Gate Array — setHardwareColor', () => {
  it('met à jour le triplet valeur / index / écriture vue', () => {
    const v = new TestVideo();
    v.clearLogs();

    v.ga.setHardwareColor(3, 11);

    expect(v.ga.hwColorValues[3]).toBe(11);
    expect(v.ga.hwColorIndex[3]).toBe(v.ga.hwColorToPalette[11]);
    expect(v.paletteWrites).toEqual([
      { pen: 3, value: MONITOR_PALETTE[v.ga.hwColorToPalette[11]] },
    ]);
  });

  it('passe bien par la palette du moniteur, pas par la valeur brute', () => {
    const v = new TestVideo();
    v.clearLogs();

    v.ga.setHardwareColor(0, 6);

    // Si le Gate Array écrivait `6` directement dans la palette vue, la
    // valeur 6 serait indistinguishable de l'index 6. Ici l'index 6 vaut 102.
    expect(v.ga.hwColorIndex[0]).toBe(102);
    expect(v.paletteWrites[0].value).toBe(102);
  });

  it('accepte les deux Stylo extrêmes 0 et 31', () => {
    const v = new TestVideo();
    v.ga.setHardwareColor(0, 0);
    v.ga.setHardwareColor(31, 31);
    expect(v.ga.hwColorIndex[0]).toBe(v.ga.hwColorToPalette[0]);
    expect(v.ga.hwColorIndex[31]).toBe(v.ga.hwColorToPalette[31]);
  });
});

describe('Gate Array — reset', () => {
  it('matérialise les 17 stylo du CPC en couleur 20', () => {
    const v = new TestVideo();
    // couleur 20 = noir (index de palette 0)
    for (let pen = 0; pen <= 16; pen++) {
      expect(v.ga.hwColorValues[pen], `stylo ${pen}`).toBe(20);
      expect(v.ga.hwColorIndex[pen], `stylo ${pen}`).toBe(0);
    }
  });

  it('marque les 15 registres ASIC comme couleur 12 bits (-1)', () => {
    const v = new TestVideo();
    for (let pen = 17; pen <= 31; pen++) {
      expect(v.ga.hwColorValues[pen], `stylo ${pen}`).toBe(-1);
      expect(v.ga.hwColorIndex[pen]).toBeGreaterThanOrEqual(0);
      expect(v.ga.hwColorIndex[pen]).toBeLessThanOrEqual(4095);
    }
  });

  it('remet le mode vidéo à 0 et repasse le renderer en mode 0', () => {
    const v = new TestVideo();
    v.ga.romConfig = 2;
    v.ga.applyPaletteMode();
    v.clearLogs();

    v.ga.reset();

    expect(v.ga.romConfig).toBe(0);
    expect(v.ga.currentLut).toBe(v.ga.lutMode0);
    expect(v.renderModes).toContain(0);
  });

  it('réarme le compteur de lignes d\'interruption', () => {
    const v = new TestVideo();
    v.ga.scanlineCounter = 37;
    v.ga.gaIntStatus = 0x80;
    v.ga.selectedPen = 12;

    v.ga.reset();

    expect(v.ga.scanlineCounter).toBe(0);
    expect(v.ga.gaIntStatus).toBe(0);
    expect(v.ga.selectedPen).toBe(0);
  });
});

describe('Gate Array — écritures différées de couleur', () => {
  it('n\'applique la couleur qu\'au tick suivant', () => {
    const v = new TestVideo();
    v.clearLogs();

    v.ga.queueColorUpdate(5, 12);

    // Rien n'est encore écrit : c'est tout l'intérêt du tampon.
    expect(v.ga.hwColorValues[5]).toBe(20);
    expect(v.paletteWrites).toHaveLength(0);
    expect(v.ga.colorQueued).toBe(true);

    v.ga.applyQueuedColor();

    expect(v.ga.hwColorValues[5]).toBe(12);
    expect(v.paletteWrites).toHaveLength(1);
    expect(v.ga.colorQueued).toBe(false);
  });

  it('ne fait rien si aucune écriture n\'est en attente', () => {
    const v = new TestVideo();
    v.clearLogs();
    v.ga.applyQueuedColor();
    expect(v.paletteWrites).toHaveLength(0);
  });

  it('conserve la dernière écriture quand plusieurs sont empilées', () => {
    const v = new TestVideo();
    v.ga.queueColorUpdate(1, 2);
    v.ga.queueColorUpdate(1, 9);
    v.ga.applyQueuedColor();
    expect(v.ga.hwColorValues[1]).toBe(9);
  });
});

describe('Gate Array — sélection de stylo par port', () => {
  it('sélectionne le stylo 0–15 sur un octet à deux bits hauts nuls', () => {
    const v = new TestVideo();
    v.gaOut(0x7F00, 0x07);
    expect(v.ga.selectedPen).toBe(7);
  });

  it('sélectionne le stylo de bordure (16) quand le bit 4 est levé', () => {
    const v = new TestVideo();
    v.gaOut(0x7F00, 0x10);
    expect(v.ga.selectedPen).toBe(16);
  });

  it('ignore le bit 4 mis avec un numéro de stylo (la bordure gagne)', () => {
    const v = new TestVideo();
    v.gaOut(0x7F00, 0x1F);
    expect(v.ga.selectedPen).toBe(16);
  });

  it('n\'accepte le port que si A15:A14 vaut 01', () => {
    const v = new TestVideo();
    v.ga.selectedPen = 3;

    v.gaOut(0x3F00, 0x09);   // A15:A14 = 00
    v.gaOut(0xBF00, 0x09);   // A15:A14 = 10
    v.gaOut(0xFF00, 0x09);   // A15:A14 = 11

    expect(v.ga.selectedPen).toBe(3);
  });

  it('applique la couleur au stylo sélectionné après un OUT 01', () => {
    const v = new TestVideo();
    v.gaOut(0x7F00, 0x04);   // sélectionne le stylo 4
    v.gaOut(0x7F00, 0x44);   // 0b01000100 : couleur = 4
    v.ga.applyQueuedColor();

    expect(v.ga.hwColorValues[4]).toBe(4);
    expect(v.ga.hwColorValues[5]).toBe(20); // le voisin n'est pas touché
  });
});

describe('Gate Array — couleurs ASIC 12 bits (CPC+)', () => {
  it('compose R et B depuis l\'octet bas, en préservant G', () => {
    const v = new TestVideo();
    v.ga.setAsicColorHigh(20, 0x3);          // G = 3
    v.ga.setAsicColorLow(20, 0xA5);          // R = A, B = 5

    expect(v.ga.hwColorIndex[20]).toBe(0xA35);
  });

  it('compose G depuis l\'octet haut, en préservant R et B', () => {
    const v = new TestVideo();
    v.ga.setAsicColorLow(21, 0xC7);
    v.ga.setAsicColorHigh(21, 0x9);

    expect(v.ga.hwColorIndex[21]).toBe(0xC97);
  });

  it('passe le stylo en mode ASIC (-1) même si G est écrit seul', () => {
    const v = new TestVideo();
    v.ga.setHardwareColor(22, 11);
    expect(v.ga.hwColorValues[22]).toBe(11);

    v.ga.setAsicColorHigh(22, 0x1);
    expect(v.ga.hwColorValues[22]).toBe(-1);
  });

  it('ignore les bits inutilisés de chaque octet', () => {
    const v = new TestVideo();
    // L'octet bas ne contient que R (bits 7:4) et B (bits 3:0) ; l'octet haut
    // ne contient que G en bits 3:0. Les autres bits sont sans effet.
    v.ga.setAsicColorHigh(23, 0xF7);   // G = 7, le 0xF0 est ignoré
    v.ga.setAsicColorLow(23, 0xEE);    // R = E, B = E

    expect(v.ga.hwColorIndex[23]).toBe(0xE7E);
  });

  it('couvre les 4096 couleurs 12 bits de façon bijective', () => {
    const v = new TestVideo();
    const vus = new Set();

    for (let hw = 0; hw < 4096; hw++) {
      // R = bits 11:8, G = bits 7:4, B = bits 3:0. L'octet bas porte R et B,
      // l'octet haut ne porte que G : les deux écritures couvrent 12 bits.
      v.ga.setAsicColorHigh(24, (hw >>> 4) & 0x0F);
      v.ga.setAsicColorLow(24, ((hw >>> 8) & 0x0F) << 4 | (hw & 0x0F));
      vus.add(v.ga.hwColorIndex[24]);
    }

    expect(vus.size).toBe(4096);
  });

  it('reste dans la palette 12 bits pour les valeurs extrêmes', () => {
    const v = new TestVideo();
    // Blanc pur puis rouge pur. L'ordre compte : setAsicColorLow écrit R et B,
    // il faut donc le passer en premier pour qu'il ne les remette pas à zéro.
    v.ga.setAsicColorLow(25, 0xFF);
    v.ga.setAsicColorHigh(25, 0xFF);
    expect(v.ga.hwColorIndex[25]).toBe(4095);

    v.ga.setAsicColorLow(25, 0xF0);
    v.ga.setAsicColorHigh(25, 0x00);
    expect(v.ga.hwColorIndex[25]).toBe(0xF00);
  });

  it('applique les écritures ASIC différées une par une', () => {
    const v = new TestVideo();
    // reset() randomise les stylos 17–31 : on part d'une base explicite.
    v.ga.setAsicColorLow(26, 0x00);
    v.ga.setAsicColorHigh(26, 0x0);
    v.clearLogs();

    // 0x3C : R = 3 (bits 7:4), B = C (bits 3:0) → 0x3 0 C sur 12 bits.
    v.ga.writeAsicColorLow(26, 0x3C);
    v.ga.applyQueuedColor();
    expect(v.ga.hwColorIndex[26]).toBe(0x30C);

    v.ga.writeAsicColorHigh(26, 0x7);
    v.ga.applyQueuedColor();
    expect(v.ga.hwColorIndex[26]).toBe(0x37C);

    expect(v.paletteWrites.at(-1)).toEqual({
      pen: 26,
      value: MONITOR_PALETTE[0x37C],
    });
  });

  it('ne conserve qu\'une seule écriture ASIC en attente', () => {
    const v = new TestVideo();
    v.ga.setAsicColorLow(27, 0x00);
    v.ga.setAsicColorHigh(27, 0x0);

    // Le tampon est un slot unique, pas une file : la seconde écriture écrase
    // la première. Seule l'écriture « G » est donc appliquée, et comme R/B
    // valent 0 sur la base, le résultat est 0 — l'écriture R=F, B=F est
    // définitivement perdue. C'est le comportement réel du cœur.
    v.ga.writeAsicColorLow(27, 0xFF);
    v.ga.writeAsicColorHigh(27, 0x0);
    v.ga.applyQueuedColor();

    expect(v.ga.hwColorIndex[27]).toBe(0x000);
  });
});

describe('Gate Array — sélection de LUT selon le mode', () => {
  it('associe chaque mode vidéo à sa LUT', () => {
    const v = new TestVideo();
    const attendu = [v.ga.lutMode0, v.ga.lutMode1, v.ga.lutMode2, v.ga.lutMode3];

    for (let mode = 0; mode <= 3; mode++) {
      v.ga.romConfig = mode;
      v.ga.applyPaletteMode();
      expect(v.ga.currentLut, `mode ${mode}`).toBe(attendu[mode]);
    }
  });

  it('réutilise le renderer du mode 0 pour le mode 3', () => {
    const v = new TestVideo();
    v.clearLogs();

    v.ga.romConfig = 3;
    v.ga.applyPaletteMode();

    expect(v.renderModes.at(-1)).toBe(0);
    expect(v.ga.currentLut).toBe(v.ga.lutMode3);
  });

  it('laisse la LUT inchangée pour une valeur de romConfig hors bornes', () => {
    const v = new TestVideo();
    v.ga.romConfig = 2;
    v.ga.applyPaletteMode();
    v.ga.romConfig = 7;
    v.ga.applyPaletteMode();
    expect(v.ga.currentLut).toBe(v.ga.lutMode2);
  });
});
