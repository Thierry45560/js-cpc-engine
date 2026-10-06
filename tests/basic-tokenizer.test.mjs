/**
 * @file tests/basic-tokenizer.test.mjs
 * @description Tests du tokeniseur BASIC (`site/js/tools/BasicTokenizer.js`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI CES OCTETS-LÀ
 * ─────────────────────────────────────────────────────────────────────────────
 * Un « bon » tokeniseur ne produit pas seulement des tokens plausibles : il doit
 * produire EXACTEMENT ceux que le firmware écrit, sinon le programme ne se
 * relit plus (LIST) ou ne s'exécute pas (RUN). Les attentes ci-dessous viennent
 * donc du format documenté, et le cas « Hello World » est comparé aux 35 octets
 * d'un vrai .BAS sauvegardé sur un CPC — c'est lui qui ancre tout le reste.
 *
 * Les cas qui comptent le plus :
 *   - la longueur de ligne (en-tête + corps + marque de fin) ;
 *   - GOTO/GOSUB suivis d'un NUMÉRO DE LIGNE (token 0x1E) et non d'une constante ;
 *   - les noms de variables, terminés par un caractère au bit 7 posé ;
 *   - REM / DATA / chaînes, jamais tokenisés.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = resolve(HERE, '../site/js/tools/BasicTokenizer.js');

/** @type {object} Le module chargé. */
let BasicTokenizer;

/**
 * Charge le script classique via `vm`, en lui ajoutant une expression d'export.
 * Même stratégie que les autres harnais du dépôt.
 * @returns {object} L'objet `BasicTokenizer`.
 */
function charger() {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  runInThisContext(
    `${source}\n;globalThis.__BASIC_TOK__ = BasicTokenizer;`,
    { filename: SOURCE_PATH },
  );
  return globalThis.__BASIC_TOK__;
}

/**
 * Renvoie le corps tokenisé d'un programme d'une seule ligne, sans son en-tête
 * (longueur + numéro) ni la marque de fin.
 * @param {string} source Listing d'une ligne.
 * @returns {number[]} Octets du corps.
 */
function corps(source) {
  const t = BasicTokenizer.tokeniser(source);
  const octets = [...t.octets];
  return octets.slice(4, octets.length - 3);
}

beforeAll(() => { BasicTokenizer = charger(); });

describe('BasicTokenizer — référence réelle', () => {
  it('reproduit les 35 octets d\'un HELLO.BAS sauvegardé sur CPC', () => {
    // Source : 10 REM Hello / 20 PRINT "Hello World!"
    // Extrait d'un vrai fichier .BAS (en-tête AMSDOS exclu).
    const t = BasicTokenizer.tokeniser('10 REM Hello\n20 PRINT "Hello World!"');
    expect([...t.octets]).toEqual([
      0x0c, 0x00, 0x0a, 0x00, 0xc5, 0x20, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00,
      0x15, 0x00, 0x14, 0x00, 0xbf, 0x20, 0x22, 0x48, 0x65, 0x6c, 0x6c, 0x6f,
      0x20, 0x57, 0x6f, 0x72, 0x6c, 0x64, 0x21, 0x22, 0x00,
      0x00, 0x00,
    ]);
    expect(t.octets.length).toBe(35);
    expect(t.lignes).toBe(2);
    expect(t.erreurs).toEqual([]);
  });
});

describe('BasicTokenizer — en-tête de ligne', () => {
  it('écrit longueur = corps + 5, puis le numéro', () => {
    // « 10 A=5 » : corps = 6 octets → longueur 11 (0x0b)
    const t = BasicTokenizer.tokeniser('10 A=5');
    expect([...t.octets.slice(0, 4)]).toEqual([0x0b, 0x00, 0x0a, 0x00]);
  });

  it('termine le programme par une longueur nulle', () => {
    const t = BasicTokenizer.tokeniser('10 A=5');
    expect([...t.octets.slice(-3)]).toEqual([0x00, 0x00, 0x00]);
  });

  it('ne conserve pas l\'espace qui suit le numéro', () => {
    // « 10 PRINT "x" » : PRINT est le PREMIER token du corps.
    expect(corps('10 PRINT "x"')[0]).toBe(0xbf);
  });

  it('conserve un programme vide sous la forme 00 00', () => {
    const t = BasicTokenizer.tokeniser('');
    expect([...t.octets]).toEqual([0x00, 0x00]);
    expect(t.lignes).toBe(0);
  });

  it('signale les lignes sans numéro au lieu de les tokeniser', () => {
    const t = BasicTokenizer.tokeniser('PRINT "x"\n10 A=1');
    expect(t.lignes).toBe(1);
    expect(t.erreurs).toEqual([{ ligne: 1, message: 'Numéro de ligne manquant' }]);
  });
});

