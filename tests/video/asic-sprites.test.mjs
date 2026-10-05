/**
 * @file tests/video/asic-sprites.test.mjs
 * @description Tests du moteur de sprites matériels du CPC+ (PriManager).
 *
 * `renderAsicSplit()` reconstruit un tampon de 1024 pixels pour une ligne de
 * caractère, en dessinant les sprites 15 -> 0 : le plus petit indice écrase
 * donc les autres (priorité maximale). Chaque sprite est une matrice 16x16 de
 * pixels 4 bits ; la position verticale courante est reconstruite à partir
 * des compteurs CRTC.
 */

import { describe, it, expect } from 'vitest';
import { TestAsic } from '../helpers/asic-harness.mjs';

/** Base de la fenêtre d'attributs de sprite dans la page ASIC. */
const ATTR = 0x2000;
/** Base de la fenêtre de pixels de sprite. */
const PIX = 0x0000;

/**
 * Remplit une ligne de 16 pixels de la matrice d'un sprite.
 * @param {TestAsic} a
 * @param {number} idx  index du sprite (0-15)
 * @param {number} ligne  ligne 0-15
 * @param {number[]} valeurs
 */
function setRow(a, idx, ligne, valeurs) {
  for (let col = 0; col < 16; col++) {
    a.asic.write(PIX + idx * 0x100 + ligne * 16 + col, valeurs[col]);
  }
}

/**
 * Configure un sprite complet par la fenêtre de registres.
 * @param {TestAsic} a
 * @param {number} idx
 * @param {{x?:number, y?:number, magX?:number, magY?:number}} attrs
 */
function configure(a, idx, { x = 0, y = 0, magX = 1, magY = 1 }) {
  a.asic.write(ATTR + idx * 8 + 0, x & 0xFF);
  a.asic.write(ATTR + idx * 8 + 1, (x >>> 8) & 0x03);
  a.asic.write(ATTR + idx * 8 + 2, y & 0xFF);
  a.asic.write(ATTR + idx * 8 + 3, (y >>> 8) & 0x03);
  a.asic.write(ATTR + idx * 8 + 4, ((magX & 3) << 2) | (magY & 3));
}

/** Une ligne entièrement pleine, valeur `v`. */
function pleine(v) {
  return new Array(16).fill(v);
}

describe('ASIC sprites — attributs', () => {
  it('sélectionne le sprite par les bits 3-2 de l\'offset d\'attributs', () => {
    const a = new TestAsic();
    configure(a, 5, { x: 0x123, y: 0x234, magX: 2, magY: 3 });
    expect(a.pri.id[5].x).toBe(0x123);
    expect(a.pri.id[5].y).toBe(0x234);
    expect(a.pri.id[5].magX).toBe(2);
    expect(a.pri.id[5].magY).toBe(3);
    expect(a.pri.id[0].x).toBe(0);
  });

  it('conserve 10 bits de position horizontale', () => {
    // Le registre haut fournit 2 bits (valeur & 3) : x va jusqu'à 0x3FF,
    // ce qui correspond exactement à la taille du tampon (1024 pixels).
    const a = new TestAsic();
    a.asic.write(ATTR + 8 + 0, 0xFF);
    a.asic.write(ATTR + 8 + 1, 0xFF);
    expect(a.pri.id[1].x).toBe(0x3FF);
  });

  it('relit les attributs écrits', () => {
    const a = new TestAsic();
    configure(a, 3, { x: 0x2A5, y: 0x1B6, magX: 3, magY: 2 });
    expect(a.asic.read(ATTR + 24 + 0)).toBe(0xA5);
    expect(a.asic.read(ATTR + 24 + 1)).toBe(0x02);
    expect(a.asic.read(ATTR + 24 + 2)).toBe(0xB6);
    expect(a.asic.read(ATTR + 24 + 3)).toBe(0x01);
    expect(a.asic.read(ATTR + 24 + 4)).toBe((3 << 2) | 2);
  });

  it('relit la position horizontale sur 10 bits', () => {
    const a = new TestAsic();
    configure(a, 0, { x: 0x3FF, y: 0 });
    expect(a.asic.read(ATTR + 0)).toBe(0xFF);
    expect(a.asic.read(ATTR + 1)).toBe(0x03);
  });

  it('relit 0 pour les emplacements 5 à 7 d\'un sprite', () => {
    const a = new TestAsic();
    configure(a, 0, { x: 0x11, y: 0x22, magX: 1, magY: 1 });
    for (const k of [5, 6, 7]) expect(a.asic.read(ATTR + k)).toBe(0);
  });

  it('écrit les pixels sur 4 bits', () => {
    const a = new TestAsic();
    a.asic.write(PIX + 2 * 0x100, 0xFF);
    expect(a.pri.id[2].priBuffer[0]).toBe(0x0F);
  });
});

