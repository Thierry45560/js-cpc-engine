/**
 * @file tests/video/memory-banking.test.mjs
 * @description Banque RAM 64 Ko du 6128 (`Memory_Manager.updateBanking`).
 *
 * Complète `banking.test.mjs`, qui couvre la *bascule ROM* pilotée par le Gate
 * Array. Ici il s'agit de l'autre moitié de la sélection de banque : le
 * mappage des quatre pages de 16 Ko vers la RAM, y compris les huit banks de
 * 64 Ko de l'extension 512 Ko.
 *
 * Couvre :
 *  - le mode 0 (linéaire) et les modes 1, 2, 3, 4–7 ;
 *  - le choix du bank d'extension par les bits 5:3 ;
 *  - le filtrage du port (`A15 = 0`) et de la valeur (`bits 7:6 = 11`) ;
 *  - l'inhibition du mappage sur une machine sans extension RAM ;
 *  - la coherence lecture/écriture via `readRam` / `writeRam`.
 */

import { describe, it, expect } from 'vitest';
import { TestVideo } from '../helpers/gatearray-harness.mjs';

/**
 * Construit un gestionnaire mémoire câblé dans un état connu.
 * @param {object} [options] options du harnais
 * @returns {TestVideo}
 */
function machine(options) {
  return new TestVideo(options);
}

describe('Memory_Manager — port de sélection de banque', () => {
  it('applique la banque si A15 est à 0 et les bits 7:6 à 11', () => {
    const v = machine();
    // 0b11000001 → mode 1, sans extension : la page 3 est remappée.
    v.mem.writePort(0x7FFF, 0xC1);
    expect(v.mem.Bank[3]).not.toBe(49152);
  });

  it('ignore l\'écriture si A15 est levé', () => {
    const v = machine({ machineType: 2, ramExpansion: true });
    v.mem.reset();
    const avant = Array.from(v.mem.Bank);
    v.mem.writePort(0xFFFF, 0xC1);
    expect(Array.from(v.mem.Bank)).toEqual(avant);
  });

  it('ignore l\'écriture si les bits 7:6 ne valent pas 11', () => {
    const v = machine({ machineType: 2, ramExpansion: true });
    v.mem.reset();
    const avant = Array.from(v.mem.Bank);
    v.mem.writePort(0x7FFF, 0x81);   // 0b10000001
    expect(Array.from(v.mem.Bank)).toEqual(avant);
  });

  it('accepte toute la plage 0x0000–0x7FFF', () => {
    const v = machine({ machineType: 2, ramExpansion: true });
    v.mem.reset();
    v.mem.writePort(0x0000, 0xC0);
    expect(v.mem.Bank[0]).toBe(0);
    expect(v.mem.Bank[1]).toBe(16384);
  });
});

describe('Memory_Manager — mode 0 (linéaire)', () => {
  it('place les quatre pages sur les 64 Ko de base', () => {
    const v = machine();
    v.mem.writePort(0x7FFF, 0xC0);
    expect(Array.from(v.mem.Bank)).toEqual([0, 16384, 32768, 49152]);
  });

  it('restaure le mappage linéaire après un mode quelconque', () => {
    const v = machine();
    v.mem.writePort(0x7FFF, 0xC2);
    v.mem.writePort(0x7FFF, 0xC0);
    expect(Array.from(v.mem.Bank)).toEqual([0, 16384, 32768, 49152]);
  });
});

describe('Memory_Manager — mode 1 (page 3 étendue)', () => {
  it('laisse les pages 0 à 2 linéaires et déplace la page 3', () => {
    const v = machine({ machineType: 2, ramExpansion: true });
    v.mem.writePort(0x7FFF, 0xC1);
    expect(v.mem.Bank[0]).toBe(0);
    expect(v.mem.Bank[1]).toBe(16384);
    expect(v.mem.Bank[2]).toBe(32768);
    expect(v.mem.Bank[3]).toBe(65536 + 49152);
  });

  it('sélectionne le bank d\'extension avec les bits 5:3', () => {
    for (let bank = 0; bank < 8; bank++) {
      const v = machine({ machineType: 2, ramExpansion: true });
      v.mem.writePort(0x7FFF, 0xC1 | (bank << 3));
      expect(v.mem.Bank[3], `bank ${bank}`).toBe((bank + 1) * 65536 + 49152);
      v.dispose();
    }
  });
});

describe('Memory_Manager — mode 2 (bloc 64 Ko entier)', () => {
  it('place les quatre pages dans un même bank', () => {
    const v = machine({ machineType: 2, ramExpansion: true });
    v.mem.writePort(0x7FFF, 0xC2 | (3 << 3));
    const base = 4 * 65536;
    expect(Array.from(v.mem.Bank)).toEqual([
      base, base | 16384, base | 32768, base | 49152,
    ]);
  });
});

describe('Memory_Manager — mode 3', () => {
  it('déplace les pages 1 et 3', () => {
    const v = machine({ machineType: 2, ramExpansion: true });
    v.mem.writePort(0x7FFF, 0xC3);
    expect(v.mem.Bank[0]).toBe(0);
    expect(v.mem.Bank[1]).toBe(49152);
    expect(v.mem.Bank[2]).toBe(32768);
    expect(v.mem.Bank[3]).toBe(65536 + 49152);
  });
});