describe('BasicTokenizer — nombres', () => {
  it('encode 0-9 sur un seul octet', () => {
    expect(corps('10 A=5')).toEqual([0x0d, 0x00, 0x00, 0xc1, 0xef, 0x13]);
  });

  it('encode 10-255 avec le token 0x19', () => {
    expect(corps('10 A=100')).toEqual([0x0d, 0x00, 0x00, 0xc1, 0xef, 0x19, 0x64]);
  });

  it('encode 256-32767 avec le token 0x1A sur deux octets', () => {
    expect(corps('10 A=1000')).toEqual(
      [0x0d, 0x00, 0x00, 0xc1, 0xef, 0x1a, 0xe8, 0x03],
    );
  });

  it('encode l\'hexadécimal &H… et le binaire &X…', () => {
    expect(corps('10 A=&H1F')).toEqual([0x0d, 0x00, 0x00, 0xc1, 0xef, 0x1c, 0x1f, 0x00]);
    expect(corps('10 A=&X1010')).toEqual([0x0d, 0x00, 0x00, 0xc1, 0xef, 0x1b, 0x0a, 0x00]);
  });

  it('encode 0,5 en exposant 127 (négatif)', () => {
    // 0,5 = 1,0 × 2^-1 : biais 128 → 127 = 0x7F, mantisse nulle.
    expect(corps('10 A=0.5')).toEqual([
      0x0d, 0x00, 0x00, 0xc1, 0xef, 0x1f, 0x00, 0x00, 0x00, 0x00, 0x7f,
    ]);
  });

  it('encode 1,5 en exposant 128 (positif, mantisse 0x40000000)', () => {
    expect(corps('10 A=1.5')).toEqual([
      0x0d, 0x00, 0x00, 0xc1, 0xef, 0x1f, 0x00, 0x00, 0x00, 0x40, 0x80,
    ]);
  });

  it('bascule au réel au-delà de 32767', () => {
    const octets = corps('10 A=40000');
    expect(octets[octets.length - 6]).toBe(0x1f);
    expect(octets.length).toBe(11);
  });
});

describe('BasicTokenizer — variables', () => {
  it('précède le nom d\'un type et d\'un offset nul', () => {
    // Type « quelconque » (0x0D), offset 00 00, puis le nom, bit 7 sur la
    // dernière lettre.
    expect(corps('10 AB=1')).toEqual([0x0d, 0x00, 0x00, 0x41, 0xc2, 0xef, 0x0f]);
  });

  it('encode les suffixes $, % et !', () => {
    expect(corps('10 A$="x"')).toEqual([0x03, 0x00, 0x00, 0xc1, 0xef, 0x22, 0x78, 0x22]);
    expect(corps('10 B%=1')).toEqual([0x02, 0x00, 0x00, 0xc2, 0xef, 0x0f]);
    expect(corps('10 C!=1')).toEqual([0x04, 0x00, 0x00, 0xc3, 0xef, 0x0f]);
  });

  it('tokenise un tableau comme un nom suivi de ses arguments', () => {
    expect(corps('10 A(1)=2')).toEqual([
      0x0d, 0x00, 0x00, 0xc1, 0x28, 0x0f, 0x29, 0xef, 0x10,
    ]);
  });

  it('ne confond pas un nom qui commence par un mot-clé', () => {
    // TOTAL ne doit pas devenir TO + TAL.
    expect(corps('10 TOTAL=1')).toEqual([
      0x0d, 0x00, 0x00, 0x54, 0x4f, 0x54, 0x41, 0xcc, 0xef, 0x0f,
    ]);
  });

  it('ignore la casse des mots-clés sans toucher aux noms', () => {
    expect(corps('10 print "x"')[0]).toBe(0xbf);
    expect(corps('10 abc=1')).toEqual([0x0d, 0x00, 0x00, 0x61, 0x62, 0xe3, 0xef, 0x0f]);
  });
});