describe('ASIC sprites — rendu de ligne', () => {
  it('ne rend rien si magX ou magY vaut 0', () => {
    const a = new TestAsic();
    for (const [magX, magY] of [[0, 1], [1, 0], [0, 0]]) {
      configure(a, 0, { x: 0, y: 0, magX, magY });
      setRow(a, 0, 0, pleine(5));
      a.pri.renderAsicSplit();
      expect(a.pri.buffer.every((p) => p === 0), magX + '/' + magY).toBe(true);
    }
  });

  it('ne rend que les pixels non nuls', () => {
    const a = new TestAsic();
    configure(a, 0, { x: 0, y: 0, magX: 1, magY: 1 });
    const ligne = new Array(16).fill(0);
    ligne[0] = 3; ligne[15] = 9;
    setRow(a, 0, 0, ligne);
    a.pri.renderAsicSplit();
    expect(a.pri.buffer[0]).toBe(3);
    expect(a.pri.buffer[15]).toBe(9);
    expect([...a.pri.buffer].filter((p) => p !== 0)).toEqual([3, 9]);
  });

  it('suit la ligne verticale du CRTC (vcc<<3 | vlcCrtc)', () => {
    const a = new TestAsic();
    configure(a, 0, { x: 0, y: 0, magX: 1, magY: 1 });
    setRow(a, 0, 0, pleine(1));
    setRow(a, 0, 1, pleine(2));
    setRow(a, 0, 8, pleine(3));

    a.crtc.vcc = 0; a.crtc.vlcCrtc = 0;
    a.pri.renderAsicSplit();
    expect(a.pri.buffer[0]).toBe(1);

    a.crtc.vcc = 0; a.crtc.vlcCrtc = 1;
    a.pri.renderAsicSplit();
    expect(a.pri.buffer[0]).toBe(2);

    a.crtc.vcc = 1; a.crtc.vlcCrtc = 0;      // currentY = 8
    a.pri.renderAsicSplit();
    expect(a.pri.buffer[0]).toBe(3);
  });

  it('ignore les bits 7-3 de vlcCrtc', () => {
    // currentY ne prend que 3 bits du compteur de ligne : vlcCrtc = 9 et
    // vlcCrtc = 1 désignent la même ligne de sprite.
    const a = new TestAsic();
    configure(a, 0, { x: 0, y: 0, magX: 1, magY: 1 });
    setRow(a, 0, 0, pleine(1));
    setRow(a, 0, 1, pleine(2));
    a.crtc.vcc = 0; a.crtc.vlcCrtc = 9;
    a.pri.renderAsicSplit();
    expect(a.pri.buffer[0]).toBe(2);
  });

  it('saute un sprite dont la ligne dépasse 15', () => {
    const a = new TestAsic();
    configure(a, 0, { x: 0, y: 0, magX: 1, magY: 1 });
    setRow(a, 0, 0, pleine(4));
    a.crtc.vcc = 2; a.crtc.vlcCrtc = 0;     // currentY = 16 -> rien à afficher
    a.pri.renderAsicSplit();
    expect([...a.pri.buffer].every((p) => p === 0)).toBe(true);
  });

  it('enveloppe le compteur vertical sur 512 lignes', () => {
    const a = new TestAsic();
    configure(a, 0, { x: 0, y: 506, magX: 1, magY: 1 });
    setRow(a, 0, 0, pleine(6));
    setRow(a, 0, 8, pleine(7));
    // currentY = 2 : (2 - 506) & 0x1FF = 8, le sprite "repasse" en haut.
    a.crtc.vcc = 0; a.crtc.vlcCrtc = 2;
    a.pri.renderAsicSplit();
    expect(a.pri.buffer[0]).toBe(7);
  });
});

