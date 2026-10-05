/**
 * @file tests/video/banking.test.mjs
 * @description Sélection de banque mémoire pilotée par le Gate Array.
 *
 * Couvre :
 *  - le décodage de l'octet de configuration ROM (`OUT (0x7Fxx),$xx`) ;
 *  - la boucle de retour `ROM_Manager.updateRomConfig → Palette_Colors.romConfig`
 *    qui lie le mode vidéo à la configuration ROM ;
 *  - l'activation/désactivation des ROM haute et basse (bits 3 et 2) ;
 *  - `selectAsicRom` : indexation des 8 emplacements du CPC+ et les 4 modes de
 *    correspondance de page, dont le mode 3 qui mappe la RAM ASIC ;
 *  - la priorité de lecture de `ROM_Manager.readMemory` (ROM haute > ROM basse
 *    > RAM ASIC > RAM physique) ;
 *  - le fait que la sélection ASIC n'a lieu que sur un octet `101xxxxx` et
 *    seulement si l'ASIC n'est pas verrouillé.
 */

import { describe, it, expect } from 'vitest';
import { TestVideo, romImage } from '../helpers/gatearray-harness.mjs';

describe('Gate Array — décodage de l\'octet de configuration ROM', () => {
  it('délègue l\'écriture à ROM_Manager', () => {
    const v = new TestVideo();
    v.clearLogs();
    v.gaOut(0x7F00, 0x80);
    expect(v.updateRomConfigCalls).toEqual([0x80]);
  });

  it('ignore les ports dont A15:A14 ne vaut pas 01', () => {
    const v = new TestVideo();
    v.clearLogs();
    v.gaOut(0x3F00, 0x80);
    v.gaOut(0xFF00, 0x80);
    expect(v.updateRomConfigCalls).toEqual([]);
  });

  it('accepte toute la plage 0x4000–0x7FFF', () => {
    const v = new TestVideo();
    v.clearLogs();
    v.gaOut(0x4000, 0x80);
    v.gaOut(0x7FFF, 0x80);
    expect(v.updateRomConfigCalls).toHaveLength(2);
  });

  it('n\'interprète pas les bits 7:5 = 110/111 comme une config ROM', () => {
    // 110xxxxx et 111xxxxx ne tombent dans aucun cas du switch : le Gate Array
    // les ignore. C'est le comportement du décodeur à 5 bits.
    const v = new TestVideo();
    v.clearLogs();
    v.gaOut(0x7F00, 0xC0);
    v.gaOut(0x7F00, 0xE0);
    expect(v.updateRomConfigCalls).toEqual([]);
  });

  it('sélectionne la ROM ASIC sur un octet 101xxxxx quand l\'ASIC est libre', () => {
    const v = new TestVideo({ machineType: 4 });
    v.asic.locked = false;
    v.clearLogs();
    v.gaOut(0x7F00, 0xA0);
    expect(v.selectAsicRomCalls).toEqual([0xA0]);
    expect(v.updateRomConfigCalls).toEqual([]);
  });

  it('retombe sur la config ROM si l\'ASIC est verrouillé', () => {
    const v = new TestVideo({ machineType: 4 });
    v.asic.locked = true;
    v.clearLogs();
    v.gaOut(0x7F00, 0xA0);
    expect(v.selectAsicRomCalls).toEqual([]);
    expect(v.updateRomConfigCalls).toEqual([0xA0]);
  });

  it('n\'arme pas le réarmement d\'IRQ sur une sélection ASIC', () => {
    const v = new TestVideo({ machineType: 4 });
    v.asic.locked = false;
    v.runFrame(52);
    v.gaOut(0x7F00, 0xB0);   // 10110000 : bit 4 levé, mais c'est une sélection
    expect(v.ga.gaIntStatus & 0x80).toBe(0x80);
  });
});

