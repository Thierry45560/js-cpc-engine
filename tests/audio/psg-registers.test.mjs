/**
 * @file tests/audio/psg-registers.test.mjs
 * @description Tests des registres et du bus du PSG AY-3-8910.
 *
 * Le PSG n'est joignable qu'au travers du port PPI : les bits 7:6 du port C
 * décident de l'opération (01 = lecture, 10 = écriture, 11 = sélection). Toute
 * écriture de valeur passe donc par ce décodage.
 */

import { describe, it, expect } from 'vitest';
import { TestPsg } from '../helpers/psg-harness.mjs';

describe('PSG — sélection de registre', () => {
  it('ne garde que les 4 bits faibles', () => {
    const a = new TestPsg();
    a.setMode(3);
    a.write(0x13);
    expect(a.psg.Sel_Reg_Index).toBe(0x03);
    a.write(0xFF);
    expect(a.psg.Sel_Reg_Index).toBe(0x0F);
    a.write(0x10);
    expect(a.psg.Sel_Reg_Index).toBe(0x00);
  });

  it('sélectionne via le mode 11 et écrit via le mode 10', () => {
    const a = new TestPsg();
    a.setMode(3);
    a.write(7);
    expect(a.psg.Sel_Reg_Index).toBe(7);
    a.setMode(2);
    a.write(0x3E);
    expect(a.psg.Regs_Main[7]).toBe(0x3E);
  });

  it('ignore les écritures en mode 00 et 01', () => {
    for (const mode of [0, 1]) {
      const a = new TestPsg();
      a.setMode(3);
      a.write(7);
      a.setMode(mode);
      a.write(0x3E);
      expect(a.psg.Regs_Main[7], 'mode ' + mode).toBe(0x00);
      a.setMode(mode);
      a.write(11);
      expect(a.psg.Sel_Reg_Index, 'mode ' + mode).toBe(7);
    }
  });
});

describe('PSG — masques de registres', () => {
  it('applique le masque au moment du stockage', () => {
    const a = new TestPsg();
    a.setReg(1, 0xFF);
    expect(a.psg.Regs_Main[1]).toBe(0x0F);   // accord fin : 4 bits
    a.setReg(6, 0xFF);
    expect(a.psg.Regs_Main[6]).toBe(0x1F);   // période de bruit : 5 bits
    a.setReg(13, 0xFF);
    expect(a.psg.Regs_Main[13]).toBe(0x0F);  // forme d'enveloppe : 4 bits
  });

  it('conserve les 8 bits là où le registre en a 8', () => {
    const a = new TestPsg();
    a.setReg(7, 0xFF);
    expect(a.psg.Regs_Main[7]).toBe(0xFF);   // mixeur : 8 bits
    a.setReg(0, 0xFF);
    expect(a.psg.Regs_Main[0]).toBe(0xFF);   // accord grossier : 8 bits
    a.setReg(11, 0xFF);
    expect(a.psg.Regs_Main[11]).toBe(0xFF);  // période d'enveloppe : 16 bits
    a.setReg(12, 0xFF);
    expect(a.psg.Regs_Main[12]).toBe(0xFF);
    a.setReg(2, 0xFF);
    expect(a.psg.Regs_Main[2]).toBe(0xFF);
  });

  it('masque les trois registres de volume à 5 bits', () => {
    // Divergence documentée, sans effet sonore : seuls les bits 3:0 sont lus
    // par le mixeur, mais la relecture du registre perd les bits 7-5.
    const a = new TestPsg();
    a.setReg(8, 0xE5);
    a.setReg(9, 0xE5);
    a.setReg(10, 0xE5);
    expect(a.psg.Regs_Main[8]).toBe(0x05);
    expect(a.psg.Regs_Main[9]).toBe(0x05);
    expect(a.psg.Regs_Main[10]).toBe(0x05);
  });

  it('aligne le masque sur les 16 registres', () => {
    const a = new TestPsg();
    expect([...a.psg.Reg_Masks]).toEqual([
      255, 15, 255, 15, 255, 15, 31, 255, 31, 31, 31, 255, 255, 15, 255, 255,
    ]);
  });

  it('R9 et R10 sont masqués à 5 bits comme R8', () => {
    const a = new TestPsg();
    expect(a.psg.Reg_Masks[8]).toBe(31);
    expect(a.psg.Reg_Masks[9]).toBe(31);
    expect(a.psg.Reg_Masks[10]).toBe(31);
  });
});

