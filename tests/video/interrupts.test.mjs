/**
 * @file tests/video/interrupts.test.mjs
 * @description Génération et acquittement des interruptions du Gate Array.
 *
 * Couvre :
 *  - le rythme de 52 lignes entre deux interruptions (le « tick » CPC) ;
 *  - le délai de 2 lignes imposé par VSync ;
 *  - `acknowledgeInterrupt` : vecteur 0x38 (IM 1) sur CPC, vecteur ASIC sur CPC+ ;
 *  - le bit 7 de `gaIntStatus` et son effacement par `OUT (0x7Fxx),$xx` ;
 *  - l'arbitrage CPC+ : interruption sur `asicPri` plutôt que sur le compte 52 ;
 *  - le rôle du compteur HSync (reset à front montant, PLL à hsyncCounter 6).
 */

import { describe, it, expect } from 'vitest';
import { TestVideo } from '../helpers/gatearray-harness.mjs';

/**
 * Simule un frame de 312 lignes et renvoie le nombre d'interruptions levées.
 * Le bit 7 de `gaIntStatus` est remis à zéro après chaque comptage pour isoler
 * les fronts.
 * @param {TestVideo} v
 * @param {number} [lines=312]
 * @param {number} [cycles=10] T-states par ligne
 * @returns {number}
 */
function countInterrupts(v, lines = 312, cycles = 10) {
  let n = 0;
  for (let i = 0; i < lines; i++) {
    v.runScanline(cycles);
    if (v.irqPending) n++;
    v.ga.gaIntStatus &= 0x7F;
  }
  return n;
}

describe('Gate Array — rythme des interruptions', () => {
  it('ne lève pas d\'interruption sur les 51 premières lignes', () => {
    const v = new TestVideo();
    v.runFrame(51);
    expect(v.irqPending).toBe(false);
    expect(v.ga.scanlineCounter).toBe(51);
  });

  it('lève l\'interruption à la 52ᵉ ligne', () => {
    const v = new TestVideo();
    v.runFrame(52);
    expect(v.irqPending).toBe(true);
    expect(v.ga.gaIntStatus & 0x80).toBe(0x80);
  });

  it('recompte 52 lignes entre chaque interruption', () => {
    const v = new TestVideo();
    // 312 lignes = 6 interruptions (312 / 52 = 6 exactement).
    expect(countInterrupts(v, 312)).toBe(6);
  });

  it('remet le compteur à zéro après le déclenchement', () => {
    const v = new TestVideo();
    v.runFrame(52);
    expect(v.ga.scanlineCounter).toBe(0);
  });

  it('ne dépend pas du nombre de T-states par ligne', () => {
    // Le rythme est en *lignes*, pas en T-states : c'est le CRTC qui cadence.
    // Les deux instances sont construites et utilisées l'une après l'autre :
    // les singletons du moteur ne peuvent pas être câblés en parallèle.
    const court = new TestVideo();
    const vCourt = countInterrupts(court, 312, 4);

    const long = new TestVideo();
    const vLong = countInterrupts(long, 312, 40);

    expect(vCourt).toBe(6);
    expect(vLong).toBe(6);
  });

  it('détecte qu\'une instance a été supplantée', () => {
    // Garde-fou du harnais : une instance périmée qui lit un singleton doit
    // échouer bruyamment, sinon elle lirait les maquettes de l'autre instance
    // et renverrait des zéros silencieux — un test vert et faux.
    const premier = new TestVideo();
    const second  = new TestVideo();   // périme `premier`

    expect(() => premier.ga).toThrow(/périmée/);
    expect(second.ga).toBeDefined();
  });

  it('s\'arrête après 52 lignes si le compteur est réarmé au départ', () => {
    const v = new TestVideo();
    v.ga.scanlineCounter = 0;
    v.ga.gaIntStatus = 0;
    v.runScanline();
    expect(v.ga.scanlineCounter).toBe(1);
  });
});