describe('Gate Array — mode vidéo et configuration ROM', () => {
  it('remonte le mode dans romConfig (bits 1:0)', () => {
    const v = new TestVideo();
    for (const mode of [0, 1, 2, 3]) {
      v.gaOut(0x7F00, 0x80 | mode);
      expect(v.ga.romConfig, `mode ${mode}`).toBe(mode);
    }
  });

  it('applique la LUT correspondant au mode écrit', () => {
    const v = new TestVideo();
    const luts = [v.ga.lutMode0, v.ga.lutMode1, v.ga.lutMode2, v.ga.lutMode3];

    for (const mode of [0, 1, 2, 3]) {
      v.gaOut(0x7F00, 0x80 | mode);
      v.ga.applyPaletteMode();
      expect(v.ga.currentLut, `mode ${mode}`).toBe(luts[mode]);
    }
  });

  it('ignore les bits hauts pour le mode (seuls les bits 1:0 comptent)', () => {
    const v = new TestVideo();
    v.gaOut(0x7F00, 0x81);
    expect(v.ga.romConfig).toBe(1);
    v.gaOut(0x7F00, 0x83);
    expect(v.ga.romConfig).toBe(3);
  });
});

describe('Gate Array — activation des ROM', () => {
  it('laisse les deux ROM activées par défaut', () => {
    const v = new TestVideo();
    expect(v.rom.upperRomEnabled).toBe(true);
    expect(v.rom.lowerRomEnabled).toBe(true);
  });

  it('désactive la ROM haute avec le bit 3', () => {
    const v = new TestVideo();
    v.gaOut(0x7F00, 0x88);
    expect(v.rom.upperRomEnabled).toBe(false);
    expect(v.rom.lowerRomEnabled).toBe(true);
  });

  it('désactive la ROM basse avec le bit 2', () => {
    const v = new TestVideo();
    v.gaOut(0x7F00, 0x84);
    expect(v.rom.lowerRomEnabled).toBe(false);
    expect(v.rom.upperRomEnabled).toBe(true);
  });

  it('désactive les deux avec les bits 3 et 2', () => {
    const v = new TestVideo();
    v.gaOut(0x7F00, 0x8C);
    expect(v.rom.upperRomEnabled).toBe(false);
    expect(v.rom.lowerRomEnabled).toBe(false);
  });

  it('les réactive avec un octet sans les bits 3 et 2', () => {
    const v = new TestVideo();
    v.gaOut(0x7F00, 0x8C);
    v.gaOut(0x7F00, 0x80);
    expect(v.rom.upperRomEnabled).toBe(true);
    expect(v.rom.lowerRomEnabled).toBe(true);
  });

  it('combine désactivation et mode dans le même octet', () => {
    const v = new TestVideo();
    v.gaOut(0x7F00, 0x89);   // bit 3 + mode 1
    expect(v.rom.upperRomEnabled).toBe(false);
    expect(v.ga.romConfig).toBe(1);
  });
});

