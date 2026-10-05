/**
 * @file tests/video/asic-dma.test.mjs
 * @description Tests du contrôleur DMA de l'ASIC CPC+ (ASIC_DMA_Controller).
 *
 * Le contrôleur est piloté par la ligne CRTC : `updateStatus()` une fois par
 * ligne puis exactement six `tick()` (3 fetch + 3 execute). Le test reproduit
 * ce cycle et mesure les divisions de comportement relevées en lecture du code.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { TestAsic } from '../helpers/asic-harness.mjs';

/**
 * Programme une liste d'instructions DMA à partir de `addr`.
 * @param {TestAsic} a
 * @param {number} addr  adresse de départ
 * @param {number[]} mots  instructions 16 bits
 * @returns {number} adresse de la première instruction
 */
function program(a, addr, mots) {
  const debut = addr;
  for (const m of mots) { a.setRamWord(addr, m); addr += 2; }
  return debut;
}

/**
 * Fait tourner un cycle complet : updateStatus + 6 ticks.
 * @param {TestAsic} a
 */
function cycle(a) {
  a.dma.updateStatus();
  for (let i = 0; i < 6; i++) a.dma.tick();
}

/** Opcode 0 : écriture PSG (reg = bits 11-8, valeur = bits 7-0). */
const PSG = (reg, val) => ((reg & 0x0F) << 8) | (val & 0xFF);
/** Opcode 1 : pause de `n` préscaler cycles. */
const PAUSE = (n) => 0x1000 | (n & 0x0FFF);
/** Opcode 2 : boucle, `n` répétitions. */
const LOOP = (n) => 0x2000 | (n & 0x0FFF);
/** Opcode 4 : contrôle de flux. */
const FLOW = (loop, irq, stop) => 0x4000 | (stop ? 0x20 : 0) | (irq ? 0x10 : 0) | (loop ? 0x01 : 0);

describe('ASIC DMA — updateStatus', () => {
  it('rearme le sous-compteur à 0', () => {
    const a = new TestAsic();
    a.dma.init();
    a.dma.subStep = 5;
    a.dma.updateStatus();
    expect(a.dma.subStep).toBe(0);
  });

  it('déverrouille un canal activé sans pause', () => {
    const a = new TestAsic();
    a.dma.init();
    a.dma.statusControl = 0b001;
    a.dma.updateStatus();
    expect(a.dma.channels[0].canExecute).toBe(true);
  });

  it('laisse les canaux désactivés verrouillés même sans pause', () => {
    const a = new TestAsic();
    a.dma.init();
    a.dma.statusControl = 0b100;                 // seul le canal 2 est armé
    a.dma.updateStatus();
    expect(a.dma.channels[0].canExecute).toBe(false);
    expect(a.dma.channels[1].canExecute).toBe(false);
    expect(a.dma.channels[2].canExecute).toBe(true);
  });

  it('décrémente le préscaler pendant la pause, puis la pause elle-même', () => {
    const a = new TestAsic();
    a.dma.init();
    a.dma.statusControl = 0b001;
    const ch = a.dma.channels[0];
    ch.pauseValue = 2;
    ch.prescalerBase = 4;
    ch.prescalerCurrent = 0;

    // Une ligne = un updateStatus. Le préscaler se décompte ligne par ligne ;
    // la pause ne baisse que lorsque le préscaler est vide, et le canal
    // redevient exécutable dès la ligne où pauseValue atteint 0.
    const etats = [];
    for (let ligne = 1; ligne <= 7; ligne++) {
      a.dma.updateStatus();
      etats.push(ch.pauseValue + '/' + ch.prescalerCurrent + '/' + ch.canExecute);
    }
    expect(etats).toEqual([
      '1/4/false',   // préscaler vide : pause-- puis recharge
      '1/3/false',
      '1/2/false',
      '1/1/false',
      '1/0/false',
      '0/4/true',    // pause épuisée : exécutable dès cette ligne
      '0/4/true',
    ]);
  });

  it('ne décompte pas le préscaler d\'un canal désactivé', () => {
    const a = new TestAsic();
    a.dma.init();
    a.dma.statusControl = 0;
    const ch = a.dma.channels[0];
    ch.pauseValue = 5;
    ch.prescalerCurrent = 0;
    a.dma.updateStatus();
    expect(ch.pauseValue).toBe(5);
    expect(ch.prescalerCurrent).toBe(0);
  });
});