describe('Gate Array — délai VSync', () => {
  it('programme un retard de 2 lignes à la fronts montant de VSync', () => {
    const v = new TestVideo();
    v.setVsync(true);
    expect(v.ga.interruptDelay).toBe(2);
  });

  it('consomme une ligne de retard par front descendant', () => {
    const v = new TestVideo();
    v.setVsync(true);
    v.runScanline();
    expect(v.ga.interruptDelay).toBe(1);
    v.runScanline();
    expect(v.ga.interruptDelay).toBe(0);
  });

  it('ne déclenche l\'interruption qu\'au second front si le compte est bas', () => {
    const v = new TestVideo();
    v.ga.scanlineCounter = 0;
    v.setVsync(true);

    v.runScanline();   // compteur 1, retard 2 → 1
    v.runScanline();   // compteur 2, retard 1 → 0 → compteur remis à 0
    expect(v.irqPending).toBe(false);
    expect(v.ga.scanlineCounter).toBe(0);
  });

  it('déclenche sans attendre la 52ᵉ ligne si le compte dépasse 31', () => {
    const v = new TestVideo();
    v.ga.scanlineCounter = 35;
    v.setVsync(true);

    v.runScanline();   // compteur 36, retard 2 → 1
    expect(v.irqPending).toBe(false);
    v.runScanline();   // compteur 37, retard 1 → 0, 37 > 31 → IRQ
    expect(v.irqPending).toBe(true);
  });

  it('ne déclenche pas si le compte est exactement 31', () => {
    const v = new TestVideo();
    v.ga.scanlineCounter = 30;
    v.setVsync(true);
    v.runScanline();   // 31
    v.runScanline();   // 32, 32 > 31 → IRQ
    expect(v.irqPending).toBe(true);
  });

  it('reprend le compte normal après le retard VSync', () => {
    const v = new TestVideo();
    v.ga.scanlineCounter = 0;
    v.setVsync(true);
    v.runScanline();
    v.runScanline();   // retard consommé, compteur remis à 0
    v.setVsync(false);

    v.runFrame(52);
    expect(v.irqPending).toBe(true);
  });

  it('ne réarme le retard que sur un front, pas en niveau haut', () => {
    const v = new TestVideo();
    v.setVsync(true);
    v.setVsync(true);
    v.setVsync(true);
    expect(v.ga.interruptDelay).toBe(2);
  });
});

describe('Gate Array — acknowledgeInterrupt sur CPC', () => {
  it('renvoie 0xFF, donc RST $38 en IM 1', () => {
    const v = new TestVideo();
    v.runFrame(52);
    expect(v.ga.acknowledgeInterrupt()).toBe(0xFF);
  });

  it('efface le bit 7 après acquittement', () => {
    const v = new TestVideo();
    v.runFrame(52);
    v.ga.acknowledgeInterrupt();
    expect(v.ga.gaIntStatus & 0x80).toBe(0);
  });

  it('masque le compteur de lignes modulo 32', () => {
    const v = new TestVideo();
    v.ga.scanlineCounter = 40;
    v.ga.acknowledgeInterrupt();
    expect(v.ga.scanlineCounter).toBe(8);
  });

  it('laisse le compteur tel quel quand il est déjà sous 32', () => {
    const v = new TestVideo();
    v.ga.scanlineCounter = 20;
    v.ga.acknowledgeInterrupt();
    expect(v.ga.scanlineCounter).toBe(20);
  });

  it('ne lève pas le bit DMA sur un CPC classique', () => {
    const v = new TestVideo();
    v.ga.acknowledgeInterrupt();
    expect(v.asic.statusControl & 0x80).toBe(0);
  });
});