describe('ASIC sprites — magnification', () => {
  it('divise la hauteur par 1, 2 ou 4 selon magY', () => {
    // currentY = 17 (diff = 17) sert de référence :
    //   magY = 1 -> ligne 17, hors de la matrice de 16 lignes -> rien
    //   magY = 2 -> ligne 8
    //   magY = 3 -> ligne 4
    for (const [magY, attendu] of [[1, 0], [2, 2], [3, 3]]) {
      const a = new TestAsic();
      configure(a, 0, { x: 0, y: 0, magX: 1, magY });
      setRow(a, 0, 0, pleine(1));
      setRow(a, 0, 8, pleine(2));
      setRow(a, 0, 4, pleine(3));
      setRow(a, 0, 15, pleine(4));
      a.crtc.vcc = 2; a.crtc.vlcCrtc = 1;
      a.pri.renderAsicSplit();
      expect(a.pri.buffer[0], 'magY ' + magY).toBe(attendu);
    }
  });

  it('affiche la ligne courante sans division quand magY = 1', () => {
    const a = new TestAsic();
    configure(a, 0, { x: 0, y: 0, magX: 1, magY: 1 });
    setRow(a, 0, 5, pleine(6));
    setRow(a, 0, 6, pleine(7));
    a.crtc.vcc = 0; a.crtc.vlcCrtc = 5;
    a.pri.renderAsicSplit();
    expect(a.pri.buffer[0]).toBe(6);
    a.crtc.vlcCrtc = 6;
    a.pri.renderAsicSplit();
    expect(a.pri.buffer[0]).toBe(7);
  });

  it('étale un pixel sur 1, 2 ou 4 colonnes selon magX', () => {
    for (const [magX, largeur] of [[1, 1], [2, 2], [3, 4]]) {
      const a = new TestAsic();
      configure(a, 0, { x: 0, y: 0, magX, magY: 1 });
      const ligne = new Array(16).fill(0);
      ligne[4] = 8;
      setRow(a, 0, 0, ligne);
      a.pri.renderAsicSplit();
      const attendu = new Array(largeur).fill(8);
      expect([...a.pri.buffer.slice(4 * largeur, 4 * largeur + largeur)]).toEqual(attendu);
      // rien en dehors du bloc
      expect(a.pri.buffer[4 * largeur - 1]).toBe(0);
      expect(a.pri.buffer[4 * largeur + largeur]).toBe(0);
    }
  });

  it('ne duplique pas un pixel nul en mode agrandi', () => {
    const a = new TestAsic();
    configure(a, 0, { x: 0, y: 0, magX: 3, magY: 1 });
    const ligne = new Array(16).fill(0);
    ligne[0] = 5;
    setRow(a, 0, 0, ligne);
    a.pri.renderAsicSplit();
    expect([...a.pri.buffer.slice(0, 8)]).toEqual([5, 5, 5, 5, 0, 0, 0, 0]);
  });

  it('agrandit des pixels séparés par des trous', () => {
    const a = new TestAsic();
    configure(a, 0, { x: 0, y: 0, magX: 2, magY: 1 });
    const ligne = new Array(16).fill(0);
    ligne[0] = 1;
    ligne[7] = 2;
    setRow(a, 0, 0, ligne);
    a.pri.renderAsicSplit();
    expect([...a.pri.buffer.slice(0, 18)]).toEqual([
      1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 0, 0,
    ]);
  });

  it('agrandit en largeur et en hauteur simultanément', () => {
    const a = new TestAsic();
    configure(a, 0, { x: 0, y: 0, magX: 3, magY: 3 });
    const ligne = new Array(16).fill(0);
    ligne[2] = 6;
    for (const l of [0, 1, 2, 3, 4]) setRow(a, 0, l, ligne);
    a.crtc.vcc = 0; a.crtc.vlcCrtc = 0;       // ligne 0 -> ligne 0 du sprite
    a.pri.renderAsicSplit();
    expect(a.pri.buffer[8]).toBe(6);          // 4 fois la colonne 2
    expect(a.pri.buffer[9]).toBe(6);
    expect(a.pri.buffer[10]).toBe(6);
    expect(a.pri.buffer[11]).toBe(6);
    expect(a.pri.buffer[4]).toBe(0);          // colonne 1 : vide
  });
});

describe('ASIC sprites — position horizontale', () => {
  it('pose les pixels à partir de x', () => {
    const a = new TestAsic();
    configure(a, 0, { x: 300, y: 0, magX: 1, magY: 1 });
    setRow(a, 0, 0, pleine(3));
    a.pri.renderAsicSplit();
    expect(a.pri.buffer[300]).toBe(3);
    expect(a.pri.buffer[299]).toBe(0);
    expect(a.pri.buffer[315]).toBe(3);
    expect(a.pri.buffer[316]).toBe(0);       // fin du sprite
  });

  it('enveloppe sur 1024 pixels, y compris en mode agrandi', () => {
    const a = new TestAsic();
    configure(a, 0, { x: 1022, y: 0, magX: 1, magY: 1 });
    setRow(a, 0, 0, pleine(1));
    a.pri.renderAsicSplit();
    expect(a.pri.buffer[1022]).toBe(1);
    expect(a.pri.buffer[1023]).toBe(1);
    expect(a.pri.buffer[0]).toBe(1);          // 1024 -> 0
    expect(a.pri.buffer[1]).toBe(1);          // 1025 -> 1
  });

  it('un sprite placé à x = 512 n\'écrit pas dans la première moitié', () => {
    const a = new TestAsic();
    configure(a, 0, { x: 512, y: 0, magX: 1, magY: 1 });
    setRow(a, 0, 0, pleine(2));
    a.pri.renderAsicSplit();
    expect(a.pri.buffer.slice(0, 16).every((p) => p === 0)).toBe(true);
    expect(a.pri.buffer[512]).toBe(2);
  });
});