describe('PSG — périodes de tonalité', () => {
  it('compose les périodes sur 12 bits', () => {
    const a = new TestPsg();
    // L'accord fin (R1/R3/R5) est masqué à 4 bits : 0x12 deviendrait 0x02.
    a.setReg(0, 0x34).setReg(1, 0x01);
    a.setReg(2, 0x00).setReg(3, 0x02);
    a.setReg(4, 0xFF).setReg(5, 0x0F);
    expect(a.psg.chanPeriods[0]).toBe(0x0134);
    expect(a.psg.chanPeriods[1]).toBe(0x0200);
    expect(a.psg.chanPeriods[2]).toBe(0x0FFF);
  });

  it('force la période à 1 quand elle vaut 0', () => {
    const a = new TestPsg();
    a.setReg(0, 0x00).setReg(1, 0x00);
    a.setReg(2, 0x00).setReg(3, 0x00);
    a.setReg(4, 0x00).setReg(5, 0x00);
    expect([...a.psg.chanPeriods]).toEqual([1, 1, 1]);
  });

  it('recompose la période à chaque écriture d\'une moitié', () => {
    // Écrire seulement la moitié grossière suffit : la valeur combine
    // l'ancien accord fin, jamais un mélange incohérent.
    const a = new TestPsg();
    a.setReg(0, 0x00).setReg(1, 0x01);
    expect(a.psg.chanPeriods[0]).toBe(0x0100);
    a.setReg(0, 0x7F);
    expect(a.psg.chanPeriods[0]).toBe(0x017F);
  });
});

describe('PSG — période de bruit (R6)', () => {
  it('double la période et ramène 0 à 1', () => {
    const a = new TestPsg();
    for (const [r6, attendu] of [[0, 1], [1, 2], [2, 4], [15, 30], [31, 62]]) {
      a.setReg(6, r6);
      expect(a.psg.Noise_Gen.Period, 'R6 = ' + r6).toBe(attendu);
    }
  });
});

describe('PSG — mixeur (R7)', () => {
  it('inverse les bits : 1 signifie muet', () => {
    const a = new TestPsg();
    a.setReg(7, 0x00);
    expect([...a.psg.chanToneEnable]).toEqual([1, 1, 1]);
    expect([...a.psg.chanNoiseEnable]).toEqual([1, 1, 1]);

    a.setReg(7, 0x3F);
    expect([...a.psg.chanToneEnable]).toEqual([0, 0, 0]);
    expect([...a.psg.chanNoiseEnable]).toEqual([0, 0, 0]);
  });

  it('traite les canaux indépendamment', () => {
    const a = new TestPsg();
    a.setReg(7, 0x02);                       // ton B coupé
    expect([...a.psg.chanToneEnable]).toEqual([1, 0, 1]);
    a.setReg(7, 0x10);                       // bruit B coupé
    expect([...a.psg.chanNoiseEnable]).toEqual([1, 0, 1]);
    a.setReg(7, 0x08);
    expect([...a.psg.chanNoiseEnable]).toEqual([0, 1, 1]);
  });

  it('range les deux directions de port dans les bits 6-7', () => {
    // `!!(val & 0x40)` produit un booléen, pas un nombre.
    const a = new TestPsg();
    a.setReg(7, 0x00);
    expect(a.psg.IO_Port_A_Dir).toBe(false);
    expect(a.psg.IO_Port_B_Dir).toBe(false);
    a.setReg(7, 0xC0);
    expect(a.psg.IO_Port_A_Dir).toBe(true);
    expect(a.psg.IO_Port_B_Dir).toBe(true);
    a.setReg(7, 0x80);
    expect(a.psg.IO_Port_A_Dir).toBe(false);
    expect(a.psg.IO_Port_B_Dir).toBe(true);
  });
});

describe('PSG — volumes fixes (R8 à R10)', () => {
  it('passe le volume par la table logarithmique', () => {
    const a = new TestPsg();
    a.setReg(8, 0x0F);
    expect(a.psg.chanVolumes[0]).toBe(1);
    a.setReg(9, 0x00);
    expect(a.psg.chanVolumes[1]).toBe(0);
    a.setReg(10, 0x08);
    expect(a.psg.chanVolumes[2]).toBe(a.psg.Volume_Log_Table[8]);
  });

  it('n\'active l\'enveloppe que sur le bit 4', () => {
    const a = new TestPsg();
    a.setReg(8, 0x10);
    a.setReg(9, 0x00);
    a.setReg(10, 0x1F);
    expect([...a.psg.chanMixerEnable]).toEqual([1, 0, 1]);
  });

  it('ignore le bit 4 pour le volume fixe lui-même', () => {
    const a = new TestPsg();
    a.setReg(8, 0x1F);
    expect(a.psg.chanVolumes[0]).toBe(a.psg.Volume_Log_Table[15]);
  });

  it('expose une table de 16 niveaux strictement croissante', () => {
    const a = new TestPsg();
    const t = [...a.psg.Volume_Log_Table];
    expect(t).toHaveLength(16);
    expect(t[0]).toBe(0);
    expect(t[15]).toBe(1);
    for (let i = 1; i < 16; i++) expect(t[i], 'niveau ' + i).toBeGreaterThan(t[i - 1]);
  });
});

