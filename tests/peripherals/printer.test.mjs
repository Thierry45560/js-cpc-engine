/**
 * @file tests/peripherals/printer.test.mjs
 * @description Imprimante virtuelle : décodage du port parallèle et rendu DOM.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI CES TESTS EXISTENT
 * ─────────────────────────────────────────────────────────────────────────────
 * L'imprimante n'était couverte par aucun test, alors que son interface est
 * entièrement liée au DOM : une régression s'y manifeste par un panneau vide,
 * sans erreur console, donc sans rien qui attire l'attention.
 *
 * Deux invariants sont verrouillés ici :
 *
 *   1. Le port est décodé sur A12 = 0, et non sur l'espace d'adresses que
 *      l'on croirait intuitif. C'est la condition pour que LPRINT atteigne
 *      jamais `printLine()` : un décode faux donne une imprimante muette.
 *
 *   2. « Vider » efface le listing mais ne referme pas la carte. Refermer la
 *      carte faisait disparaître le périphérique sans aucun moyen de le
 *      récupérer, ce qui se lisait comme un port débranché.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { imprimantePret, ecrirePort } from '../helpers/printer-harness.mjs';

describe('VirtualPrinter — port parallèle', () => {
  let ctx;

  afterEach(() => { if (ctx) ctx.restaure(); });

  it('accepte les écritures sur A12 = 0', () => {
    // A12 = 0 est le décodage matériel du port parallèle sur CPC. Le test
    // verrouille ce bit précis : le changer casse LPRINT sans lever d'erreur.
    ctx = imprimantePret();
    ecrirePort(ctx.printer, 'A', 0x4000);
    ctx.printer.writePort(0x4000, 0x80 | 13);   // CR : vide la ligne
    expect(ctx.dom.lignes).toHaveLength(1);
    expect(ctx.dom.lignes[0].textContent).toBe('A');
  });

  it('ignore les écritures quand A12 est à 1', () => {
    // L'espace A12 = 1 appartient à d'autres périphériques : l'imprimante ne
    // doit pas capter leur trafic.
    ctx = imprimantePret();
    ecrirePort(ctx.printer, 'HELLO', 0x5000);
    ctx.printer.writePort(0x5000, 0x80 | 13);
    expect(ctx.dom.lignes).toHaveLength(0);
  });

  it('n\'imprime chaque caractère qu\'une fois', () => {
    // Le firmware émet deux écritures par caractère : passe strobe haute puis
    // passe strobe basse. Ne traiter que la première évite le doublon.
    ctx = imprimantePret();
    for (const passe of [0x80 | 65, 65]) {   // 'A' strobe haute, puis basse
      ctx.printer.writePort(0x4000, passe);
    }
    ctx.printer.writePort(0x4000, 0x80 | 13);
    expect(ctx.dom.lignes[0].textContent).toBe('A');
  });

  it('accumule la ligne jusqu\'au retour chariot', () => {
    ctx = imprimantePret();
    ecrirePort(ctx.printer, 'RUN"MONJEU');
    // Tant que CR n'est pas venu, rien n'est imprimé.
    expect(ctx.dom.lignes).toHaveLength(0);

    ctx.printer.writePort(0x4000, 0x80 | 13);
    expect(ctx.dom.lignes).toHaveLength(1);
    expect(ctx.dom.lignes[0].textContent).toBe('RUN"MONJEU');
    expect(ctx.printer.buffer).toBe('');
  });

  it('traduit les caractères propres au jeu CPC', () => {
    // Au-dessus du code 64, le jeu du CPC diverge de l'ASCII : sans cette
    // table, une adresse accentuée sort en caractère Latin-1 arbitraire.
    // La table est celle du projet, orientée jeu français.
    ctx = imprimantePret();
    ctx.printer.writePort(0x4000, 0x80 | 64);   // 64 -> @
    ctx.printer.writePort(0x4000, 0x80 | 92);   // 92 -> \
    ctx.printer.writePort(0x4000, 0x80 | 123);  // 123 -> {
    ctx.printer.writePort(0x4000, 0x80 | 13);
    expect(ctx.dom.lignes[0].textContent).toBe('àçé');
  });

  it('jette les caractères de contrôle', () => {
    ctx = imprimantePret();
    ctx.printer.writePort(0x4000, 0x80 | 7);    // BEL
    ctx.printer.writePort(0x4000, 0x80 | 12);   // FF
    ecrirePort(ctx.printer, 'OK');
    ctx.printer.writePort(0x4000, 0x80 | 13);
    expect(ctx.dom.lignes[0].textContent).toBe('OK');
  });

  it('annonce une imprimante prête', () => {
    // Bit 6 du port B du PPI à 0 : le firmware doit croire l'imprimante
    // disponible, sinon il se met en attente avant d'écrire quoi que ce soit.
    ctx = imprimantePret();
    expect(ctx.printer.readPort(0x4000)).toBe(0);
  });
});

describe('VirtualPrinter — panneau', () => {
  let ctx;

  afterEach(() => { if (ctx) ctx.restaure(); });

  it('affiche un état d\'attente tant que rien n\'est imprimé', () => {
    // Une zone totalement vide ne distingue pas « pas encore imprimée » de
    // « port non câblé ». L'état d'attente lève l'ambiguïté.
    ctx = imprimantePret();
    ctx.printer.init();
    expect(ctx.dom.sortie._idle).not.toBeNull();
    expect(ctx.dom.sortie._idle.textContent).toMatch(/attente/i);
  });

  it('remplace l\'état d\'attente dès la première impression', () => {
    ctx = imprimantePret();
    ctx.printer.init();
    ecrirePort(ctx.printer, 'BONJOUR');
    ctx.printer.writePort(0x4000, 0x80 | 13);
    expect(ctx.dom.sortie._idle).toBeNull();
    expect(ctx.dom.lignes).toHaveLength(1);
  });

  it('« Vider » efface le contenu sans refermer la carte', () => {
    // Refermer la carte faisait disparaître le périphérique, sans aucun moyen
    // de le récupérer autrement qu'un rechargement de la page.
    ctx = imprimantePret();
    ecrirePort(ctx.printer, 'LIGNE 1');
    ctx.printer.writePort(0x4000, 0x80 | 13);
    expect(ctx.dom.lignes).toHaveLength(1);

    ctx.printer.clear();

    expect(ctx.dom.lignes).toHaveLength(0);
    expect(ctx.printer.buffer).toBe('');
    expect(ctx.dom.card.style.display).toBe('');
  });

  it('retrouve l\'état d\'attente après un vidage', () => {
    ctx = imprimantePret();
    ecrirePort(ctx.printer, 'LIGNE');
    ctx.printer.writePort(0x4000, 0x80 | 13);
    ctx.printer.clear();
    expect(ctx.dom.sortie._idle).not.toBeNull();
  });
});