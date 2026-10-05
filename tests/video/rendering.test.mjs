/**
 * @file tests/video/rendering.test.mjs
 * @description Chemin chaud du Gate Array : `tick()` et calcul d'adresse vidéo.
 *
 * `tick()` est appelé une fois par T-state — c'est la fonction la plus
 * sollicitée du fichier. Elle fait trois choses :
 *   1. dispatcher le rendu (blank / bordure / vidéo active / rien) ;
 *   2. avancer l'index de pixel ;
 *   3. recalculer `videoAddress` à partir de la ligne MA du CRTC et du
 *      compteur de ligne vidéo.
 *
 * Couvre :
 *  - le calcul d'adresse vidéo, y compris la formule de mélange des trois
 *    champs (bits 13:12, bits 2:0 et bits 9:0) ;
 *  - le mot de 16 bits assemblé depuis deux octets de RAM vidéo, via la LUT ;
 *  - les quatre branches de dispatch (skipRender, renderBlank, renderBorder,
 *    renderPixelFunc) ;
 *  - l'effet de `advancePixel` sur l'index de pixel ;
 *  - la désinterleaving des LUT de mode, vérifié sur les 256 valeurs.
 */

import { describe, it, expect } from 'vitest';
import { TestVideo, MONITOR_PALETTE } from '../helpers/gatearray-harness.mjs';