describe('Gate Array — acquittement et vecteur ASIC (CPC+)', () => {
  it('combine le vecteur ASIC avec l\'offset 6 pour le bit 7', () => {
    const v = new TestVideo({ machineType: 4 });
    v.asic.ivr = 0x40;
    v.ga.gaIntStatus = 0x80;
    expect(v.ga.acknowledgeInterrupt()).toBe(0x46);
  });

  it('respecte les trois bits hauts du vecteur ASIC', () => {
    const v = new TestVideo({ machineType: 4 });
    v.asic.ivr = 0xF8;
    v.ga.gaIntStatus = 0x80;
    expect(v.ga.acknowledgeInterrupt()).toBe(0xFE);
  });

  it('renvoie un vecteur nul si l\'IVR est nul', () => {
    const v = new TestVideo({ machineType: 4 });
    v.asic.ivr = 0x00;
    v.ga.gaIntStatus = 0x80;
    expect(v.ga.acknowledgeInterrupt()).toBe(0x06);
  });

  it('positionne le bit DMA à l\'acquittement du bit 7', () => {
    const v = new TestVideo({ machineType: 4 });
    v.asic.statusControl = 0x00;
    v.ga.gaIntStatus = 0x80;
    v.ga.acknowledgeInterrupt();
    expect(v.asic.statusControl & 0x80).toBe(0x80);
  });

  it('efface le bit DMA correspondant au bit acquitté, pas le bit 7', () => {
    const v = new TestVideo({ machineType: 4 });
    v.asic.statusControl = 0x90;   // bits 7 et 4
    v.ga.gaIntStatus = 0x10;       // seul le bit 4 est acquitté
    v.ga.acknowledgeInterrupt();
    // Le cœur fait un `& 0xEF` : c'est le bit 4 du registre DMA qui tombe,
    // le bit 7 reste. C'est le comportement réel, pas une approximation.
    expect(v.asic.statusControl & 0x10).toBe(0);
    expect(v.asic.statusControl & 0x80).toBe(0x80);
  });

  it('traite les bits 6, 5 et 4 par ordre de priorité', () => {
    const v = new TestVideo({ machineType: 4 });
    v.asic.ivr = 0x00;

    v.ga.gaIntStatus = 0x40;                 // bit 6 seul
    expect(v.ga.acknowledgeInterrupt()).toBe(0x04);

    v.ga.gaIntStatus = 0x20;                 // bit 5
    expect(v.ga.acknowledgeInterrupt()).toBe(0x02);

    v.ga.gaIntStatus = 0x10;                 // bit 4
    expect(v.ga.acknowledgeInterrupt()).toBe(0x00);
  });

  it('privilégie le bit 7 quand plusieurs sont levés', () => {
    const v = new TestVideo({ machineType: 4 });
    v.asic.ivr = 0x00;
    v.ga.gaIntStatus = 0x80 | 0x40 | 0x20 | 0x10;
    expect(v.ga.acknowledgeInterrupt()).toBe(0x06);
    // Les bits 6, 5 et 4 survivent à l'acquittement du bit 7.
    expect(v.ga.gaIntStatus).toBe(0x70);
  });

  it('n\'efface que le bit acquitté', () => {
    const v = new TestVideo({ machineType: 4 });
    v.ga.gaIntStatus = 0x80 | 0x40;
    v.ga.acknowledgeInterrupt();
    expect(v.ga.gaIntStatus & 0x80).toBe(0);
    expect(v.ga.gaIntStatus & 0x40).toBe(0x40);
  });

  it('renvoie 0xFF sur CPC même avec des bits ASIC levés', () => {
    const v = new TestVideo({ machineType: 2 });
    v.asic.ivr = 0x40;
    v.ga.gaIntStatus = 0x40;
    expect(v.ga.acknowledgeInterrupt()).toBe(0xFF);
  });
});