describe('Gate Array — priority de lecture ROM_Manager', () => {
  /**
   * Monte une configuration complète : RAM physique remplie d'un motif
   * reconnaissable, ROM basse et ROM haute chargées, pages masquées.
   * @param {TestVideo} v
   */
  function mountRomConfig(v) {
    v.rom.loadLowerRom(romImage(0x00));
    v.rom.loadUpperRom(0, romImage(0x40));
    v.rom.loadROMs();
    for (let i = 0; i < v.mem.ramData.length; i++) v.mem.ramData[i] = 0xAA;
  }

  it('lit la ROM basse en page 0 quand elle est activée', () => {
    const v = new TestVideo();
    mountRomConfig(v);
    expect(v.rom.readMemory(0x0000)).toBe(0x00);
  });

  it('lit la ROM haute en page 3 quand elle est activée', () => {
    const v = new TestVideo();
    mountRomConfig(v);
    expect(v.rom.readMemory(0xC000)).toBe(0x40);
  });

  it('retombe sur la RAM physique en page 0 si la ROM basse est coupée', () => {
    const v = new TestVideo();
    mountRomConfig(v);
    v.gaOut(0x7F00, 0x84);   // ROM basse désactivée
    expect(v.rom.readMemory(0x0000)).toBe(0xAA);
  });

  it('retombe sur la RAM physique en page 3 si la ROM haute est coupée', () => {
    const v = new TestVideo();
    mountRomConfig(v);
    v.gaOut(0x7F00, 0x88);
    expect(v.rom.readMemory(0xC000)).toBe(0xAA);
  });

  it('donne la priorité à la ROM haute sur la RAM en page 3', () => {
    const v = new TestVideo();
    mountRomConfig(v);
    // La ROM haute l'emporte : la valeur n'est pas le motif RAM 0xAA.
    expect(v.rom.readMemory(0xC000)).not.toBe(0xAA);
  });

  it('donne la priorité à la ROM basse sur la RAM ASIC en mode 3', () => {
    const v = new TestVideo({ machineType: 4 });
    mountRomConfig(v);
    v.asicRam.fill(0x5A);
    v.rom.upperRoms[0] = romImage(0x00);
    // Mode 3 : la ROM basse est remappée en page 0 ET la RAM ASIC activée en
    // page 1. Attention, `selectAsicRom` affecte `currentLowerRom` dans tous
    // les modes, y compris le 3 — d'où `upperRoms[0]`, pas la ROM OS.
    v.rom.selectAsicRom(0x18);
    expect(v.rom.readMemory(0x0000)).toBe(0x00);
    expect(v.rom.readMemory(0x4000)).toBe(0x5A);
  });

  it('suit le décalage d\'offset dans la ROM', () => {
    const v = new TestVideo();
    mountRomConfig(v);
    expect(v.rom.readMemory(0x0010)).toBe(0x10);
    expect(v.rom.readMemory(0xC010)).toBe(0x50);
  });

  it('renvoie 0xFF quand une ROM activée est vide (bus flottant)', () => {
    const v = new TestVideo();
    v.rom.currentUpperRom = null;
    expect(v.rom.readMemory(0xC000)).toBe(0xFF);
  });
});

describe('Gate Array — sélection de la ROM ASIC (CPC+)', () => {
  it('indexe les 8 emplacements avec les bits 2:0', () => {
    for (let slot = 0; slot < 8; slot++) {
      const v = new TestVideo({ machineType: 4 });
      v.rom.upperRoms[slot] = romImage(slot * 0x10);
      v.clearLogs();

      v.gaOut(0x7F00, 0xA0 | slot);

      expect(v.selectAsicRomCalls, `slot ${slot}`).toEqual([0xA0 | slot]);
      expect(v.rom.currentLowerRom, `slot ${slot}`).toBe(v.rom.upperRoms[slot]);
    }
  });

  it('masque le numéro d\'emplacement sur 3 bits', () => {
    const v = new TestVideo({ machineType: 4 });
    v.rom.upperRoms[3] = romImage(0x30);
    // 0xA0 | 0x08 : le bit 3 ne fait pas partie du numéro d'emplacement.
    v.gaOut(0x7F00, 0xA8);
    expect(v.rom.currentLowerRom).toBe(v.rom.upperRoms[0]);
  });

  it('mappe la ROM basse en page 0 (mode 0)', () => {
    const v = new TestVideo({ machineType: 4 });
    v.rom.upperRoms[0] = romImage(0x00);
    v.gaOut(0x7F00, 0xA0);
    expect(v.rom.romMapping).toBe(0);
    expect(v.rom.readMemory(0x0000)).toBe(0x00);
  });

  it('mappe la ROM basse en page 1 (mode 1)', () => {
    const v = new TestVideo({ machineType: 4 });
    v.mem.ramData.fill(0xAA);
    v.rom.upperRoms[0] = romImage(0x00);
    v.gaOut(0x7F00, 0xA0);
    v.gaOut(0x7F00, 0xA8);   // bits 4:3 = 01 → mode 1
    expect(v.rom.romMapping).toBe(1);
    expect(v.rom.readMemory(0x4000)).toBe(0x00);
    // La page 0 n'est plus mappée sur la ROM : elle retombe sur la RAM.
    expect(v.rom.readMemory(0x0000)).toBe(0xAA);
  });

  it('mappe la ROM basse en page 2 (mode 2)', () => {
    const v = new TestVideo({ machineType: 4 });
    v.mem.ramData.fill(0xAA);
    v.rom.upperRoms[0] = romImage(0x00);
    v.gaOut(0x7F00, 0xA0);
    v.gaOut(0x7F00, 0xB0);   // bits 4:3 = 10 → mode 2
    expect(v.rom.romMapping).toBe(2);
    expect(v.rom.readMemory(0x8000)).toBe(0x00);
    expect(v.rom.readMemory(0x0000)).toBe(0xAA);
  });

  it('remplace la ROM basse par la RAM ASIC en page 1 (mode 3)', () => {
    const v = new TestVideo({ machineType: 4 });
    v.rom.upperRoms[0] = romImage(0x00);
    v.asicRam.fill(0x5A);
    v.gaOut(0x7F00, 0xA0);
    v.gaOut(0x7F00, 0xB8);   // bits 4:3 = 11 → mode 3

    // Le cœur ramène le mapping à 0 et active la RAM ASIC.
    expect(v.rom.romMapping).toBe(0);
    expect(v.rom.asicRamEnabled).toBe(true);
    expect(v.rom.readMemory(0x4000)).toBe(0x5A);
  });

  it('désactive la RAM ASIC dès qu\'on sort du mode 3', () => {
    const v = new TestVideo({ machineType: 4 });
    v.gaOut(0x7F00, 0xB8);
    expect(v.rom.asicRamEnabled).toBe(true);
    v.gaOut(0x7F00, 0xA0);
    expect(v.rom.asicRamEnabled).toBe(false);
  });

  it('donne la lecture de la RAM ASIC sur la RAM physique', () => {
    const v = new TestVideo({ machineType: 4 });
    v.mem.ramData.fill(0xAA);
    v.asicRam.fill(0x5A);
    v.gaOut(0x7F00, 0xB8);
    expect(v.rom.readMemory(0x4000)).toBe(0x5A);
  });

  it('n\'écrit jamais dans les ROM, seulement en RAM ASIC', () => {
    const v = new TestVideo({ machineType: 4 });
    v.asicRam.fill(0x00);
    v.gaOut(0x7F00, 0xB8);

    v.rom.writeMemory(0x4000, 0x77);
    expect(v.asicRam[0]).toBe(0x77);

    v.gaOut(0x7F00, 0xA0);   // retour au mode 0
    v.rom.writeMemory(0x4000, 0x88);
    expect(v.asicRam[0]).toBe(0x77);   // inchangée
  });
});