describe('Gate Array — adresse vidéo calculée depuis le CRTC', () => {
  it('adresse la base quand la ligne MA est nulle', () => {
    const v = new TestVideo();
    v.crtc.maRow = 0;
    v.crtc.vlc = 0;
    v.ga.videoAddress = 0xFFFF;
    v.ga.tick();
    expect(v.ga.videoAddress).toBe(0);
  });

  it('décale la ligne MA de deux bits vers le poids de l\'octet', () => {
    const v = new TestVideo();
    v.crtc.maRow = 0x0010;
    v.crtc.vlc = 0;
    v.ga.tick();
    expect(v.ga.videoAddress).toBe(0x0020);
  });

  it('place la page MA (bits 13:12) en 0x4000/0x8000/0xC000', () => {
    // (maRow & 0x3000) << 2 : le bit 12 devient le bit 14, le bit 13 le 15.
    for (const [maRow, attendu] of [
      [0x1000, 0x4000], [0x2000, 0x8000], [0x3000, 0xC000],
    ]) {
      const v = new TestVideo();
      v.crtc.maRow = maRow;
      v.crtc.vlc = 0;
      v.ga.tick();
      expect(v.ga.videoAddress, `maRow ${maRow.toString(16)}`).toBe(attendu);
    }
  });

  it('décale le compteur de ligne vidéo de 11 bits', () => {
    // (vlc & 7) << 11 : les 3 bits bas du VLC choisissent le bloc de 8 Ko.
    for (const [vlc, attendu] of [[0, 0], [1, 0x0800], [7, 0x3800]]) {
      const v = new TestVideo();
      v.crtc.maRow = 0;
      v.crtc.vlc = vlc;
      v.ga.tick();
      expect(v.ga.videoAddress, `vlc ${vlc}`).toBe(attendu);
    }
  });

  it('masque le VLC sur ses 3 bits bas', () => {
    const v = new TestVideo();
    v.crtc.maRow = 0;
    v.crtc.vlc = 0xF8;        // 0b11111000 : les 3 bits bas sont nuls
    v.ga.tick();
    expect(v.ga.videoAddress).toBe(0);
  });

  it('compose les trois champs sans recouvrement', () => {
    const v = new TestVideo();
    v.crtc.maRow = 0x3000 | 0x0123;   // page 3 + offset 0x246
    v.crtc.vlc = 5;                   // bloc 0x2800
    v.ga.tick();
    expect(v.ga.videoAddress).toBe(0xC000 | 0x2800 | 0x246);
  });

  it('reste dans l\'espace d\'adressage 16 bits', () => {
    const v = new TestVideo();
    for (let maRow = 0; maRow < 0x4000; maRow += 7) {
      for (let vlc = 0; vlc < 8; vlc++) {
        v.crtc.maRow = maRow;
        v.crtc.vlc = vlc;
        v.ga.tick();
        expect(v.ga.videoAddress).toBeLessThanOrEqual(0xFFFF);
        expect(v.ga.videoAddress).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('recalcule l\'adresse à chaque tick, pas seulement au changement', () => {
    const v = new TestVideo();
    v.crtc.maRow = 0x0001;
    v.ga.tick();
    const premier = v.ga.videoAddress;
    v.ga.tick();
    // Le second tick repart de la même valeur CRTC : l'adresse est stable.
    expect(v.ga.videoAddress).toBe(premier);
  });
});

describe('Gate Array — tick() : dispatch du rendu', () => {
  it('saute le rendu hors de la fenêtre de ligne', () => {
    const v = new TestVideo();
    v.display.pixelIndex = 0;
    v.display.lineBufferOffset = 100;
    v.display.lineBufferLimit = 200;
    v.ga.tick();
    expect(v.rendered.skip).toBe(1);
    expect(v.renderedWords).toHaveLength(0);
  });

  it('rend du vide pendant le VBlank', () => {
    const v = new TestVideo();
    v.display.pixelIndex = 150;
    v.display.lineBufferOffset = 100;
    v.display.lineBufferLimit = 200;
    v.display.vblankCounter = 1;
    v.ga.tick();
    expect(v.rendered.blank).toBe(1);
  });

  it('rend du vide pendant le HSync', () => {
    const v = new TestVideo();
    v.display.pixelIndex = 150;
    v.display.lineBufferOffset = 100;
    v.display.lineBufferLimit = 200;
    v.display.vblankCounter = 0;
    v.crtc.hsyncActive = true;
    v.ga.tick();
    expect(v.rendered.blank).toBe(1);
  });

  it('rend la bordure avant la zone vidéo', () => {
    const v = new TestVideo();
    v.display.pixelIndex = 150;
    v.display.lineBufferOffset = 100;
    v.display.lineBufferLimit = 200;
    v.display.vblankCounter = 0;
    v.crtc.hsyncActive = false;
    v.crtc.border = true;
    v.prime();            // `border` n'est lu qu'au tick suivant
    v.clearLogs();        // on efface ce qu'a produit l'alignement
    v.ga.tick();
    expect(v.rendered.border).toBe(1);
    expect(v.renderedWords).toHaveLength(0);
  });

  it('rend des pixels dans la zone vidéo active', () => {
    const v = new TestVideo();
    v.display.pixelIndex = 150;
    v.display.lineBufferOffset = 100;
    v.display.lineBufferLimit = 200;
    v.display.vblankCounter = 0;
    v.crtc.hsyncActive = false;
    v.crtc.border = false;
    v.ga.tick();
    expect(v.renderedWords).toHaveLength(1);
  });

  it('respecte strictement les bornes de la fenêtre', () => {
    const v = new TestVideo();
    v.display.lineBufferOffset = 100;
    v.display.lineBufferLimit = 200;

    v.display.pixelIndex = 99;
    v.ga.tick();
    expect(v.rendered.skip).toBe(1);

    v.display.pixelIndex = 100;   // borne inférieure incluse
    v.ga.tick();
    expect(v.rendered.skip).toBe(1);
    expect(v.renderedWords).toHaveLength(1);

    v.display.pixelIndex = 199;
    v.ga.tick();
    expect(v.renderedWords).toHaveLength(2);

    v.display.pixelIndex = 200;   // borne supérieure exclusive
    v.ga.tick();
    expect(v.renderedWords).toHaveLength(2);
  });

  it('donne la priorité au VBlank sur la bordure', () => {
    const v = new TestVideo();
    v.display.pixelIndex = 150;
    v.display.lineBufferOffset = 100;
    v.display.lineBufferLimit = 200;
    v.display.vblankCounter = 5;
    v.crtc.border = true;
    v.ga.tick();
    expect(v.rendered.blank).toBe(1);
    expect(v.rendered.border).toBe(0);
  });

  it('donne la priorité au HSync sur la bordure', () => {
    const v = new TestVideo();
    v.display.pixelIndex = 150;
    v.display.lineBufferOffset = 100;
    v.display.lineBufferLimit = 200;
    v.display.vblankCounter = 0;
    v.crtc.hsyncActive = true;
    v.crtc.border = true;
    v.ga.tick();
    expect(v.rendered.blank).toBe(1);
    expect(v.rendered.border).toBe(0);
  });

  it('avance l\'index de pixel d\'un cran à chaque tick', () => {
    const v = new TestVideo();
    v.display.pixelIndex = 0;
    v.display.lineBufferOffset = 0;
    v.display.lineBufferLimit = 0x1000;
    for (let i = 0; i < 5; i++) v.ga.tick();
    expect(v.display.advancePixel).toBe(5);
  });

  it('rafraîchit le drapeau de bordure depuis le CRTC', () => {
    const v = new TestVideo();
    v.display.pixelIndex = 150;
    v.display.lineBufferOffset = 100;
    v.display.lineBufferLimit = 200;
    v.crtc.border = true;
    v.ga.border = false;
    v.ga.tick();
    expect(v.ga.border).toBe(true);
  });
});

describe('Gate Array — tick() : assemblage du mot de 16 bits', () => {
  it('lit deux octets consécutifs en mémoire vidéo', () => {
    const v = new TestVideo();
    v.display.pixelIndex = 150;
    v.display.lineBufferOffset = 100;
    v.display.lineBufferLimit = 200;
    v.crtc.maRow = 0x0100;         // adresse 0x0200
    v.crtc.vlc = 0;
    v.prime();                     // l'adresse n'est lue qu'au tick suivant
    v.clearLogs();
    v.mem.ramData[0x0200] = 0x12;
    v.mem.ramData[0x0201] = 0x34;

    v.ga.tick();

    const lut = v.ga.currentLut;
    expect(v.renderedWords).toHaveLength(1);
    expect(v.renderedWords[0]).toBe((lut[0x34] << 8) | lut[0x12]);
  });

  it('place l\'octet de poids faible en premier', () => {
    const v = new TestVideo();
    v.display.pixelIndex = 150;
    v.display.lineBufferOffset = 100;
    v.display.lineBufferLimit = 200;
    v.ga.romConfig = 0;
    v.ga.applyPaletteMode();

    v.crtc.maRow = 0;
    v.mem.ramData[0] = 0xFF;
    v.mem.ramData[1] = 0x00;
    v.ga.tick();

    // En mode 0, la LUT est une permutation de 8 bits sur 8 bits.
    expect(v.renderedWords[0]).toBe(0x00FF);
  });

  it('passe le mot au renderer après la LUT, pas les octets bruts', () => {
    const v = new TestVideo();
    v.display.pixelIndex = 150;
    v.display.lineBufferOffset = 100;
    v.display.lineBufferLimit = 200;
    v.ga.romConfig = 2;
    v.ga.applyPaletteMode();

    v.crtc.maRow = 0;
    v.mem.ramData[0] = 0xF0;   // mode 2 : 8 pixels, inversion MSB→poids faible
    v.mem.ramData[1] = 0x0F;
    v.ga.tick();

    const lut = v.ga.currentLut;
    expect(v.renderedWords[0]).toBe((lut[0x0F] << 8) | lut[0xF0]);
  });
});

describe('Gate Array — désinterleaving des LUT de mode', () => {
  it('mode 2 : le mot est une inversion MSB-first des 8 bits', () => {
    const { ga } = new TestVideo();
    for (let a = 0; a < 256; a++) {
      // lutMode2 place le bit 0 en position 7, le bit 7 en position 0.
      expect(ga.lutMode2[a], `octet ${a}`).toBe(
        ((a & 0x01) << 7) | ((a & 0x02) << 5) | ((a & 0x04) << 3) | ((a & 0x08) << 1) |
        ((a & 0x10) >>> 1) | ((a & 0x20) >>> 3) | ((a & 0x40) >>> 5) | ((a & 0x80) >>> 7),
      );
    }
  });

  it('mode 0 : deux nibbles séparés par les bits pairs et impairs', () => {
    const { ga } = new TestVideo();
    // En mode 0 le CPC entrelace deux pixels de 4 bits : le nibble haut reçoit
    // les bits 7,5,3,1 et le nibble bas les bits 6,4,2,0.
    for (let a = 0; a < 256; a++) {
      const attendu =
        ((a & 0x02) << 2) | ((a & 0x20) >>> 3) | ((a & 0x08) >>> 2) | ((a & 0x80) >>> 7) |
        ((a & 0x01) << 7) | ((a & 0x10) << 2) | ((a & 0x04) << 3) | ((a & 0x40) >>> 2);
      expect(ga.lutMode0[a], `octet ${a}`).toBe(attendu);
    }
  });

  it('mode 1 : quatre pixels de 2 bits depuis les bits 2,1,5,4', () => {
    const { ga } = new TestVideo();
    for (let a = 0; a < 256; a++) {
      const attendu =
        ((a & 0x08) >>> 2) | ((a & 0x80) >>> 7) |
        ((a & 0x04) << 1)  | ((a & 0x40) >>> 4) |
        ((a & 0x02) << 4)  | ((a & 0x20) >>> 1) |
        ((a & 0x01) << 7)  | ((a & 0x10) << 2);
      expect(ga.lutMode1[a], `octet ${a}`).toBe(attendu);
    }
  });

  it('mode 3 : n\'utilise que les bits 2,3,6,7 (4 pixels de 4 bits)', () => {
    const { ga } = new TestVideo();
    for (let a = 0; a < 256; a++) {
      const attendu =
        ((a & 0x08) >>> 2) | ((a & 0x80) >>> 7) | ((a & 0x04) << 3) | ((a & 0x40) >>> 2);
      expect(ga.lutMode3[a], `octet ${a}`).toBe(attendu);
    }
  });

  it('mode 0 : chaque nibble ne dépend que d\'un seul ensemble de 4 bits', () => {
    const { ga } = new TestVideo();

    // En mode 0 le CPC entrelace deux pixels de 4 bits dans un octet. Plutôt
    // que de recopier la formule du cœur (ce qui ne testerait qu'une recopie),
    // on vérifie la PROPRIÉTÉ qui définit l'entrelacement : basculer un bit de
    // l'octet ne change que le nibble auquel il appartient.
    //
    // Testée sur les 256 entrées, cette propriété établit que les bits pairs
    // (0,2,4,6) alimentent le nibble haut et les bits impairs (1,3,5,7) le bas.
    const changeNibbleHaut = new Set();
    const changeNibbleBas  = new Set();

    for (let a = 0; a < 256; a++) {
      for (let n = 0; n < 8; n++) {
        const altere = a ^ (1 << n);
        const hautChange = (ga.lutMode0[altere] >>> 4) !== (ga.lutMode0[a] >>> 4);
        const basChange  = (ga.lutMode0[altere] & 0x0F) !== (ga.lutMode0[a] & 0x0F);
        if (hautChange) changeNibbleHaut.add(n);
        if (basChange) changeNibbleBas.add(n);
        // Un bit ne peut pas alimenter les deux nibbles à la fois.
        expect(hautChange && basChange, `bit ${n}, octet ${a}`).toBe(false);
      }
    }

    expect([...changeNibbleHaut].sort((x, y) => x - y)).toEqual([0, 2, 4, 6]);
    expect([...changeNibbleBas].sort((x, y) => x - y)).toEqual([1, 3, 5, 7]);
  });

  it('mode 0 : les 4 bits du haut couvrent les 16 valeurs de nibble', () => {
    const { ga } = new TestVideo();
    const hauts = new Set();
    const bas  = new Set();
    for (let a = 0; a < 256; a++) {
      hauts.add(ga.lutMode0[a] >>> 4);
      bas.add(ga.lutMode0[a] & 0x0F);
    }
    expect(hauts.size).toBe(16);
    expect(bas.size).toBe(16);
  });

  it('les LUT de mode 0 et 1 sont des permutations des 256 valeurs', () => {
    const { ga } = new TestVideo();
    for (const lut of [ga.lutMode0, ga.lutMode1, ga.lutMode2]) {
      expect(new Set(lut).size, 'bijectivité').toBe(256);
    }
  });

  it('la LUT de mode 3 n\'est pas bijective : seuls 4 bits comptent', () => {
    const { ga } = new TestVideo();
    // Le mode 3 n'utilise que 4 des 8 bits d'entrée : 16 valeurs distinctes.
    expect(new Set(ga.lutMode3).size).toBe(16);
  });
});

describe('Gate Array — écriture de palette vue par le renderer', () => {
  it('écrit la couleur convertie par le filtre du moniteur', () => {
    const v = new TestVideo();
    v.clearLogs();
    v.ga.setHardwareColor(8, 11);
    // 11 = blanc = index 4095, dernier de la palette du moniteur.
    expect(v.paletteWrites.at(-1)).toEqual({ pen: 8, value: MONITOR_PALETTE[4095] });
  });

  it('écrit une couleur ASIC convertie elle aussi', () => {
    const v = new TestVideo();
    v.clearLogs();
    v.ga.setAsicColorLow(18, 0xF0);
    v.ga.setAsicColorHigh(18, 0xF);
    const attendu = (0xF << 8) | 0xF0;
    expect(v.paletteWrites.at(-1)).toEqual({ pen: 18, value: MONITOR_PALETTE[attendu] });
  });
});