describe('Gate Array — réarmement par écriture de port', () => {
  // ⚠ L'octet de config ROM est un `1 0 x x x x x x` en bits 7:5 — c'est le
  // cas 4/5 du décodeur de `writePort`. Le bit 4 doit rester dans cette plage
  // pour armar le réarmement : $90, et non $50 (qui serait une écriture de
  // couleur, bits 7:5 = 010).
  const ROM_CONFIG_RESET = 0x90;

  it('efface l\'interruption pendante avec un octet de config ROM à bit 4', () => {
    const v = new TestVideo();
    v.runFrame(52);
    expect(v.irqPending).toBe(true);

    v.gaOut(0x7F00, ROM_CONFIG_RESET);

    expect(v.ga.gaIntStatus & 0x80).toBe(0);
  });

  it('remet aussi le compteur de lignes à zéro', () => {
    const v = new TestVideo();
    v.ga.scanlineCounter = 30;
    v.gaOut(0x7F00, ROM_CONFIG_RESET);
    expect(v.ga.scanlineCounter).toBe(0);
  });

  it('laisse l\'interruption en place si le bit 4 n\'est pas levé', () => {
    const v = new TestVideo();
    v.runFrame(52);
    v.gaOut(0x7F00, 0x80);   // bit 4 à 0
    expect(v.ga.gaIntStatus & 0x80).toBe(0x80);
  });

  it('n\'arme le réarmement que sur un octet de config ROM', () => {
    // $50 a bien le bit 4, mais ses bits 7:5 valent 010 : c'est une écriture
    // de couleur. Elle ne doit toucher ni à l'IRQ ni au compteur de lignes.
    const v = new TestVideo();
    v.runFrame(52);
    v.gaOut(0x7F00, 0x50);
    expect(v.ga.gaIntStatus & 0x80).toBe(0x80);
  });

  it('provoque bien un nouveau cycle de 52 lignes après réarmement', () => {
    const v = new TestVideo();
    v.runFrame(52);
    v.gaOut(0x7F00, ROM_CONFIG_RESET);

    v.runFrame(51);
    expect(v.irqPending).toBe(false);
    v.runScanline();
    expect(v.irqPending).toBe(true);
  });
});

describe('Gate Array — compteur HSync et PLL', () => {
  it('remet le compteur HSync à zéro au front montant', () => {
    const v = new TestVideo();
    v.ga.hsyncCounter = 17;
    v.crtc.hsyncActive = true;
    v.ga.checkInterrupts();
    expect(v.ga.hsyncCounter).toBe(0);
  });

  it('incrémente le compteur à chaque T-state de HSync', () => {
    const v = new TestVideo();
    v.runScanline(5);
    // Le front montant remet le compteur à 0, puis 5 T-states l'incrémentent,
    // et le front descendant passe une fois de plus dans le bloc HSync avant
    // que la détection de front ne s'exécute : 0 + 5 + 1 = 6.
    expect(v.ga.hsyncCounter).toBe(6);
  });

  it('déclenche la mise à jour de la PLL à hsyncCounter 6', () => {
    const v = new TestVideo();
    v.display.adjustPLL = 0;
    v.runScanline(6);
    expect(v.display.adjustPLL).toBeGreaterThanOrEqual(1);
  });

  it('applique le mode vidéo quand la PLL est ajustée', () => {
    const v = new TestVideo();
    v.ga.romConfig = 1;
    v.clearLogs();
    v.ga.updatePll();
    expect(v.ga.currentLut).toBe(v.ga.lutMode1);
    expect(v.renderModes).toContain(1);
  });

  it('synchronise la phase PLL au front montant de HSync', () => {
    const v = new TestVideo();
    v.display.syncPhase = 0;
    v.crtc.hsyncActive = true;
    v.ga.checkInterrupts();
    expect(v.display.syncPhase).toBe(1);
  });

  it('ne déclenche pas le DMA ASIC à hsyncCounter 2 sur un CPC', () => {
    const v = new TestVideo({ machineType: 2 });
    v.runScanline(4);
    expect(v.asic.dmaUpdate).toBe(0);
  });

  it('déclenche le DMA ASIC à hsyncCounter 2 sur un CPC+', () => {
    const v = new TestVideo({ machineType: 4 });
    v.runScanline(4);
    expect(v.asic.dmaUpdate).toBe(1);
  });
});