describe('BasicTokenizer — numéros de ligne', () => {
  it('encode GOTO/GOSUB avec le token 0x1E', () => {
    expect(corps('10 GOTO 100')).toEqual([0xa0, 0x20, 0x1e, 0x64, 0x00]);
    expect(corps('10 GOSUB 1000')).toEqual([0x9f, 0x20, 0x1e, 0xe8, 0x03]);
  });

  it('encode aussi le numéro derrière THEN', () => {
    expect(corps('10 IF A THEN 100')).toEqual([
      0xa1, 0x20, 0x0d, 0x00, 0x00, 0xc1, 0x20, 0xeb, 0x20, 0x1e, 0x64, 0x00,
    ]);
  });

  it('laisse une constante là où aucun numéro n\'est attendu', () => {
    // PRINT 100 : c'est bien la constante 0x19 qui doit sortir.
    expect(corps('10 PRINT 100')).toEqual([0xbf, 0x20, 0x19, 0x64]);
  });

  it('reconnaît GO SUB et GO TO comme GOSUB et GOTO', () => {
    // Forme en deux mots : même token, et le numéro reste un numéro de ligne.
    expect(corps('10 GO SUB 100')).toEqual([0x9f, 0x20, 0x1e, 0x64, 0x00]);
    expect(corps('10 GO TO 5')).toEqual([0xa0, 0x20, 0x1e, 0x05, 0x00]);
  });

  it('encode deux sauts séparés par « : » sur la même ligne', () => {
    expect(corps('10 GOTO 10:GOSUB 20')).toEqual([
      0xa0, 0x20, 0x1e, 0x0a, 0x00, 0x01, 0x9f, 0x20, 0x1e, 0x14, 0x00,
    ]);
  });

  it('encode le numéro derrière « THEN GOSUB »', () => {
    expect(corps('10 IF A=1 THEN GOSUB 500')).toEqual([
      0xa1, 0x20, 0x0d, 0x00, 0x00, 0xc1, 0xef, 0x0f, 0x20, 0xeb, 0x20,
      0x9f, 0x20, 0x1e, 0xf4, 0x01,
    ]);
  });
});

describe('BasicTokenizer — mots-clés et opérateurs', () => {
  it('choisit le mot-clé le plus long', () => {
    expect(corps('10 MODE 1')).toEqual([0xad, 0x20, 0x0f]);
    expect(corps('10 A=B MOD 2')).toEqual([
      0x0d, 0x00, 0x00, 0xc1, 0xef, 0x0d, 0x00, 0x00, 0xc2, 0x20, 0xfb, 0x20, 0x10,
    ]);
  });

  it('préfixe les fonctions d\'un 0xFF', () => {
    expect(corps('10 PRINT INKEY$')).toEqual([0xbf, 0x20, 0xff, 0x43]);
    expect(corps('10 A=LEN(B$)')).toEqual([
      0x0d, 0x00, 0x00, 0xc1, 0xef, 0xff, 0x0e, 0x28, 0x03, 0x00, 0x00, 0xc2, 0x29,
    ]);
  });

  it('précède ELSE d\'un séparateur d\'instruction', () => {
    expect(corps('10 IF A THEN B ELSE C')).toEqual([
      0xa1, 0x20, 0x0d, 0x00, 0x00, 0xc1, 0x20, 0xeb, 0x20,
      0x0d, 0x00, 0x00, 0xc2, 0x20, 0x01, 0x97, 0x20, 0x0d, 0x00, 0x00, 0xc3,
    ]);
  });

  it('encode les comparaisons composées', () => {
    expect(corps('10 IF A>=B THEN 100')).toEqual([
      0xa1, 0x20, 0x0d, 0x00, 0x00, 0xc1, 0xf0, 0x0d, 0x00, 0x00, 0xc2,
      0x20, 0xeb, 0x20, 0x1e, 0x64, 0x00,
    ]);
    expect(corps('10 IF A<>B THEN 100')[6]).toBe(0xf2);
    expect(corps('10 IF A<=B THEN 100')[6]).toBe(0xf3);
    expect(corps('10 IF A<B THEN 100')[6]).toBe(0xf1);
  });

  it('encode les opérateurs arithmétiques et le séparateur « : »', () => {
    expect(corps('10 A=B+C*D')).toEqual([
      0x0d, 0x00, 0x00, 0xc1, 0xef, 0x0d, 0x00, 0x00, 0xc2, 0xf4,
      0x0d, 0x00, 0x00, 0xc3, 0xf6, 0x0d, 0x00, 0x00, 0xc4,
    ]);
    expect(corps('10 A=1:B=2')).toEqual([
      0x0d, 0x00, 0x00, 0xc1, 0xef, 0x0f, 0x01,
      0x0d, 0x00, 0x00, 0xc2, 0xef, 0x10,
    ]);
  });
});