describe('ASIC DMA — tick (micro-cycle à 6 sous-pas)', () => {
  it('fetch les canaux 0-2 puis les exécute, dans l\'ordre', () => {
    const a = new TestAsic();
    a.dma.init();
    const base = program(a, 0x1000, [
      PSG(0x01, 0x11), PSG(0x02, 0x22), PSG(0x03, 0x33),
    ]);
    a.dma.channels.forEach((ch, i) => { ch.pointer = base + i * 2; });
    a.dma.statusControl = 0b111;

    a.dma.updateStatus();
    for (let i = 0; i < 6; i++) {
      expect(a.dma.subStep, 'sous-pas ' + i).toBe(i);
      a.dma.tick();
    }
    expect(a.dma.subStep).toBe(6);
    expect(a.psgWrites).toEqual([
      { reg: 0x01, value: 0x11 },
      { reg: 0x02, value: 0x22 },
      { reg: 0x03, value: 0x33 },
    ]);
  });

  it('saute le fetch d\'un canal en pause', () => {
    const a = new TestAsic();
    a.dma.init();
    const base = program(a, 0x2000, [PSG(0x07, 0x77)]);
    a.dma.channels[0].pointer = base;
    a.dma.channels[0].pauseValue = 2;             // canExecute = false sur la ligne
    a.dma.statusControl = 0b001;

    cycle(a);
    expect(a.psgWrites).toHaveLength(0);
    // Le pointeur n'a pas bougé : le fetch a bien été sauté.
    expect(a.dma.channels[0].pointer).toBe(base);
  });

  it('ne boucle pas : le 7e tick est inerte tant que updateStatus n\'est pas appelé', () => {
    const a = new TestAsic();
    a.dma.init();
    const base = program(a, 0x3000, [PSG(0x09, 0x99), PSG(0x09, 0x99)]);
    a.dma.channels[0].pointer = base;
    a.dma.statusControl = 0b001;

    cycle(a);
    a.dma.tick();                                  // sous-pas 6 : rien
    a.dma.tick();                                  // sous-pas 7 : rien
    expect(a.dma.subStep).toBe(8);
    expect(a.psgWrites).toHaveLength(1);           // une seule exécution

    cycle(a);                                      // nouvelle ligne : le fetch repart
    expect(a.psgWrites).toHaveLength(2);
  });
});

describe('ASIC DMA — fetch', () => {
  it('lit un mot 16 bits en little-endian et avance de 2', () => {
    const a = new TestAsic();
    a.dma.init();
    a.setRamWord(0x4000, 0xBEEF);
    a.dma.channels[0].pointer = 0x4000;
    a.dma.channels[0].canExecute = true;

    a.dma.fetch(0);
    expect(a.dma.channels[0].instruction).toBe(0xBEEF);
    expect(a.dma.channels[0].pointer).toBe(0x4002);
  });

  it('boucle sur 64 Ko', () => {
    const a = new TestAsic();
    a.dma.init();
    a.setRamWord(0xFFFE, 0x1234);
    a.dma.channels[2].pointer = 0xFFFE;
    a.dma.channels[2].canExecute = true;

    a.dma.fetch(2);
    expect(a.dma.channels[2].instruction).toBe(0x1234);
    expect(a.dma.channels[2].pointer).toBe(0x0000);
  });
});

