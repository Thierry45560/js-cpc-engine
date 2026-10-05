/**
 * @file tests/peripherals/keyboard.test.mjs
 * @description Clavier CPC : table `code` → matrice, modificateurs, relâchement global.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI CES TESTS EXISTENT
 * ─────────────────────────────────────────────────────────────────────────────
 * Le clavier est le seul périphérique dont l'état est maintenu par le
 * navigateur : la matrice est mise à jour par des événements DOM et lue par le
 * firmware, sans qu'aucune boucle ne réconcilie les deux. Un `keyup` perdu —
 * onglet en arrière-plan, Alt-Tab, perte de focus — laisse une touche pressée
 * *définitivement*, et le programme CPC se bloque.
 *
 * La refonte vers `KeyboardEvent.code` et la table `cpc-keyboard-map.js` ajoute
 * deux choses à vérifier :
 *   - que les 3 dispositions pointent sur les bonnes positions CPC ;
 *   - que le relâchement global works, y compris pour les modificateurs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * INSTANTANÉ DE RÉFÉRENCE
 * ─────────────────────────────────────────────────────────────────────────────
 * `cpc-keyboard-map.js` a été produit par script à partir de l'ancienne table
 * `keyCodeMap` : chaque position a donc été confrontée à l'existant, et l'on
 * n'obtient que des écarts voulus. Les tests ci-dessous figent cet
 * instantané — c'est la seule protection contre une inversion silencieuse du
 * type de celle attrapée à la rédaction (AZERTY : le code `KeyZ` tape W sur le
 * CPC, et l'inverse).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { loadKeyboard, clavierPret, evenement } from '../helpers/keyboard-harness.mjs';
import { loadDisplaySyncManager } from '../helpers/display-harness.mjs';

const { CPC_KEYBOARD_MAPS, CPC_KEY_COMMON, CPC_MODIFIER_KEYS, CPC_MODIFIER_NAMES, CPC_LAYOUTS } =
  loadKeyboard();

describe('cpc-keyboard-map — structure de la table', () => {
  it('les dispositions disponibles correspondent aux firmwares livrés', () => {
    expect(Object.keys(CPC_KEYBOARD_MAPS).sort()).toEqual(['ES', 'FR', 'US']);
    expect([...CPC_LAYOUTS].sort()).toEqual(['ES', 'FR', 'US']);
  });

  it('détecte le français et l’espagnol par navigator.language, sinon US', () => {
    const { detectLayoutFromNavigatorLanguage: detect } = loadKeyboard();
    expect(detect('fr-FR')).toBe('FR');
    expect(detect('fr')).toBe('FR');
    expect(detect('es-ES')).toBe('ES');
    expect(detect('de-DE')).toBe('US');
    expect(detect('it-IT')).toBe('US');
    expect(detect('en-GB')).toBe('US');
  });

  it('les tables et classes restent confinées à CPC_INPUT sans polluer globalThis', () => {
    const { CPC_INPUT } = loadKeyboard();
    expect(CPC_INPUT.Keyboard.name).toBe('Keyboard');
    expect(CPC_INPUT.InputExpansion.name).toBe('InputExpansion');
    expect(CPC_INPUT.AutoType.name).toBe('AutoType');
    expect(Object.hasOwn(globalThis, 'Keyboard')).toBe(false);
    expect(Object.hasOwn(globalThis, 'InputExpansion')).toBe(false);
    expect(Object.hasOwn(globalThis, 'AutoType')).toBe(false);
  });

  it('InputExpansion reste une classe isolée avec le comportement du port DB9', () => {
    const { CPC_INPUT } = loadKeyboard();
    const expansion = new CPC_INPUT.InputExpansion();
    expansion.writePort(0x0000, 0x80);
    expect(expansion.data).toBe(0);
    expect(expansion.buttonState).toBe(0);
    expansion.writePort(0x1000, 0x00);
    expect(expansion.buttonState).toBe(0);
    expect(expansion.joystick1).toBe(1);
    expect(expansion.joystick2).toBe(0);
  });

  it('chaque position est dans les bornes de la matrice', () => {
    const horsBornes = [];
    for (const [firmware, table] of Object.entries(CPC_KEYBOARD_MAPS)) {
      for (const [code, pos] of Object.entries(table)) {
        if (!Number.isInteger(pos.line) || pos.line < 0 || pos.line > 9) {
          horsBornes.push(`${firmware}.${code}: line=${pos.line}`);
        }
        if (!Number.isInteger(pos.bit) || pos.bit < 0 || pos.bit > 7) {
          horsBornes.push(`${firmware}.${code}: bit=${pos.bit}`);
        }
      }
    }
    expect(horsBornes, horsBornes.join('\n')).toEqual([]);
  });

  it('aucun `code` n\'est assigné à deux positions dans un même firmware', () => {
    // Un objet ne peut pas avoir deux clés identiques, mais un `code` peut
    // pointer deux fois sur la même position par une faute de copie du nom :
    // on vérifie donc l'inverse — qu'aucune position n'est partagée par deux
    // `code` différents dans un firmware, hors cas documentés.
    for (const [firmware, table] of Object.entries(CPC_KEYBOARD_MAPS)) {
      const parPosition = new Map();
      for (const [code, pos] of Object.entries(table)) {
        const cle = `${pos.line}:${pos.bit}`;
        if (!parPosition.has(cle)) parPosition.set(cle, []);
        parPosition.get(cle).push(code);
      }
      // Positions volontairement partagées : le pavé et F1-F10, la touche
      // Home et le point du pavé, et les deux versions de SHIFT/CTRL.
      const attendus = new Set(['0:3', '0:4', '0:5', '0:7', '1:1', '1:2', '1:3', '1:4',
        '1:5', '1:6', '1:7', '2:4', '2:5', '2:7', '3:1', '3:2', '3:6', '4:7', '5:0', '8:6']);
      const inexpliques = [];
      for (const [cle, codes] of parPosition) {
        if (codes.length > 1 && !attendus.has(cle)) {
          inexpliques.push(`${firmware} position ${cle} partagée par ${codes.join(', ')}`);
        }
      }
      expect(inexpliques, inexpliques.join('\n')).toEqual([]);
    }
  });

  it('les trois firmwares partagent le socle commun, et diffèrent sur le reste', () => {
    // Les jeux de touches ne sont PAS identiques. Ces écarts sont fidèlement issus de l'ancienne table ; on les fige donc explicitement plutôt que
    // d'exiger l'égalité — un test vert mais faux ne vaut rien.
    const anglais = new Set(Object.keys(CPC_KEYBOARD_MAPS.US));
    const manque = (f) => [...anglais].filter((k) => !CPC_KEYBOARD_MAPS[f][k]).sort();
    const propre = (f) => Object.keys(CPC_KEYBOARD_MAPS[f]).filter((k) => !anglais.has(k)).sort();

    // L'AZERTY a Backquote, Quote, Slash, Semicolon, Minus, Comma, Backslash,
    // BracketLeft, BracketRight — les caractères spéciaux de la première ligne,
    // extraits de la ROM française (scripts/extract-keytrans.mjs).
    expect(manque('FR')).toEqual([]);
    expect(propre('FR')).toEqual(['AltRight']);
    expect(manque('ES')).toEqual(['Quote']);
    expect(propre('ES')).toEqual([]);

    // La position de Backslash diffère entre QWERTY et AZERTY : c'est un écart
    // volontaire, pas une factorisation oubliée.
    expect(CPC_KEYBOARD_MAPS.US.Backslash).toEqual({ line: 2, bit: 6 });
    expect(CPC_KEYBOARD_MAPS.ES.Backslash).toEqual({ line: 2, bit: 6 });
    expect(CPC_KEYBOARD_MAPS.FR.Backslash).toEqual({ line: 2, bit: 6 });

    // Le socle commun est présent et identique dans les trois.
    for (const [code, pos] of Object.entries(CPC_KEY_COMMON)) {
      for (const f of CPC_LAYOUTS) {
        expect(CPC_KEYBOARD_MAPS[f][code], `${f}.${code}`).toEqual(pos);
      }
    }
  });

  it('les touches communes sont factorisées et non redondantes', () => {
    // Chaque entrée de CPC_KEY_COMMON doit être strictement identique dans les
    // trois firmwares — sinon la factorisation masque une divergence.
    const divergences = [];
    for (const [code, pos] of Object.entries(CPC_KEY_COMMON)) {
      for (const f of CPC_LAYOUTS) {
        if (JSON.stringify(CPC_KEYBOARD_MAPS[f][code]) !== JSON.stringify(pos)) {
          divergences.push(`${f}.${code}`);
        }
      }
    }
    expect(divergences, divergences.join('\n')).toEqual([]);
  });
});

describe('cpc-keyboard-map — dispositions (instantané de référence)', () => {
  it('QWERTY US : les positions attendues', () => {
    const e = CPC_KEYBOARD_MAPS.US;
    expect(e['KeyA']).toEqual({ line: 8, bit: 5 });
    expect(e['KeyQ']).toEqual({ line: 8, bit: 3 });
    expect(e['KeyZ']).toEqual({ line: 8, bit: 7 });
    expect(e['Space']).toEqual({ line: 5, bit: 7 });
    expect(e['Enter']).toEqual({ line: 2, bit: 2 });
    expect(e['Escape']).toEqual({ line: 8, bit: 2 });
    expect(e['Backspace']).toEqual({ line: 9, bit: 7 });
  });

  it('AZERTY français : A↔Q et Z↔W par rapport au QWERTY', () => {
    const fr = CPC_KEYBOARD_MAPS.FR;
    const en = CPC_KEYBOARD_MAPS.US;

    // Sur un AZERTY la touche physique KeyA porte Q, et réciproquement.
    expect(fr['KeyA']).toEqual({ line: 8, bit: 3 });   // position Q
    expect(fr['KeyQ']).toEqual({ line: 8, bit: 5 });   // position A
    // Idem pour Z et W.
    expect(fr['KeyZ']).toEqual({ line: 7, bit: 3 });   // position W
    expect(fr['KeyW']).toEqual({ line: 8, bit: 7 });   // position Z

    // Les positions franchement identiques au QWERTY ne bougent pas.
    for (const code of ['KeyE', 'KeyR', 'Space', 'Enter', 'Digit1']) {
      expect(fr[code], code).toEqual(en[code]);
    }
  });

  it('espagnol : « Ñ » occupe la position de la touche US « ` »', () => {
    expect(CPC_KEYBOARD_MAPS.ES['Backquote']).toEqual({ line: 3, bit: 4 });
    expect(CPC_KEYBOARD_MAPS.US['Backquote']).toEqual({ line: 3, bit: 2 });
  });

  it('les modificateurs sont déclarés à part et couvrent les deux côtés', () => {
    for (const code of ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight']) {
      expect(CPC_MODIFIER_KEYS[code], code).toBeDefined();
      expect(CPC_MODIFIER_NAMES[code], code).toMatch(/^(shift|ctrl)$/);
    }
    // Le CPC n'a qu'une touche SHIFT et une touche CTRL : les deux versions
    // physiques partagent la position.
    expect(CPC_MODIFIER_KEYS.ShiftRight).toEqual(CPC_MODIFIER_KEYS.ShiftLeft);
    expect(CPC_MODIFIER_KEYS.ControlRight).toEqual(CPC_MODIFIER_KEYS.ControlLeft);
    // Et ces positions doivent exister dans la table des touches, y compris
    // les versions droites, absentes des dictionnaires de disposition.
    for (const f of CPC_LAYOUTS) {
      for (const code of ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight']) {
        expect(CPC_KEYBOARD_MAPS[f][code], `${f}.${code}`).toEqual(CPC_MODIFIER_KEYS[code]);
      }
    }
  });
});

describe('AutoType — FIFO synchronisée sur VBL', () => {
  let ctx;

  afterEach(() => { if (ctx) ctx.restaure(); });

  it('expose une table par firmware, extraites des ROM, en coordonnées CPC indexées', () => {
    const { AUTOTYPE_MAPS } = loadKeyboard().CPC_INPUT;

    // Une table par FIRMWARE — UK, FR, ES — et toutes extraites de la table de
    // traduction patchée dans la ROM correspondante (`scripts/extract-keytrans.mjs`).
    // La table suit le firmware CHARGÉ, et non le clavier de l'utilisateur : les
    // deux n'ont aucune raison de coïncider, et taper les positions UK dans une
    // ROM française produisait « RE? » au lieu de « REM ».
    expect(Object.keys(AUTOTYPE_MAPS).sort()).toEqual(["ES", "FR", "US"]);
    const table = AUTOTYPE_MAPS.US;

    // Tout ce qu'on peut taper au clavier doit l'être.
    for (const character of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
      expect(table[character], `'${character}'`).toBeDefined();
    }
    // Les caractères demandés explicitement par la spécification.
    expect(table[' ']).toMatchObject({ line: 5, bit: 7, shift: false });
    expect(table[String.fromCharCode(10)]).toMatchObject({ line: 2, bit: 2, shift: false });
    expect(table[String.fromCharCode(13)]).toMatchObject({ line: 2, bit: 2, shift: false });
    expect(table['|']).toBeDefined();     // barre verticale, très utilisée en RSX
    expect(table['"']).toMatchObject({ line: 8, bit: 1, shift: true });
    expect(table[':']).toMatchObject({ line: 3, bit: 5, shift: false });
    expect(table['@']).toMatchObject({ line: 3, bit: 2, shift: false });
  });

  it('extrait une table par firmware, chacune conforme à sa ROM', () => {
    // Ces positions sont EXTRAITES des firmwares (voir scripts/extract-keytrans.mjs),
    // et non écrites à la main. Les tests les verrouillent afin qu'une retouche
    // manuelle ne puisse pas les faire diverger de la ROM sans que rien ne le
    // remarque — c'est exactement ce qui est arrivé aux tables précédentes.
    const { AUTOTYPE_MAPS } = loadKeyboard().CPC_INPUT;

    // UK : QWERTY. `a` en 8:5, `q` en 8:3, `z` en 8:7, `w` en 7:3.
    expect(AUTOTYPE_MAPS.US.a).toMatchObject({ line: 8, bit: 5, shift: false });
    expect(AUTOTYPE_MAPS.US.q).toMatchObject({ line: 8, bit: 3, shift: false });
    expect(AUTOTYPE_MAPS.US.z).toMatchObject({ line: 8, bit: 7, shift: false });
    expect(AUTOTYPE_MAPS.US.w).toMatchObject({ line: 7, bit: 3, shift: false });

    // FR : AZERTY. L'inversion `a`↔`q` et `z`↔`w` EST la disposition.
    expect(AUTOTYPE_MAPS.FR.a).toMatchObject({ line: 8, bit: 3, shift: false });
    expect(AUTOTYPE_MAPS.FR.q).toMatchObject({ line: 8, bit: 5, shift: false });
    expect(AUTOTYPE_MAPS.FR.z).toMatchObject({ line: 7, bit: 3, shift: false });
    expect(AUTOTYPE_MAPS.FR.w).toMatchObject({ line: 8, bit: 7, shift: false });
    // `m` se trouve en 3:5 en AZERTY, et non en 4:6 comme au UK.
    expect(AUTOTYPE_MAPS.FR.m).toMatchObject({ line: 3, bit: 5, shift: false });

    // ES : QWERTY, comme le UK.
    expect(AUTOTYPE_MAPS.ES.a).toMatchObject({ line: 8, bit: 5, shift: false });
  });

  it('n\'invente aucun caractère accentué, le CPC ne les tape pas au clavier', () => {
    // Fait vérifié sur la ROM française : sa table de traduction NE CONTIENT
    // AUCUN accent. Sur un CPC français, `é` ou `à` s'obtiennent par le mode
    // COPY du générateur, pas au clavier. Les ajouter à la table les taperait
    // approximativement — la faute de frappe que la règle interdit.
    const { AUTOTYPE_MAPS } = loadKeyboard().CPC_INPUT;
    for (const nom of ['US', 'FR', 'ES']) {
      for (const accent of ['é', 'è', 'à', 'ç', 'ù', 'ô', 'û']) {
        expect(AUTOTYPE_MAPS[nom][accent], `${nom} '${accent}'`).toBeUndefined();
      }
    }
  });

  it('place `w`, `x` et `z` hors du pavé directionnel, sur tous les firmwares', () => {
    // La ligne 9 du CPC est le PAVÉ DIRECTIONNEL, et elle duplique `x` et `z`.
    // La garder ferait taper la flèche du haut au lieu de `z` — un défaut
    // silencieux, le caractère paraissant simplement absent.
    const { AUTOTYPE_MAPS } = loadKeyboard().CPC_INPUT;
    for (const nom of ['US', 'FR', 'ES']) {
      for (const lettre of ['w', 'x', 'z']) {
        expect(AUTOTYPE_MAPS[nom][lettre].line, `${nom} '${lettre}'`).toBeLessThanOrEqual(8);
      }
    }
  });

  it('ne stocke que des positions : aucune valeur de caractère, donc aucune ROM', () => {
    const { AUTOTYPE_MAPS } = loadKeyboard().CPC_INPUT;
    const table = AUTOTYPE_MAPS.US;

    // L'invariant central de la spécification : la table associe un caractère à
    // une position, et rien d'autre. Si elle contenait un caractère, elle
    // dépendrait d'une ROM — et le texte tapé dépendrait du firmware chargé.
    for (const [character, descriptor] of Object.entries(table)) {
      expect(Object.keys(descriptor).sort(), `descripteur de '${character}'`)
        .toEqual(['bit', 'ctrl', 'line', 'shift']);
      expect(descriptor.line).toBeGreaterThanOrEqual(0);
      expect(descriptor.line).toBeLessThanOrEqual(8);   // ligne 9 = pavé directionnel
      expect(descriptor.bit).toBeGreaterThanOrEqual(0);
      expect(descriptor.bit).toBeLessThanOrEqual(7);
      expect(typeof descriptor.shift).toBe('boolean');
      expect(typeof descriptor.ctrl).toBe('boolean');
    }
  });

  it('place chaque lettre et chaque chiffre sur la position du UK standard', () => {
    const { AUTOTYPE_MAPS } = loadKeyboard().CPC_INPUT;
    const table = AUTOTYPE_MAPS.US;

    // Ces positions sont celles de la rangée de touches du CPC UK. Les figer
    // ici protège contre une régression silencieuse de la table extraite.
    const attendu = {
      a: [8, 5, false], A: [8, 5, true],
      q: [8, 3, false], Q: [8, 3, true],
      z: [8, 7, false], Z: [8, 7, true],
      x: [7, 7, false], X: [7, 7, true],
      m: [4, 6, false], M: [4, 6, true],
      w: [7, 3, false], W: [7, 3, true],
      1: [8, 0, false], '!': [8, 0, true],
      0: [4, 0, false], ')': [4, 1, true],
      ';': [3, 4, false], ':': [3, 5, false],
      '-': [3, 1, false], '=': [3, 1, true],
      '/': [3, 6, false], '?': [3, 6, true],
    };
    for (const [character, [line, bit, shift]] of Object.entries(attendu)) {
      expect(table[character], `'${character}'`).toMatchObject({ line, bit, shift });
    }
  });

  it('tape `w`, `x` et `z` sur leur vraie rangée, pas sur le pavé directionnel', () => {
    const { AUTOTYPE_MAPS } = loadKeyboard().CPC_INPUT;
    const table = AUTOTYPE_MAPS.US;

    // Régression : la ligne 9 du CPC duplique `X` et `Z` pour le joystick, en
    // 9:4 et 9:5. Lire cette ligne comme source de caractères faisait passer
    // `X` et `Z` par le pavé — dont les 4 premiers bits sont les flèches. La
    // table extraite ignore donc la ligne 9, et les majuscules restent sur leur
    // rangée de lettres.
    for (const character of 'wWxXzZ') {
      expect(table[character].line, `'${character}'`).toBeLessThanOrEqual(8);
    }
    expect(table.X).toMatchObject({ line: 7, bit: 7, shift: true });
    expect(table.Z).toMatchObject({ line: 8, bit: 7, shift: true });
  });

  it('donne le même résultat quelle que soit la disposition du clavier hôte', () => {
    // `AUTOTYPE_MAPS` ne dépend plus du clavier : changer de disposition avec
    // `setLayout()` ne doit rien changer à ce qui est tapé. C'est ce qui rend
    // l'injection indépendante du matériel comme du firmware.
    const { AUTOTYPE_MAPS } = loadKeyboard().CPC_INPUT;
    const attendu = JSON.stringify(AUTOTYPE_MAPS.US);

    for (const layout of ['US', 'FR', 'ES']) {
      ctx = clavierPret(layout);
      expect(JSON.stringify(AUTOTYPE_MAPS.US), `après setLayout('${layout}')`).toBe(attendu);
      ctx.restaure();
      ctx = null;
    }
  });

  it('frappe réellement la lettre demandée, sur chaque firmware', () => {
    // Contrôle de bout en bout : on autotype, on laisse le moteur presser, et on
    // compare la matrice à la position EXTRAITE du firmware correspondant.
    // La table UK ne doit donc pas servir de référence ici : c'est précisément
    // elle qui trompait sur un firmware français.
    for (const layout of ['US', 'FR', 'ES']) {
      for (const lettre of 'azerty') {
        ctx = clavierPret(layout);
        const descripteur = loadKeyboard().CPC_INPUT.AUTOTYPE_MAPS[layout][lettre];

        ctx.kb.autotype(lettre);
        ctx.kb.readAYPort(0);      // le firmware interroge la matrice
        ctx.autoType.tick();
        const attendu = new Uint8Array(10).fill(0xFF);
        attendu[descripteur.line] &= ~(1 << descripteur.bit);
        expect(Array.from(ctx.kb.getMatrix()), `${layout} '${lettre}'`)
          .toEqual(Array.from(attendu));
        ctx.restaure();
        ctx = null;
      }
    }
  });

  it('fait avancer le clavier une fois par frame rendue via le hook Display', () => {
    const display = loadDisplaySyncManager();
    ctx = clavierPret('US');
    display.link({
      display() {},
      setPixelIndex() {},
      onFrame: () => ctx.kb.onFrame(),
    });
    display.reset();
    ctx.kb.autotype('a');

    const frame = () => {
      display.currentLineY = display.VSYNC_MIN_LINES;
      display.vblankCounter = 26;
      display.updateLineOffsets();
    };

    // Le point de cet essai est le CÂBLAGE : c'est bien le hook de fin d'image du
    // Display qui fait avancer la frappe, image après image. Le nombre exact
    // d'images est couvert plus bas ; ici on conduit jusqu'à la fin.
    ctx.kb.readAYPort(8);   // le firmware interroge la matrice
    frame();                 // commence la frappe
    expect(ctx.kb.getMatrix()[8] & (1 << 5)).toBe(0);

    for (let i = 0; i < 10 && ctx.kb.isAutotyping(); i++) {
      ctx.kb.readAYPort(8);
      frame();
    }
    expect(ctx.kb.isAutotyping()).toBe(false);
  });

  it('ajoute chaque appel à la fin de la FIFO', () => {
    ctx = clavierPret('US');
    ctx.kb.typeString('a');
    ctx.kb.typeString('b');
    expect(ctx.autoType.queue).toEqual([
      expect.objectContaining({ line: 8, bit: 5, shift: false }),
      expect.objectContaining({ line: 6, bit: 6, shift: false }),
    ]);
    expect(ctx.kb.isAutotyping()).toBe(true);
  });


  it('enfile sans frappe synchrone, puis attend la lecture du firmware à chaque phase', () => {
    ctx = clavierPret('US');
    ctx.kb.typeString('aA');
    ctx.kb.readAYPort(8);          // le firmware interroge la matrice
    expect(ctx.kb.isAutotyping()).toBe(true);
    // Aucun appui avant le premier tick : l'enfilement ne frappe rien.
    expect(Array.from(ctx.kb.getMatrix())).toEqual(new Array(10).fill(0xFF));

    ctx.autoType.tick(); // première frappe : a
    expect(ctx.kb.getMatrix()[8] & (1 << 5)).toBe(0);
    expect(ctx.kb.getMatrix()[2] & (1 << 5)).not.toBe(0); // SHIFT non requis ici

    // Le firmware doit avoir VU l'appui avant qu'on puisse relâcher.
    ctx.autoType.tick(); // pas encore de lecture : l'appui est maintenu
    expect(ctx.kb.getMatrix()[8] & (1 << 5)).toBe(0);
    ctx.autoType.tick(); // toujours aucune nouvelle lecture : maintenu
    expect(ctx.kb.getMatrix()[8] & (1 << 5)).toBe(0);

    ctx.kb.readAYPort(8);   // le firmware a vu l'appui
    ctx.autoType.tick();    // relâchement effectif
    expect(ctx.kb.getMatrix()[8] & (1 << 5)).not.toBe(0);
    expect(ctx.kb.isAutotyping()).toBe(true);

    // Puis il doit avoir VU le relâchement, et une image de clavier vide
    // s'intercale : c'est ce qui rend les deux frappes distinctes.
    // Le firmware interroge la matrice à chaque image, comme un vrai balayage.
    // On avance jusqu'à ce que la frappe soit terminée, en notant au passage
    // que 'A' a bien été émise AVEC son modificateur SHIFT.
    let aVuShift = false;
    for (let i = 0; i < 40 && ctx.kb.isAutotyping(); i++) {
      ctx.kb.readAYPort(8);
      ctx.autoType.tick();
      const m = ctx.kb.getMatrix();
      if ((m[8] & (1 << 5)) === 0 && (m[2] & (1 << 5)) === 0) aVuShift = true;
    }

    expect(aVuShift).toBe(true);                       // 'A' bien tapée
    expect(ctx.kb.isAutotyping()).toBe(false);         // frappe terminée
    expect(ctx.autoType.queue).toHaveLength(0);
  });

  it('sépare deux frappes identiques par une image de clavier vide', () => {
    // Le cœur du correctif. Deux « R » ne se distinguent QUE si le firmware voit
    // la touche REMONTER entre les deux : sans intervalle vide, il ne voit
    // qu'une touche enfoncée continue et n'enregistre qu'un seul « R ».
    // L'observation se fait ici sur des imagescomplètes, pas sur un compteur.
    ctx = clavierPret('US');
    ctx.kb.typeString('RR');

    const pressed = [];
    for (let i = 0; i < 12 && ctx.kb.isAutotyping(); i++) {
      ctx.kb.readAYPort(i % 10);
      ctx.autoType.tick();
      pressed.push(!(ctx.kb.getMatrix()[6] & (1 << 2)));   // R est en 6:2
    }

    // La séquence doit contenir DEUX fronts montants distincts : deux « R »
    // séparés par au moins une image de clavier vide.
    let fronts = 0;
    for (let i = 0; i < pressed.length; i++) {
      if (pressed[i] && !pressed[i - 1]) fronts++;
    }
    expect(fronts).toBe(2);
    expect(ctx.kb.isAutotyping()).toBe(false);
  });

it('tape chaque caractère même si le firmware n\'interroge qu\'une fois par 20 images', () => {
    // La cadence du CPC n'est pas connue à l'avance. La frappe doit aboutir
    // quelle que soit sa fréquence de balayage — c\'est l\'attente de la LECTURE
    // qui garantit le passage, pas le nombre d\'images.
    for (const periode of [1, 5, 20]) {
      ctx = clavierPret('US');
      ctx.kb.typeString('REM');
      for (let i = 0; i < 2000 && ctx.kb.isAutotyping(); i++) {
        if (i % periode === 0) ctx.kb.readAYPort(i % 10);
        ctx.autoType.tick();
      }
      expect(ctx.kb.isAutotyping(), `période ${periode}`).toBe(false);
      expect(ctx.autoType.queue, `période ${periode}`).toHaveLength(0);
      ctx.restaure();
      ctx = null;
    }
  });

it('ne perd pas la seconde lettre d\'une double lettre', () => {
    // Régression : la porte firmware était consultée au moment de engager le
    // caractère SUIVANT, depuis l'état RELEASE. Si elle refusait, la phase
    // restait RELEASE avec un compteur déjà à zéro : au tick suivant il
    // passait à -1 et la machine se bloquait définitivement. Symptôme : « RR »
    // ne tapait qu'un seul R, « TT » qu'un seul T, et plus rien ensuite.
    ctx = clavierPret('US');
    ctx.kb.typeString('RR');

    // Le firmware interroge la matrice entre chaque image, comme en vrai.
    for (let i = 0; i < 12; i++) {
      ctx.kb.readAYPort(i % 10);
      ctx.autoType.tick();
    }

    expect(ctx.kb.isAutotyping()).toBe(false);   // la file est arrivée au bout
    expect(ctx.autoType.queue).toHaveLength(0);
  });

it('enchaîne une longue suite sans rester bloqué', () => {
  // Un mot entier, avec lettres répétées et chiffres : c'est la frappe réelle
  // (RUN"MONJEU. et assimilés) qui doit se dérouler d'un bout à l'autre.
  ctx = clavierPret('US');
  const texte = 'RUN"MOTTU.BAS';
  ctx.kb.typeString(texte);

  for (let i = 0; i < 400; i++) {
    ctx.kb.readAYPort(i % 10);
    ctx.autoType.tick();
  }

  expect(ctx.kb.isAutotyping()).toBe(false);
  expect(ctx.autoType.queue).toHaveLength(0);
});

it('attend une interrogation du firmware avant de frapper', () => {
    // Le firmware du CPC interroge le clavier en boucle. Injecter sans qu'il
    // écoute revient à jeter le texte : rien n'est tapé tant qu'aucune lecture
    // de la matrice n'a eu lieu. Le texte reste donc en file, intact.
    ctx = clavierPret('US');
    ctx.kb.typeString('a');

    ctx.autoType.tick();
    ctx.autoType.tick();
    ctx.autoType.tick();

    expect(Array.from(ctx.kb.getMatrix())).toEqual(new Array(10).fill(0xFF));
    expect(ctx.autoType.queue).toHaveLength(1);   // le 'a' n'a pas été consommé
    expect(ctx.kb.isAutotyping()).toBe(true);

    // Le firmware lit la matrice : la frappe peut partir.
    ctx.kb.readAYPort(8);
    ctx.autoType.tick();
    expect(ctx.kb.getMatrix()[8] & (1 << 5)).toBe(0);
  });

  it('normalise CRLF en un unique Enter et ignore les caractères hors table', () => {
    ctx = clavierPret('US');
    ctx.kb.typeString(String.fromCharCode(13) + String.fromCharCode(10));
    expect(ctx.kb.isAutotyping()).toBe(true);
    expect(ctx.autoType.queue).toHaveLength(1);
    expect(ctx.autoType.queue[0]).toMatchObject({ line: 2, bit: 2, shift: false });

    // Un caractère absent de la table est ignoré, pas tapé approximativement.
    ctx.kb.cancelAutotype();
    ctx.kb.typeString('a' + String.fromCharCode(0));
    expect(ctx.autoType.queue).toHaveLength(1);
    expect(ctx.autoType.queue[0]).toMatchObject({ line: 8, bit: 5 });
  });

  it('tape le retour à la ligne sur TOUS les firmwares', () => {
    // Régression : seule la table UK portait l'alias `LF` en plus de `CR`.
    // Les tables FR et ES, extraites de la ROM, ne portent que `CR` — le
    // firmware ne code en effet que 0x0D pour ENTER. Or `typeString()`
    // normalise TOUT en `\n` (LF) : sur un firmware français ou espagnol, le
    // retour à la ligne disparaissait donc purement et simplement.
    //
    // C'est le cas le plus fréquent de l'autotype : `RUN"…\n` est une commande
    // BASIC, elle n'exécute rien sans son RETURN.
    for (const layout of ['US', 'FR', 'ES']) {
      for (const nom of ['LF', 'CR', 'CRLF']) {
        ctx = clavierPret(layout);
        const code = { LF: 10, CR: 13, CRLF: 13 }[nom];
        ctx.kb.typeString('a' + String.fromCharCode(code)
                       + (nom === 'CRLF' ? String.fromCharCode(10) : ''));

        // Deux frappes : la lettre, puis ENTER — jamais une, jamais trois.
        expect(ctx.autoType.queue, `${layout} ${nom}`).toHaveLength(2);
        expect(ctx.autoType.queue[1], `${layout} ${nom}`)
          .toMatchObject({ line: 2, bit: 2, shift: false });
        ctx.restaure();
        ctx = null;
      }
    }
  });

  it('associe LF et CR à la MÊME touche ENTER, sur tous les firmwares', () => {
    // Le firmware ne code que 0x0D pour RETURN : les tables extraites ne
    // portent donc que `CR`. LF doit pointer sur ce même descripteur, faute de
    // quoi `RUN"…\n` perdait son retour sur firmware FR et ES.
    const { AUTOTYPE_MAPS } = loadKeyboard().CPC_INPUT;
    const LF = String.fromCharCode(10);
    const CR = String.fromCharCode(13);
    for (const nom of ['US', 'FR', 'ES']) {
      expect(AUTOTYPE_MAPS[nom][LF], `${nom} LF`).toBeDefined();
      // Même touche physique : mêmes ligne, bit et modificateurs.
      expect(AUTOTYPE_MAPS[nom][LF], `${nom} LF`)
        .toEqual(AUTOTYPE_MAPS[nom][CR]);
    }
  });

  it('cancelAutotype vide la queue et relâche immédiatement la matrice', () => {
    ctx = clavierPret('US');
    ctx.kb.keydownEvent(evenement('KeyA'));
    ctx.kb.keydownEvent(evenement('ShiftLeft'));
    ctx.kb.autotype('abc');
    ctx.autoType.onFrame();
    expect(ctx.kb.isAutotyping()).toBe(true);
    ctx.kb.cancelAutotype();
    expect(ctx.kb.isAutotyping()).toBe(false);
    expect(Array.from(ctx.kb.getMatrix())).toEqual(new Array(10).fill(0xFF));
  });
});

describe('Keyboard — événements', () => {
  let ctx;

  afterEach(() => { if (ctx) ctx.restaure(); });

  it('initialise et manipule une matrice active-low de 10 octets', () => {
    ctx = clavierPret('US');
    expect(ctx.kb.getMatrix()).toBeInstanceOf(Uint8Array);
    expect(ctx.kb.getMatrix()).toHaveLength(10);
    expect(Array.from(ctx.kb.getMatrix())).toEqual(new Array(10).fill(0xFF));
    ctx.kb.pressKey(4, 3);
    expect(ctx.kb.getMatrix()[4]).toBe(0xF7);
    ctx.kb.releaseKey(4, 3);
    expect(ctx.kb.getMatrix()[4]).toBe(0xFF);
    ctx.kb.pressKey(4, 3);
    ctx.kb.reset();
    expect(Array.from(ctx.kb.getMatrix())).toEqual(new Array(10).fill(0xFF));
  });

  it('suit le firmware chargé, pas le clavier de l\'utilisateur', () => {
    ctx = clavierPret('US');
    expect(ctx.autoType).toBeInstanceOf(loadKeyboard().CPC_INPUT.AutoType);

    // Firmware UK : `a` est en 8:5.
    ctx.kb.autotype('a');
    expect(ctx.autoType.queue[0]).toMatchObject({ line: 8, bit: 5, shift: false });

    // Firmware FR : `a` est en 8:3. C'est la différence entre taper `a` et taper
    // `q` — le défaut qui donnait « RE? » au lieu de « REM ».
    ctx.kb.cancelAutotype();
    ctx.kb.setLayout('FR');
    ctx.kb.autotype('a');
    expect(ctx.autoType.queue[0]).toMatchObject({ line: 8, bit: 3, shift: false });

    // Et l'inversion AZERTY qui la caractérise : `z` et `w` s'échangent.
    ctx.kb.cancelAutotype();
    ctx.kb.autotype('zw');
    expect(ctx.autoType.queue[0]).toMatchObject({ line: 7, bit: 3 });   // z en 7:3
    expect(ctx.autoType.queue[1]).toMatchObject({ line: 8, bit: 7 });   // w en 8:7
  });

  it('appuie sur une touche en \'event.code\'', () => {
    ctx = clavierPret('US');
    ctx.kb.setLayout('US');
    ctx.kb.keydownEvent(evenement('KeyA'));

    // Bit à 0 = pressé, ligne 8, bit 5 → 0xFF moins 32.
    expect(ctx.kb.matrix[8]).toBe(0xFF & ~32);

    ctx.kb.keyupEvent(evenement('KeyA'));
    expect(ctx.kb.matrix[8]).toBe(0xFF);
  });

  it('ignore les touches sans équivalent CPC', () => {
    ctx = clavierPret('US');
    const avant = Array.from(ctx.kb.matrix);
    ctx.kb.keydownEvent(evenement('MetaLeft'));
    expect(Array.from(ctx.kb.matrix)).toEqual(avant);
  });

  it('neutralise F11 et F12 conformément à la liste F1-F12', () => {
    ctx = clavierPret('US');
    for (const code of ['F11', 'F12']) {
      const event = evenement(code);
      ctx.kb.keydownEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it('annule par défaut flèches, Espace, Tab, F1-F12, Backspace et ALT', () => {
    ctx = clavierPret('US');
    const codes = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab',
      'F1', 'F12', 'Backspace'];
    for (const code of codes) {
      const event = evenement(code);
      ctx.kb.keydownEvent(event);
      expect(event.defaultPrevented, code).toBe(true);
    }
    // ALT est la touche CAPS du CPC (1:1) : sans `preventDefault` le navigateur
    // le traite comme modificateur système et retire le focus de la page.
    for (const code of ['AltLeft', 'AltRight']) {
      const event = evenement(code);
      ctx.kb.keydownEvent(event);
      expect(event.defaultPrevented, code).toBe(true);
    }
    for (const code of ['KeyA', 'Enter', 'Escape', 'F13']) {
      const event = evenement(code);
      ctx.kb.keydownEvent(event);
      expect(event.defaultPrevented, code).toBe(false);
    }
  });

  it('n\'écoute plus keypress/keyCode/which et n\'ajoute pas de propriété à window', () => {
    ctx = clavierPret('US');
    expect(ctx.dom.document.onkeypress).toBeUndefined();
    expect(Object.hasOwn(ctx.dom.window, 'Keyboard')).toBe(false);
    expect(Object.hasOwn(ctx.dom.window, 'CPC_INPUT')).toBe(false);
  });
});

describe('Keyboard — modificateurs', () => {
  let ctx;

  afterEach(() => { if (ctx) ctx.restaure(); });

  it('garde Shift actif tant que l\'un des côtés est enfoncé', () => {
    ctx = clavierPret('US');
    ctx.kb.keydownEvent(evenement('ShiftLeft'));
    ctx.kb.keydownEvent(evenement('ShiftRight'));
    ctx.kb.keyupEvent(evenement('ShiftLeft'));
    expect(ctx.kb.modifiers.shift).toBe(true);
    expect(ctx.kb.matrix[2] & (1 << 5)).toBe(0);
    ctx.kb.keyupEvent(evenement('ShiftRight'));
    expect(ctx.kb.modifiers.shift).toBe(false);
    expect(ctx.kb.matrix[2] & (1 << 5)).not.toBe(0);
  });

  it('suit l\'état de Shift et Control de chaque côté', () => {
    ctx = clavierPret('US');

    ctx.kb.keydownEvent(evenement('ShiftLeft'));
    expect(ctx.kb.modifiers.shift).toBe(true);
    expect(ctx.kb.matrix[2]).toBe(0xFF & ~32);

    ctx.kb.keydownEvent(evenement('ControlRight'));
    expect(ctx.kb.modifiers.ctrl).toBe(true);
    expect(ctx.kb.matrix[2]).toBe(0xFF & ~(32 | 128));

    ctx.kb.keyupEvent(evenement('ShiftLeft'));
    expect(ctx.kb.modifiers.shift).toBe(false);
    expect(ctx.kb.matrix[2]).toBe(0xFF & ~128);   // CTRL toujours enfoncé
  });

  it('un modificateur reste suivi même quand le joystick détourne la touche', () => {
    // En mode joystick, Control est redirigé vers la ligne 9 — mais son état
    // logique doit tout de même être suivi.
    ctx = clavierPret('US');
    ctx.kb._getJoystickEnabled = () => true;
    ctx.kb.keydownEvent(evenement('ControlLeft'));
    expect(ctx.kb.modifiers.ctrl).toBe(true);
    expect(ctx.kb.matrix[9]).toBe(0xFF & ~16);   // JOY_FIRE1
  });
});

describe('Keyboard — zone de saisie Auto-Type', () => {
  let ctx;

  afterEach(() => { if (ctx) ctx.restaure(); });

  it('n\'injecte rien dans la matrice quand le focus est dans le textarea', () => {
    // Le textarea Auto-Type et l'écran du CPC se disputeraient le même
    // caractère : taper « 10 PRINT » y inserait « 10 PRINT » dans le BASIC
    // *et* sur l'écran de l'émulateur.
    ctx = clavierPret('US');
    ctx.focusSaisie(true);

    ctx.kb.keydownEvent(evenement('KeyA'));
    ctx.kb.keydownEvent(evenement('Digit1'));
    ctx.kb.keyupEvent(evenement('KeyA'));

    expect(Array.from(ctx.kb.getMatrix())).toEqual(new Array(10).fill(0xFF));
  });

  it('laisse les flèches et le retour arrière à l\'hôte', () => {
    // C'est le défaut le plus visible : dans le textarea, les flèches
    // déplaçaient le curseur vers le haut et le retour arrière effaçait le
    // caractère précédent, parce que `preventDefault()` neutralisait des
    // touches dont le firmware n'a rien à faire.
    ctx = clavierPret('US');
    ctx.focusSaisie(true);

    for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace']) {
      const event = evenement(code);
      ctx.kb.keydownEvent(event);
      expect(event.defaultPrevented, code).toBe(false);
    }
  });

  it('reprend l\'injection dès que le focus quitte le textarea', () => {
    ctx = clavierPret('US');
    ctx.focusSaisie(true);
    ctx.kb.keydownEvent(evenement('KeyA'));
    expect(ctx.kb.matrix[8]).toBe(0xFF);

    ctx.focusSaisie(false);
    ctx.kb.keydownEvent(evenement('KeyA'));
    expect(ctx.kb.matrix[8]).toBe(0xFF & ~32);
  });

  it('relâche les touches déjà enfoncées quand le focus bascule', () => {
    // On tape « A » puis on clique dans le textarea : le `keyup` ne viendra
    // plus (le CPC a déjà reçu l'appui, l'hôte reçoit le relâchement). Sans
    // relâchement forcé ici, la touche resterait bloquée à jamais.
    ctx = clavierPret('US');
    ctx.kb.keydownEvent(evenement('KeyA'));
    expect(ctx.kb.matrix[8]).not.toBe(0xFF);

    ctx.focusSaisie(true);
    ctx.kb.keydownEvent(evenement('KeyB'));

    expect(Array.from(ctx.kb.getMatrix())).toEqual(new Array(10).fill(0xFF));
  });

  it('neutralise ALT pour ne pas perdre le focus de la page', () => {
    // ALT est la touche CAPS du CPC (1:1). Le navigateur le traitant comme
    // modificateur système, la page perdait le focus dès le premier appui.
    ctx = clavierPret('US');
    ctx.focusSaisie(false);

    const event = evenement('AltLeft');
    ctx.kb.keydownEvent(event);
    expect(event.defaultPrevented).toBe(true);

    // La touche reste bien injectée côté CPC : neutraliser l'action navigateur
    // ne doit pas empêcher la matrice de voir l'appui.
    expect(ctx.kb.matrix[1] & (1 << 1)).toBe(0);
  });
});

describe('Keyboard — relâchement global', () => {
  let ctx;

  afterEach(() => { if (ctx) ctx.restaure(); });

  it('pose un écouteur sur le blur de la fenêtre', () => {
    ctx = clavierPret('US');
    expect(ctx.dom.listeners.get('blur')).toHaveLength(1);
  });

  it('relâche toutes les touches enfoncées sur blur', () => {
    ctx = clavierPret('US');
    ctx.kb.keydownEvent(evenement('KeyA'));
    ctx.kb.keydownEvent(evenement('KeyN'));
    ctx.kb.keydownEvent(evenement('ShiftLeft'));
    expect(ctx.kb.matrix[8]).not.toBe(0xFF);
    expect(ctx.kb.matrix[5]).not.toBe(0xFF);

    // L'utilisateur change d'onglet : le keyup ne viendra jamais.
    for (const fn of ctx.dom.listeners.get('blur')) fn();

    expect(Array.from(ctx.kb.matrix)).toEqual(new Array(10).fill(0xFF));
  });

  it('relâche aussi les modificateurs sur blur', () => {
    ctx = clavierPret('US');
    ctx.kb.keydownEvent(evenement('ShiftLeft'));
    ctx.kb.keydownEvent(evenement('ControlLeft'));
    ctx.kb.keydownEvent(evenement('AltLeft'));
    expect(ctx.kb.modifiers).toEqual({ shift: true, ctrl: true, alt: true, capsLock: false });

    for (const fn of ctx.dom.listeners.get('blur')) fn();

    expect(ctx.kb.modifiers).toEqual({ shift: false, ctrl: false, alt: false, capsLock: false });
  });

  it('conserve le texte AutoType quand la fenêtre perd le focus', () => {
    // Changer de fenêtre ne doit pas interrompre la frappe : le `keyup` du
    // caractère en cours ne viendra jamais, mais le texte reste à taper. Avant,
    // le blur annulait toute la file et le texte saisi dans l'UI disparaissait.
    ctx = clavierPret('US');
    ctx.kb.autotype('abc');
    ctx.kb.readAYPort(8);   // le firmware interroge la matrice
    ctx.kb.onFrame();
    expect(ctx.kb.isAutotyping()).toBe(true);
    expect(ctx.kb.matrix[8]).not.toBe(0xFF);
    const restants = ctx.autoType.queue.length;

    for (const fn of ctx.dom.listeners.get('blur')) fn();

    // La matrice est bien relâchée — aucune touche ne reste collée…
    expect(Array.from(ctx.kb.matrix)).toEqual(new Array(10).fill(0xFF));
    // …mais le texte à taper survit, caractère en cours compris.
    expect(ctx.kb.isAutotyping()).toBe(true);
    expect(ctx.autoType.queue).toHaveLength(restants + 1);
  });

  it('reprend la frappe après un changement de fenêtre', () => {
    // Le cas réel : l'utilisateur lance une injection, va lire un message dans
    // une autre fenêtre, puis revient. La frappe doit reprendre où elle en
    // était — et le caractère interrompu être retapé plutôt que perdu.
    ctx = clavierPret('US');
    ctx.kb.autotype('ab');
    ctx.kb.readAYPort(8);
    ctx.kb.onFrame();                       // frappe le 'a'
    expect(ctx.kb.getMatrix()[8] & (1 << 5)).toBe(0);

    for (const fn of ctx.dom.listeners.get('blur')) fn();
    expect(Array.from(ctx.kb.getMatrix())).toEqual(new Array(10).fill(0xFF));

    // Le firmware reprend ses lectures : le texte repart tout seul.
    ctx.kb.readAYPort(8);
    ctx.kb.onFrame();
    expect(ctx.kb.isAutotyping()).toBe(true);

    for (const touche of [1, 2, 3, 4, 5]) {
      ctx.kb.readAYPort(touche);
      ctx.kb.onFrame();
    }
    // Les DEUX caractères ont fini par être tapés, malgré l'interruption.
    expect(ctx.kb.isAutotyping()).toBe(false);
  });

  it('changer de firmware ne laisse pas de touche pressée', () => {
    // Les positions diffèrent entre AZERTY et QWERTY : sans relâchement, la
    // touche pressée resterait enfoncée à sa position d'origine.
    ctx = clavierPret('US');
    ctx.kb.setLayout('FR');
    ctx.kb.keydownEvent(evenement('KeyA'));   // position Q en AZERTY
    expect(ctx.kb.matrix[8]).toBe(0xFF & ~8);

    ctx.kb.setLayout('US');
    expect(Array.from(ctx.kb.matrix)).toEqual(new Array(10).fill(0xFF));
  });
});

describe('Keyboard — lecture de la matrice', () => {
  let ctx;

  afterEach(() => { if (ctx) ctx.restaure(); });

  it('rejette un firmware inconnu sans casser la table précédente', () => {
    ctx = clavierPret('US');
    const avant = ctx.kb.layout;
    ctx.kb.setLayout('XX');
    expect(ctx.kb.layout).toBe(avant);
    expect(ctx.kb.layoutMap).toBe(CPC_KEYBOARD_MAPS.US);
  });

  it('expose une ligne brute et lit la matrice partagée via PPI', () => {
    ctx = clavierPret('US');
    ctx.kb._getSelectedRow = () => 8;
    ctx.kb.keydownEvent(evenement('KeyA'));
    expect(ctx.kb.getMatrixRow(8)).toBe(0xFF & ~32);
    expect(ctx.kb.readMatrixRow()).toBe(0xFF & ~32);

    ctx.kb.pressKey(8, 3);
    ctx.kb.pressKey(2, 5);
    expect(ctx.kb.getMatrixRow(8)).toBe(0xFF & ~(32 | 8));
    expect(ctx.kb.readMatrixRow()).toBe(0xFF & ~(32 | 8));
    expect(ctx.kb.getMatrixRow(2)).toBe(0xFF & ~(1 << 5));
  });
});