describe('Memory_Manager — modes 4 à 7 (page 1 ciblée)', () => {
  it('adresse un slot de 16 Ko dans le bank d\'extension', () => {
    for (let slot = 0; slot < 4; slot++) {
      const v = machine({ machineType: 2, ramExpansion: true });
      // Mode 4–7 : bits 2:0 = mode, bits 1:0 = slot dans le bank.
      // On fixe les bits 5:3 à 0 pour que le bank d'extension reste le
      // premier : 0b11000100 = mode 4, bank 0, slot 0.
      v.mem.writePort(0x7FFF, 0xC4 | slot);
      expect(v.mem.Bank[1], `slot ${slot}`).toBe(65536 + (slot << 14));
      v.dispose();
    }
  });

  it('combine slot et bank d\'extension indépendamment', () => {
    // 0b11011001 : bank = (0xD9 >>> 3) & 7 = 3, mode = 1 → on prend le mode 4
    // en forçant le bit 2 : 0b11011101 → bank 3, mode 5, slot 1.
    const v = machine({ machineType: 2, ramExpansion: true });
    v.mem.writePort(0x7FFF, 0xDD);
    expect(v.mem.Bank[1]).toBe(4 * 65536 + (1 << 14));
  });

  it('laisse les pages 0, 2 et 3 linéaires', () => {
    const v = machine({ machineType: 2, ramExpansion: true });
    v.mem.writePort(0x7FFF, 0xC7);
    expect(v.mem.Bank[0]).toBe(0);
    expect(v.mem.Bank[2]).toBe(32768);
    expect(v.mem.Bank[3]).toBe(49152);
  });
});

describe('Memory_Manager — inhibition sans extension RAM', () => {
  it('ignore toute sélection si la machine ne gère pas les banks', () => {
    // machineType 1 (664) sans extension : updateBanking sort immédiatement.
    const v = machine({ machineType: 1, ramExpansion: false });
    v.mem.reset();
    const avant = Array.from(v.mem.Bank);
    v.mem.writePort(0x7FFF, 0xC2);
    expect(Array.from(v.mem.Bank)).toEqual(avant);
  });

  it('autorise le mappage si l\'extension est présente malgré le type', () => {
    const v = machine({ machineType: 1, ramExpansion: true });
    v.mem.writePort(0x7FFF, 0xC2);
    expect(v.mem.Bank[0]).toBe(65536);
  });

  it('accepte machineType 2 et 4 sans extension', () => {
    for (const type of [2, 4]) {
      const v = machine({ machineType: type, ramExpansion: false });
      v.mem.writePort(0x7FFF, 0xC2);
      // Sans extension, `ramExpansion` vaut false et le bank de base reste
      // 65536 : le mode 2 s'applique quand même sur le 6128.
      expect(v.mem.Bank[0], `machineType ${type}`).toBe(65536);
      v.dispose();
    }
  });
});

describe('Memory_Manager — cohérence lecture / écriture', () => {
  it('écrit et relit au même emplacement après un mappage', () => {
    const v = machine({ machineType: 2, ramExpansion: true });
    v.mem.writePort(0x7FFF, 0xC1);   // page 3 → bank 0 de l'extension

    v.mem.writeRam(3, 0x1234, 0x5A);
    expect(v.mem.readRam(3, 0x1234)).toBe(0x5A);

    // L'écriture a bien atterri dans le bank d'extension, pas dans la base.
    expect(v.mem.ramData[65536 + 49152 + 0x1234]).toBe(0x5A);
  });

  it('isole les banks entre eux', () => {
    const v = machine({ machineType: 2, ramExpansion: true });
    v.mem.writePort(0x7FFF, 0xC1 | (0 << 3));
    v.mem.writeRam(3, 0x10, 0x11);

    v.mem.writePort(0x7FFF, 0xC1 | (1 << 3));
    v.mem.writeRam(3, 0x10, 0x22);
    expect(v.mem.readRam(3, 0x10)).toBe(0x22);

    v.mem.writePort(0x7FFF, 0xC1 | (0 << 3));
    expect(v.mem.readRam(3, 0x10)).toBe(0x11);
  });

  it('donne la même valeur par les deux chemins d\'accès', () => {
    const v = machine({ machineType: 2, ramExpansion: true });
    v.mem.writePort(0x7FFF, 0xC3);
    v.mem.ramData[v.mem.Bank[1] + 0x10] = 0x77;
    expect(v.mem.readRam(1, 0x10)).toBe(0x77);
  });
});

describe('Memory_Manager — reset', () => {
  it('restaure le mappage linéaire et remet le RAM à zéro', () => {
    const v = machine({ machineType: 2, ramExpansion: true });
    v.mem.writePort(0x7FFF, 0xC2 | (5 << 3));
    v.mem.writeRam(0, 0, 0x99);
    v.mem.memoryBanks[0] = 0x40;

    v.mem.reset();

    expect(Array.from(v.mem.Bank)).toEqual([0, 16384, 32768, 49152]);
    expect(Array.from(v.mem.memoryBanks)).toEqual([0, 0, 0, 0]);
    expect(v.mem.ramData[0]).toBe(0);
  });

  it('conserve la taille totale du tampon (576 Ko)', () => {
    const v = machine();
    // 64 Ko de base + 8 banks de 64 Ko d'extension.
    expect(v.mem.ramData).toHaveLength(589824);
  });
});