describe('Gate Array — sélection de la ROM haute', () => {
  it('sélectionne BASIC (emplacement 0) sur un CPC classique', () => {
    const v = new TestVideo({ machineType: 2 });
    v.rom.loadUpperRom(0, romImage(0x10));
    v.rom.loadUpperRom(7, romImage(0x70));
    v.rom.writePort(0x4000, 0);
    expect(v.rom.currentUpperRom).toBe(v.rom.lowerRom.get(0));
  });

  it('sélectionne AMSDOS (emplacement 7) sur un CPC classique', () => {
    const v = new TestVideo({ machineType: 2 });
    v.rom.loadUpperRom(0, romImage(0x10));
    v.rom.loadUpperRom(7, romImage(0x70));
    v.rom.writePort(0x4000, 7);
    expect(v.rom.currentUpperRom).toBe(v.rom.lowerRom.get(7));
  });

  it('retombe sur BASIC pour tout emplacement autre que 7', () => {
    const v = new TestVideo({ machineType: 2 });
    v.rom.loadUpperRom(0, romImage(0x10));
    v.rom.writePort(0x4000, 3);
    expect(v.rom.currentUpperRom).toBe(v.rom.lowerRom.get(0));
  });

  it('indexe directement les 32 emplacements sur un CPC+', () => {
    const v = new TestVideo({ machineType: 4 });
    v.rom.upperRoms[11] = romImage(0xB0);
    v.rom.writePort(0x4000, 11);
    expect(v.rom.currentUpperRom).toBe(v.rom.upperRoms[11]);
  });

  it('ignore l\'écriture si le port a A13 levé', () => {
    const v = new TestVideo({ machineType: 2 });
    v.rom.loadUpperRom(0, romImage(0x10));
    v.rom.loadUpperRom(7, romImage(0x70));
    v.rom.writePort(0x4000, 0);
    v.rom.writePort(0x6000, 7);   // A13 = 1
    expect(v.rom.currentUpperRom).toBe(v.rom.lowerRom.get(0));
  });
});