describe('PSG — période et forme d\'enveloppe', () => {
  it('compose la période sur 16 bits et ramène 0 à 1', () => {
    const a = new TestPsg();
    a.setReg(11, 0x34).setReg(12, 0x12);
    expect(a.psg.Envelope_Gen.Envelope_Period).toBe(0x1234);
    a.setReg(11, 0x00).setReg(12, 0x00);
    expect(a.psg.Envelope_Gen.Envelope_Period).toBe(1);
  });

  it('découpe les quatre bits de forme de R13', () => {
    const a = new TestPsg();
    a.setReg(13, 0x0F);
    const env = a.psg.Envelope_Gen;
    expect(env.Env_Shape_Continue).toBe(true);
    expect(env.Env_Shape_Attack).toBe(true);
    expect(env.Env_Shape_Alternate).toBe(true);
    expect(env.Env_Shape_Hold).toBe(true);
    expect(env.Volume_Level).toBe(0);            // attaque -> départ au silence

    a.setReg(13, 0x00);
    expect(env.Env_Shape_Continue).toBe(false);
    expect(env.Volume_Level).toBe(15);           // sinon départ au maximum
  });

  it('repose les compteurs à chaque écriture de R13', () => {
    const a = new TestPsg();
    a.setReg(11, 0x01).setReg(12, 0x00).setReg(13, 0x00);
    a.clock(5);
    expect(a.psg.Envelope_Gen.Counter_Val).toBe(5);
    a.setReg(13, 0x04);
    expect(a.psg.Envelope_Gen.Counter_Val).toBe(0);
    expect(a.psg.Envelope_Gen.Update_Cycles).toBe(0);
  });
});

describe('PSG — lecture du bus (mode 01)', () => {
  it('renvoie 0xFF hors du mode lecture', () => {
    const a = new TestPsg();
    a.setReg(7, 0x3E);
    for (const mode of [0, 2, 3]) {
      a.setMode(mode);
      expect(a.psg.readPort(), 'mode ' + mode).toBe(0xFF);
    }
  });

  it('relit le registre sélectionné', () => {
    const a = new TestPsg();
    a.setReg(5, 0x0C);
    a.setMode(1);
    expect(a.psg.readPort()).toBe(0x0C);
  });

  it('relit la ligne du clavier au registre 14', () => {
    const a = new TestPsg({ keyboardRow: 0x5A });
    a.select(14).setMode(1);
    expect(a.psg.readPort()).toBe(0x5A);
    expect(a.keyboardReads).toBe(1);

    a.select(13).setMode(1);
    expect(a.psg.readPort()).toBe(0x00);
    expect(a.keyboardReads).toBe(1);            // le clavier n'est pas relu
  });
});

describe('PSG — écriture DMA', () => {
  it('écrit sans changer la sélection courante', () => {
    const a = new TestPsg();
    a.setReg(1, 0x04);
    a.psg.writeFromDMA(7, 0x3E);
    expect(a.psg.Regs_Main[7]).toBe(0x3E);
    expect(a.psg.Sel_Reg_Index).toBe(1);
    // 0x3E = 0b0011_1110 : seul le ton du canal A reste actif.
    expect([...a.psg.chanToneEnable]).toEqual([1, 0, 0]);
  });

  it('applique le masque du registre ciblé', () => {
    const a = new TestPsg();
    a.psg.writeFromDMA(1, 0xFF);
    expect(a.psg.Regs_Main[1]).toBe(0x0F);
    expect(a.psg.chanPeriods[0]).toBe(0x0F00);   // R0 vaut toujours 0
  });
});

describe('PSG — alias de compatibilité', () => {
  it('selectRegisterPSG et writeRegisterPSG agissent sur le registre', () => {
    const a = new TestPsg();
    a.psg.selectRegisterPSG(6);
    expect(a.psg.Sel_Reg_Index).toBe(6);
    a.psg.writeRegisterPSG(0x03);
    expect(a.psg.Regs_Main[6]).toBe(0x03);
    expect(a.psg.Noise_Gen.Period).toBe(6);
  });

  it('les alias ignorent le mode du port PPI', () => {
    const a = new TestPsg();
    a.setMode(0);
    a.psg.selectRegisterPSG(5);
    expect(a.psg.Sel_Reg_Index).toBe(5);
    a.psg.writeRegisterPSG(0x02);
    expect(a.psg.Regs_Main[5]).toBe(0x02);
  });
});