describe('ASIC sprites — composition', () => {
  it('donne la priorité au plus petit indice', () => {
    const a = new TestAsic();
    configure(a, 15, { x: 0, y: 0, magX: 1, magY: 1 });
    configure(a, 0, { x: 0, y: 0, magX: 1, magY: 1 });
    setRow(a, 15, 0, pleine(15));
    setRow(a, 0, 0, pleine(1));
    a.pri.renderAsicSplit();
    expect(a.pri.buffer[0]).toBe(1);
    expect(a.pri.buffer[1]).toBe(1);
  });

  it('un pixel nul ne perce pas le sprite du dessous', () => {
    // Seul un pixel non nul est écrit : la transparence prime sur l\'ordre.
    const a = new TestAsic();
    configure(a, 15, { x: 0, y: 0, magX: 1, magY: 1 });
    configure(a, 0, { x: 0, y: 0, magX: 1, magY: 1 });
    setRow(a, 15, 0, pleine(9));
    const ligne0 = new Array(16).fill(0);
    ligne0[5] = 1;
    setRow(a, 0, 0, ligne0);
    a.pri.renderAsicSplit();
    expect(a.pri.buffer[5]).toBe(1);
    expect(a.pri.buffer[4]).toBe(9);
  });

  it('superpose deux sprites décalés horizontalement', () => {
    const a = new TestAsic();
    configure(a, 1, { x: 0, y: 0, magX: 1, magY: 1 });
    configure(a, 2, { x: 8, y: 0, magX: 1, magY: 1 });
    setRow(a, 1, 0, pleine(0x0A));
    setRow(a, 2, 0, pleine(0x0C));
    a.pri.renderAsicSplit();
    // Le sprite 1 est prioritaire : il gagne sur le chevauchement 8-15.
    expect([...a.pri.buffer.slice(0, 16)]).toEqual(new Array(16).fill(0x0A));
    expect([...a.pri.buffer.slice(16, 24)]).toEqual(new Array(8).fill(0x0C));
  });

  it('efface le tampon à chaque ligne', () => {
    const a = new TestAsic();
    configure(a, 0, { x: 0, y: 0, magX: 1, magY: 1 });
    setRow(a, 0, 0, pleine(7));
    a.crtc.vlcCrtc = 0;
    a.pri.renderAsicSplit();
    expect(a.pri.buffer[0]).toBe(7);
    a.crtc.vlcCrtc = 1;                       // le sprite a quitté la ligne
    a.pri.renderAsicSplit();
    expect(a.pri.buffer[0]).toBe(0);
  });

  it('un sprite masqué par magY = 0 laisse la place au sprite du dessous', () => {
    const a = new TestAsic();
    configure(a, 7, { x: 0, y: 0, magX: 1, magY: 0 });   // prioritaire mais invisible
    configure(a, 8, { x: 0, y: 0, magX: 1, magY: 1 });
    setRow(a, 7, 0, pleine(7));
    setRow(a, 8, 0, pleine(8));
    a.pri.renderAsicSplit();
    expect(a.pri.buffer[0]).toBe(8);
  });
});

describe('ASIC sprites — état', () => {
  it('reset remet attributs, pixels et tampon à zéro', () => {
    const a = new TestAsic();
    configure(a, 0, { x: 100, y: 100, magX: 3, magY: 3 });
    setRow(a, 0, 0, pleine(5));
    a.pri.renderAsicSplit();
    a.pri.reset();
    expect(a.pri.id[0].x).toBe(0);
    expect(a.pri.id[0].magX).toBe(0);
    expect(a.pri.id[0].priBuffer[0]).toBe(0);
    expect([...a.pri.buffer].every((p) => p === 0)).toBe(true);
    expect(a.pri.audioBufferIndex).toBe(0);
  });
});