describe('Gate Array — arbitrage ASIC (CPC+)', () => {
  // ⚠ ORDRE DES BLOCS, à connaître pour écrire un test correct.
  // Dans `checkInterrupts`, le bloc « HSync actif » (qui porte l'arbitrage
  // asicPri) lit `this.hsyncActive`, le CACHE, alors que le cache n'est mis à
  // jour qu'en fin de fonction par la détection de front. Au tout premier
  // T-state de HSync, le cache vaut donc encore `false` : l'arbitrage ASIC est
  // évalué à partir du T-state *suivant*.
  //
  // Ce n'est pas une approximation de test : c'est l'ordre réel du cœur. Un
  // logiciel qui n'appellerait `checkInterrupts` qu'une fois par front
  // manquerait donc l'interruption ASIC.

  /** Place le cache HSync du Gate Array, sans déclencher de front. */
  function primeHsync(v) {
    v.crtc.hsyncActive = true;
    v.ga.hsyncActive = true;
    v.ga.hsyncCounter = 0;
  }

  it('déclenche l\'interruption quand la ligne CRTC atteint asicPri', () => {
    const v = new TestVideo({ machineType: 4 });
    v.asic.pri = 0x2A;           // (vcc << 3) | vlcCrtc = 40 | 2 = 42
    v.crtc.vcc = 5;
    v.crtc.vlcCrtc = 2;
    primeHsync(v);

    v.ga.checkInterrupts();

    expect(v.irqPending).toBe(true);
    expect(v.ga.vsyncTriggered).toBe(true);
  });

  it('évalue l\'arbitrage à partir du T-state suivant le front', () => {
    // Illustration de l'ordre des blocs : un seul appel immédiatement après le
    // front ne suffit pas, le cache n'est pas encore à jour.
    const v = new TestVideo({ machineType: 4 });
    v.asic.pri = 0x2A;
    v.crtc.vcc = 5;
    v.crtc.vlcCrtc = 2;
    v.crtc.hsyncActive = true;   // cache encore à false

    v.ga.checkInterrupts();
    expect(v.irqPending).toBe(false);

    v.ga.checkInterrupts();      // cache désormais à true
    expect(v.irqPending).toBe(true);
  });

  it('ne déclenche rien si la ligne CRTC ne correspond pas', () => {
    const v = new TestVideo({ machineType: 4 });
    v.asic.pri = 0x2A;
    v.crtc.vcc = 5;
    v.crtc.vlcCrtc = 0;
    primeHsync(v);

    v.ga.checkInterrupts();

    expect(v.irqPending).toBe(false);
    expect(v.ga.vsyncTriggered).toBe(false);
  });

  it('ne déclenche l\'ASIC qu\'une fois par ligne (indicateur vsyncTriggered)', () => {
    const v = new TestVideo({ machineType: 4 });
    v.asic.pri = 0x2A;
    v.crtc.vcc = 5;
    v.crtc.vlcCrtc = 2;
    primeHsync(v);

    v.ga.checkInterrupts();
    v.ga.gaIntStatus &= 0x7F;     // on simule l'acquittement
    v.ga.checkInterrupts();

    // La seconde passe ne doit pas relever une seconde fois.
    expect(v.irqPending).toBe(false);
  });

  it('supprime le compte de 52 lignes quand asicPri est actif', () => {
    const v = new TestVideo({ machineType: 4 });
    v.asic.pri = 0x2A;           // asicPri non nul → le compte 52 est inhibé
    v.runFrame(104);
    expect(v.irqPending).toBe(false);
  });

  it('conserve le compte de 52 lignes quand asicPri est nul', () => {
    const v = new TestVideo({ machineType: 4 });
    v.asic.pri = 0;
    v.runFrame(52);
    expect(v.irqPending).toBe(true);
  });
});