describe('PSG — reset', () => {
  it('remet les 16 registres à zéro', () => {
    const a = new TestPsg();
    for (let i = 0; i < 16; i++) a.setReg(i, 0x5A);
    a.psg.reset();
    expect([...a.psg.Regs_Main]).toEqual(new Array(16).fill(0));
  });

  it('restaure R0 comme registre sélectionné', () => {
    // Régression : la boucle de mise à zéro des 16 registres laissait R15
    // sélectionné, alors que l'état attendu est R0.
    const a = new TestPsg();
    a.select(6);
    expect(a.psg.Sel_Reg_Index).toBe(6);
    a.psg.reset();
    expect(a.psg.Sel_Reg_Index).toBe(0);
    a.setMode(1);
    expect(a.psg.readPort()).toBe(0);      // R0, pas R15
  });

  it('réarme période 1 sur les trois canaux', () => {
    const a = new TestPsg();
    a.setReg(0, 0x12).setReg(1, 0x34).setReg(2, 0x56).setReg(3, 0x78);
    a.psg.reset();
    expect([...a.psg.chanPeriods]).toEqual([1, 1, 1]);
    expect([...a.psg.chanCounters]).toEqual([0, 0, 0]);
    expect([...a.psg.chanToggles]).toEqual([0, 0, 0]);
  });

  it('laisse les canaux démasqués et sans volume', () => {
    const a = new TestPsg();
    a.setReg(7, 0x3F).setReg(8, 0x0F);
    a.psg.reset();
    expect([...a.psg.chanToneEnable]).toEqual([1, 1, 1]);
    expect([...a.psg.chanNoiseEnable]).toEqual([1, 1, 1]);
    expect([...a.psg.chanVolumes]).toEqual([0, 0, 0]);
    expect([...a.psg.chanMixerEnable]).toEqual([0, 0, 0]);
    expect(a.psg.Output_ChanA).toBe(0);
  });

  it('repose la graine du bruit et la période d\'enveloppe', () => {
    const a = new TestPsg();
    a.setReg(6, 0x1F).setReg(11, 0x34).setReg(12, 0x12);
    a.clock(4);
    a.psg.reset();
    expect(a.psg.Noise_Seed).toBe(0x1FFFF);
    expect(a.psg.Noise_Gen.Period).toBe(1);
    expect(a.psg.Envelope_Gen.Envelope_Period).toBe(1);
    expect(a.psg.Envelope_Gen.Counter_Val).toBe(0);
  });

  it('ne remet PAS le bit de sortie du bruit à zéro', () => {
    // Régression : `Noise_Gen.Noise_Output_Bit` et `Counter_Val` ne sont
    // écrits par aucun registre, ils doivent être reposés explicitement.
    const a = new TestPsg();
    a.setReg(6, 0x01);
    a.clock(2);
    expect(a.psg.Noise_Gen.Noise_Output_Bit).toBe(1);
    expect(a.psg.Noise_Gen.Counter_Val).toBe(0);
    a.clock();
    expect(a.psg.Noise_Gen.Counter_Val).toBe(1);
    a.psg.reset();
    expect(a.psg.Noise_Gen.Noise_Output_Bit).toBe(0);
    expect(a.psg.Noise_Gen.Counter_Val).toBe(0);
  });
});

describe('PSG — repli `_bus` de link()', () => {
  it('installe des accesseurs depuis `_bus` quand le bus est incomplet', () => {
    const a = new TestPsg();
    const psg = a.psg;
    let lecturesClavier = 0;
    psg._bus = {
      ppiPortC: 0x80,
      readKeyboardRow: () => { lecturesClavier++; return 0x3C; },
    };
    psg._getPpiPortC = null;
    psg._readKeyboardRow = null;
    psg.link({});

    expect(psg._getPpiPortC()).toBe(0x80);
    // Régression : le repli s'appelait lui-même et provocait un RangeError.
    expect(psg._readKeyboardRow()).toBe(0x3C);
    expect(psg._readKeyboardRow()).toBe(0x3C);
    expect(lecturesClavier).toBe(2);

    // Restaure un câblage sain pour les éventuels tests suivants.
    psg._bus = null;
    psg._getPpiPortC = null;
    psg._readKeyboardRow = null;
    psg.link({ getPpiPortC: () => 0, readKeyboardRow: () => 0xFF });
    a.dispose();
  });
});