describe('BasicTokenizer — zones non tokenisées', () => {
  it('recopie une chaîne telle quelle, mots-clés compris', () => {
    expect(corps('10 A$="FOR NEXT"')).toEqual([
      0x03, 0x00, 0x00, 0xc1, 0xef,
      0x22, 0x46, 0x4f, 0x52, 0x20, 0x4e, 0x45, 0x58, 0x54, 0x22,
    ]);
  });

  it('recopie le commentaire après REM', () => {
    expect(corps('10 REM Hello')).toEqual([0xc5, 0x20, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  });

  it('traite l\'apostrophe comme un commentaire', () => {
    // L'espace qui suit le numéro de ligne est déjà retiré par le BASIC.
    expect(corps("10 'Hello")).toEqual([0x01, 0xc0, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  });

  it('recopie les données après DATA', () => {
    expect(corps('10 DATA 1,2')).toEqual([0x8c, 0x20, 0x31, 0x2c, 0x32]);
  });

  it('encode un RSX avec son nom terminé par le bit 7', () => {
    expect(corps('10 |DIR')).toEqual([0x7c, 0x00, 0x44, 0x49, 0xd2]);
  });
});

describe('BasicTokenizer — DATA suivi d\'une instruction', () => {
  it('arrête les données au séparateur « : » et tokenise la suite', () => {
    // Régression : les données étaient recopiées jusqu'à la fin de ligne, si
    // bien que « :REM note » se retrouvait AVALÉ dans le DATA. La ligne devenait
    // invalide sur le CPC (il fallait la ressaisir pour qu'elle soit acceptée).
    // Le « : » doit rester un séparateur d'instruction (0x01) et REM un token.
    expect(corps('10 DATA 1,2:REM note')).toEqual([
      0x8c, 0x20, 0x31, 0x2c, 0x32, 0x01, 0xc5, 0x20, 0x6e, 0x6f, 0x74, 0x65,
    ]);
  });

  it('reproduit une ligne « DATA … :REM » telles qu\'on les sait valides', () => {
    // Corps attendu : DATA, les données telles quelles, puis « :REM Salle 1 »
    // tokenisé. La longueur de ligne doit rester cohérente avec ces octets.
    const attendu = [
      0x8c,
      0x20, 0x30, 0x2c, 0x20, 0x20, 0x30, 0x2c, 0x20, 0x20, 0x34, 0x2c,
      0x20, 0x20, 0x30, 0x2c, 0x20, 0x20, 0x30, 0x2c, 0x20, 0x20, 0x30,
      0x20,
      0x01, 0xc5,
      0x20, 0x53, 0x61, 0x6c, 0x6c, 0x65, 0x20, 0x31,
    ];
    expect(corps('9160 DATA 0,  0,  4,  0,  0,  0 :REM Salle 1')).toEqual(attendu);

    // L'en-tête déclare bien 5 octets de plus que le corps, et rien de plus.
    const ligne = BasicTokenizer.tokeniser('9160 DATA 0,  0,  4,  0,  0,  0 :REM Salle 1');
    const longueur = ligne.octets[0] | (ligne.octets[1] << 8);
    expect(longueur).toBe(attendu.length + 5);
  });

  it('accepte un listing entier de lignes « DATA … :REM »', () => {
    const source = [
      '9160 DATA 0,  0,  4,  0,  0,  0 :REM Salle 1',
      '9210 DATA 7,  5,  0,  0,  0,  8 :REM Salle 6',
      '9300 DATA 0,  0,  0,  0,  0,  0 :REM Salle 15',
    ].join('\n');
    const t = BasicTokenizer.tokeniser(source);
    expect(t.erreurs).toEqual([]);
    expect(t.lignes).toBe(3);
  });

  it('ne coupe pas un « : » situé dans une chaîne de données', () => {
    // Œil-de-bœuf : le séparateur n'arrête DATA que hors guillemets.
    expect(corps('10 DATA "a:b",2')).toEqual([
      0x8c, 0x20, 0x22, 0x61, 0x3a, 0x62, 0x22, 0x2c, 0x32,
    ]);
  });

  it('laisse le « : » d\'un commentaire REM inerte', () => {
    // REM prend toute la fin de ligne : le « : » y reste du texte.
    expect(corps('10 REM a:b')).toEqual([0xc5, 0x20, 0x61, 0x3a, 0x62]);
  });
});

describe('BasicTokenizer — DATA entre guillemets', () => {
  it('ne coupe ni les virgules ni les « : » d\'une chaîne de données', () => {
    expect(corps('10 DATA "x,y",2')).toEqual([
      0x8c, 0x20, 0x22, 0x78, 0x2c, 0x79, 0x22, 0x2c, 0x32,
    ]);
    // Le « : » de « a:b » reste des données ; celui qui suit les termine.
    expect(corps('10 DATA "a:b",2:REM note')).toEqual([
      0x8c, 0x20, 0x22, 0x61, 0x3a, 0x62, 0x22, 0x2c, 0x32,
      0x01, 0xc5, 0x20, 0x6e, 0x6f, 0x74, 0x65,
    ]);
  });

  it('mélange valeurs nues et chaînes', () => {
    expect(corps('10 DATA 1,"two",3')).toEqual([
      0x8c, 0x20, 0x31, 0x2c, 0x22, 0x74, 0x77, 0x6f, 0x22, 0x2c, 0x33,
    ]);
  });
});

describe('BasicTokenizer — apostrophe', () => {
  it('précède le commentaire d\'un séparateur d\'instruction', () => {
    // A=1 puis « : 'comment » : au séparateur « : » (0x01) succède le couple
    // 0x01 0xC0 propre à l'apostrophe, comme pour ELSE.
    expect(corps("10 A=1:'comment")).toEqual([
      0x0d, 0x00, 0x00, 0xc1, 0xef, 0x0f, 0x01, 0x01, 0xc0,
      0x63, 0x6f, 0x6d, 0x6d, 0x65, 0x6e, 0x74,
    ]);
  });

  it('laisse « : » et apostrophe inertes dans un REM', () => {
    expect(corps("10 REM a'b : x")).toEqual([
      0xc5, 0x20, 0x61, 0x27, 0x62, 0x20, 0x3a, 0x20, 0x78,
    ]);
  });
});

describe('BasicTokenizer — pointeurs BASIC', () => {
  it('choisit le jeu de pointeurs selon la machine', () => {
    expect(BasicTokenizer.pointeursPour(2)).toEqual([0xae66, 0xae68, 0xae6a, 0xae6c]);
    expect(BasicTokenizer.pointeursPour(1)).toEqual([0xae66, 0xae68, 0xae6a, 0xae6c]);
    expect(BasicTokenizer.pointeursPour(4)).toEqual([0xae66, 0xae68, 0xae6a, 0xae6c]);
    expect(BasicTokenizer.pointeursPour(0)).toEqual([0xae83, 0xae85, 0xae87, 0xae89]);
    expect(BasicTokenizer.pointeursPour(5)).toEqual([0xae83, 0xae85, 0xae87, 0xae89]);
  });
});

describe('BasicTokenizer — injection en mémoire', () => {
  /**
   * Mémoire factice de 64 Ko, sans ROM ni banques.
   * @returns {{memoire: Uint8Array, ecrire: Function}}
   */
  function memoireVierge() {
    const memoire = new Uint8Array(0x10000);
    return {
      memoire,
      ecrire: (adresse, valeur) => { memoire[adresse & 0xffff] = valeur & 0xff; },
    };
  }

  it('écrit le programme à 0x0170', () => {
    const { memoire, ecrire } = memoireVierge();
    const r = BasicTokenizer.injecter('10 A=5', 2, ecrire);

    expect(r.ok).toBe(true);
    expect(r.octets).toBe(13);
    expect([...memoire.slice(0x0170, 0x017c)]).toEqual([
      0x0b, 0x00, 0x0a, 0x00, 0x0d, 0x00, 0x00, 0xc1, 0xef, 0x13, 0x00, 0x00,
    ]);
  });

  it('aligne les quatre pointeurs sur la fin du programme', () => {
    const { memoire, ecrire } = memoireVierge();
    // 35 octets → fin = 0x0170 + 35 = 0x0193
    const r = BasicTokenizer.injecter('10 REM Hello\n20 PRINT "Hello World!"', 2, ecrire);

    expect(r.adresseFin).toBe(0x0193);
    expect([...BasicTokenizer.pointeursPour(2).map((p) => memoire[p] | (memoire[p + 1] << 8))])
      .toEqual([0x0193, 0x0193, 0x0193, 0x0193]);
  });

  it('utilise les pointeurs BASIC 1.0 sur un 464', () => {
    const { memoire, ecrire } = memoireVierge();
    BasicTokenizer.injecter('10 A=5', 0, ecrire);

    const valeurs = [0xae83, 0xae85, 0xae87, 0xae89]
      .map((p) => memoire[p] | (memoire[p + 1] << 8));
    expect(valeurs).toEqual([0x017d, 0x017d, 0x017d, 0x017d]);
  });

  it('n\'écrit rien quand le listing est invalide', () => {
    const { memoire, ecrire } = memoireVierge();
    const r = BasicTokenizer.injecter('PRINT "x"', 2, ecrire);

    expect(r.ok).toBe(false);
    expect(r.erreurs[0].message).toBe('Numéro de ligne manquant');
    expect(memoire.every((v) => v === 0)).toBe(true);
  });
});