describe('ASIC DMA — execute', () => {
  /**
   * Programme une instruction et la charge dans le canal 0
   * (fetch + canExecute), comme le ferait un cycle DMA complet.
   * @param {TestAsic} a
   * @param {number} mot
   * @returns {number} adresse de l'instruction
   */
  function ch0(a, mot) {
    a.dma.init();
    const base = program(a, 0x5000, [mot]);
    a.dma.channels[0].pointer = base;
    a.dma.channels[0].canExecute = true;
    a.dma.fetch(0);
    return base;
  }

  it('opcode 0 : écrit un registre PSG', () => {
    const a = new TestAsic();
    ch0(a, PSG(0x0F, 0xC3));
    a.dma.execute(0);
    expect(a.psgWrites).toEqual([{ reg: 0x0F, value: 0xC3 }]);
  });

  it('opcode 0 : sépare registre (bits 11-8) et valeur (bits 7-0)', () => {
    // Le champ registre ne peut pas dépasser 4 bits : les bits 15-12 portent
    // l'opcode, il n'y a donc pas de masque supplémentaire à vérifier.
    const a = new TestAsic();
    ch0(a, PSG(0x00, 0x00));
    a.dma.channels[0].instruction = 0x0ABC;
    a.dma.execute(0);
    expect(a.psgWrites).toEqual([{ reg: 0x0A, value: 0xBC }]);
  });

  it('opcode 1 : charge la pause et recharge le préscaler', () => {
    const a = new TestAsic();
    ch0(a, PAUSE(0x123));
    a.dma.channels[0].prescalerBase = 9;
    a.dma.channels[0].prescalerCurrent = 2;
    a.dma.execute(0);
    expect(a.dma.channels[0].pauseValue).toBe(0x123);
    expect(a.dma.channels[0].prescalerCurrent).toBe(9);
  });

  it('opcode 2 : mémorise la boucle APRÈS l\'avance du pointeur', () => {
    const a = new TestAsic();
    const base = ch0(a, LOOP(5));
    a.dma.execute(0);
    expect(a.dma.channels[0].loopStart).toBe(base + 2);
    expect(a.dma.channels[0].loopCount).toBe(5);
  });

  it('opcode 4 : sans drapeau, ne fait rien', () => {
    const a = new TestAsic();
    const base = ch0(a, FLOW(false, false, false));
    a.dma.execute(0);
    expect(a.dma.channels[0].pointer).toBe(base + 2);
    expect(a.dma.statusControl).toBe(0);
    expect(a.gaIntStatus).toBe(0);
  });

  it('opcode 4 : boucle arrière tant que le compteur est non nul', () => {
    const a = new TestAsic();
    const base = ch0(a, LOOP(2));
    a.dma.execute(0);                               // pose la boucle
    a.dma.channels[0].instruction = FLOW(true, false, false);
    a.dma.channels[0].pointer = 0x9000;

    a.dma.execute(0);
    expect(a.dma.channels[0].loopCount).toBe(1);
    expect(a.dma.channels[0].pointer).toBe(base + 2);

    a.dma.channels[0].instruction = FLOW(true, false, false);
    a.dma.execute(0);
    expect(a.dma.channels[0].loopCount).toBe(0);
    expect(a.dma.channels[0].pointer).toBe(base + 2);

    // Compteur à 0 : le pointeur n'est plus rembobiné.
    a.dma.channels[0].pointer = 0x9000;
    a.dma.execute(0);
    expect(a.dma.channels[0].pointer).toBe(0x9000);
  });

  it('opcode 4 : lève l\'interruption du canal sur le bit 6 - chId', () => {
    const a = new TestAsic();
    for (const [chId, bit] of [[0, 0x40], [1, 0x20], [2, 0x10]]) {
      const b = new TestAsic();
      b.dma.init();
      b.dma.channels[chId].canExecute = true;
      b.dma.channels[chId].instruction = FLOW(false, true, false);
      b.dma.execute(chId);
      expect(b.dma.statusControl, 'canal ' + chId).toBe(bit);
      expect(b.gaIntStatus, 'canal ' + chId).toBe(bit);
      b.dispose();
    }
  });

  it('opcode 4 : arrête le canal (bit 5), qui devient non exécutable', () => {
    const a = new TestAsic();
    ch0(a, FLOW(false, false, true));
    a.dma.statusControl = 0b111;
    a.dma.execute(0);
    expect(a.dma.statusControl & 0b001).toBe(0);
    expect(a.dma.statusControl & 0b110).toBe(0b110);   // canaux 1-2 intacts
    a.dma.updateStatus();
    expect(a.dma.channels[0].canExecute).toBe(false);
  });

  it('opcode 4 : n\'examine que les bits 0, 4 et 5', () => {
    // 0x02 n'est pas un drapeau reconnu : le masque 0x31 le fait disparaître.
    const a = new TestAsic();
    ch0(a, 0x4002);
    a.dma.statusControl = 0b111;
    a.dma.channels[0].instruction = 0x4002;
    a.dma.execute(0);
    expect(a.dma.statusControl).toBe(0b111);
    expect(a.gaIntStatus).toBe(0);
  });

  it('opcode 4 : combine boucle, IRQ et arrêt dans l\'ordre', () => {
    const a = new TestAsic();
    const base = ch0(a, LOOP(1));
    a.dma.execute(0);
    a.dma.channels[0].pointer = 0x9000;
    a.dma.channels[0].instruction = FLOW(true, true, true);
    a.dma.statusControl = 0b001;
    a.dma.execute(0);
    expect(a.dma.channels[0].loopCount).toBe(0);
    expect(a.dma.channels[0].pointer).toBe(base + 2);
    expect(a.gaIntStatus).toBe(0x40);
    expect(a.dma.statusControl).toBe(0x40);       // IRQ levée puis canal arrêté
  });

  it('opcodes invalides (3, 5, 6, 7) : journalisé, aucun effet', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (const opcode of [3, 5, 6, 7]) {
        const a = new TestAsic();
        a.dma.init();
        a.tstates = 0x1234;
        const ch = a.dma.channels[0];
        ch.canExecute = true;
        ch.pointer = 0x8000;
        ch.instruction = (opcode << 12) | 0xABCD;
        const avant = JSON.stringify(ch);
        a.dma.execute(0);
        expect(spy, 'opcode ' + opcode).toHaveBeenCalled();
        const attendu = '0x' + ((opcode << 12) | 0xABCD).toString(16);
        const dernier = spy.mock.calls[spy.mock.calls.length - 1][0];
        expect(dernier).toContain(attendu);
        expect(JSON.stringify(a.dma.channels[0])).toBe(avant);
        a.dispose();
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe('ASIC DMA — accès par la fenêtre de registres', () => {
  it('un canal se pilote entièrement par écritures CPU', () => {
    const a = new TestAsic();
    a.dma.init();
    a.asic.write(0x2C00, 0x00);          // pointeur bas
    a.asic.write(0x2C01, 0x20);          // pointeur haut  -> 0x2000
    a.asic.write(0x2C02, 0x05);          // préscaler
    a.asic.write(0x2C0F, 0x01);          // armement du canal 0

    const ch = a.dma.channels[0];
    expect(ch.pointer).toBe(0x2000);
    expect(ch.prescalerBase).toBe(0x05);
    expect(ch.prescalerBase).toBe(a.asic.read(0x2C02));

    a.setRamWord(0x2000, PSG(0x06, 0x5A));
    cycle(a);
    expect(a.psgWrites).toEqual([{ reg: 0x06, value: 0x5A }]);
  });

  it('la lecture du statut reflète l\'écriture CPU', () => {
    const a = new TestAsic();
    a.dma.init();
    a.asic.write(0x2C0F, 0x3F);
    expect(a.asic.read(0x2C0F)).toBe(0x3F);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});