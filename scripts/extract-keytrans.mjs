#!/usr/bin/env node
/**
 * @file scripts/extract-keytrans.mjs
 * @description Extrait la table caractère → matrice CPC d'un firmware, DANS la ROM.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI EXTRAIRE ET NON ÉCRIRE À LA MAIN
 * ─────────────────────────────────────────────────────────────────────────────
 * Les tables précédentes du projet étaient recopiées à la main, et divergeaient
 * du matériel : en AZERTY `w` et `z` s'étaient inversés, la rangée des chiffres
 * était décalée d'une touche. Une table dérivée de la ROM ne peut plus mentir
 * sur ce que le CPC affiche réellement.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OÙ SE TROUVE LA TABLE
 * ─────────────────────────────────────────────────────────────────────────────
 * Le firmware patches 240 octets dans sa propre mémoire : 3 blocs de 80
 * octets — non-majoré, majoré, COPY — pour les 10 lignes de 8 touches. Sur le
 * 464 c'est à `0x1D69`, sur le 6128 à `0x1EEF`. On retrouve l'emplacement par
 * recherche d'une signature structurelle, et non par un offset codé en dur,
 * pour ne pas dépendre d'une variante de ROM précise.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEUX PIÈGES, ET ILS SONT CRITIQUES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. **La ligne 9 est le pavé directionnel.** Elle duplique `X` et `Z` en 9:4
 *    et 9:5. La garder écraserait les vraies positions de `x` et `z` par
 *    celles du pavé, si bien que taper `z` enverrait la flèche du haut. Seules
 *    les lignes 0 à 8 sont donc retenues — d'où l'absence de la ligne 9 dans
 *    la table.
 *
 * 2. **La priorité est le niveau nu d'abord, puis la plus petite ligne.** Sur
 *    un AZERTY, `m` existe en 3:5 (majuscule, position MINUSCULE) ET en 4:6
 *    (majuscule, position MAJUSCULE). Choisir la première venue fait
 *    disparaître la majuscule ; choisir la dernière venue fait disparaître la
 *    minuscule. La règle qui fonctionne : parcourir d'abord le bloc non-majoré
 *    en lignes croissantes, puis seulement le bloc majoré.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *   node scripts/extract-keytrans.mjs                       (UK + FR + ES)
 *   node scripts/extract-keytrans.mjs --lang=french
 *   node scripts/extract-keytrans.mjs --rom=chemin/464.ROM --lang=french
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROM_DIR = resolve(RACINE, 'site/ROM');

/**
 * Séquence de tête commune à TOUS les firmwares, et à laquelle on ancre la
 * recherche de la table.
 *
 * Les 17 premiers octets du bloc non-majoré sont ceux des touches de fonction,
 * des flèches et de RETURN : identiques en UK, FR et ES, parce que ces touches
 * n'ont pas de caractère national. Ils servent donc de signature.
 *
 * On ne prend PAS les octets suivants : à partir de la ligne 2, le firmware
 * français diffère (les caractères accentués y sont), et un motif trop long
 * échouerait à le trouver.
 */
const SIGNATURE_COMMUNE = [240, 243, 241, 137, 134, 131, 139, 138, 242, 224, 135, 136, 133, 129, 130, 128, 16];

/**
 * Densité minimale de caractères imprimables dans le bloc non-majoré.
 *
 * Une vraie table de traduction est majoritairement composée de caractères ;
 * un motif fortuit dans du code Z80 ne l'est pas. 40 sur 80 discrimine
 * largement : le firmware FR le plus dense en accents en compte 53, le UK 62.
 */
const DENSITE_MIN = 40;

/** Taille d'un bloc : 10 lignes × 8 touches. */
const TAILLE_BLOC = 80;

/** Nombre de blocs : nu, majoré, COPY. */
const NOMBRE_BLOCS = 3;

/**
 * Ligne 9 = pavé directionnel. Exclue : elle duplique `X` et `Z`.
 * Seules les lignes 0 à 8 portent des caractères du jeu normal.
 */
const DERNIERE_LIGNE_UTILE = 8;

/**
 * Codes non-imprimables ou parasites à ne jamais retenir comme caractère.
 *
 * 0x00-0x1F sont des codes de contrôle, 0x7F le DEL, 0xFF la valeur « aucune
 * touche pressée ». 0x7E (`~`) et 0x60 (`` ` ``) sont en revanche de vrais
 * caractères, et doivent passer.
 *
 * Deux exceptions sont VOLONTAIRES, car ce sont des touches et non des
 * caractères :
 *
 * - 0x0D (CR) est le RETOUR de la touche ENTER. Le filtrer supprimerait le
 *   retour à la ligne de l'injection, qui est précisément l'un des deux usages
 *   principaux de l'autotype.
 * - 0x09 (TAB) est la tabulation de la touche TAB.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LES CINQ ACCENTS FRANÇAIS DEMANDENT UNE RETOUCHE APRÈS EXTRACTION
 * ─────────────────────────────────────────────────────────────────────────────
 * Ce script ne raisonne que sur des OCTETS, et c'est ce qui le rend aveugle
 * aux accents du firmware FRANÇAIS.
 *
 * Le générateur de caractères du CPC français ne réserve pas de codes aux
 * accents : il SUBSTITUE le dessin de cinq glyphes ASCII. La table de
 * traduction de la ROM rend donc `0x7B` pour la touche `é` — un octet qui se
 * lit `{` mais qui s'AFFICHE `é` — et de même `0x7D` → `è`, `0x40` → `à`,
 * `0x7C` → `ù`, `0x5C` → `ç`.
 *
 * Résultat : l'extraction étiquette ces positions `{`, `}`, `@`, `|` et `BS`,
 * et les cinq accents — pourtant tapables au clavier — disparaîssent du table.
 *
 * ⚠️  CES CINQ POSITIONS SONT DONC ÉCRITES À LA MAIN dans `Keyboard.js`,
 *     objet `FR_CHARACTER_TABLE` : `8:1` = `é`, `5:1` = `è`, `4:1` = `ç`,
 *     `4:0` = `à`, `3:4` = `ù`. **Un nouveau passage de ce script les écrase.**
 *     Après toute réextraction, comparer le bloc FR à `_MAP_FRENCH` de
 *     `SRC/core/peripherals/Keyboard.js` (branche précédente, `git show`) :
 *     c'est cette table historique qui fait foi pour les glyphes nationaux.
 *
 * Corollaire assumé : sur firmware français, `{`, `}`, `@`, `|` et `\` ne sont
 * pas déclarés. Ils n'existent pas sur un CPC français — ce sont justement les
 * cinq glyphes que le générateur remplace. Les réintroduire enverrait l'accent
 * à la place du symbole : une faute de frappe, ce que la règle « jamais tapé
 * approximativement » interdit.
 */
const EXCEPTIONS_IMPRIMABLES = new Set([0x09, 0x0D]);

function estImprimable(code) {
    if (EXCEPTIONS_IMPRIMABLES.has(code)) return true;
    return code >= 0x20 && code <= 0x7E;
}

/**
 * Localise les 240 octets de la table de traduction dans la ROM.
 *
 * On cherche le motif UK, dont la position relative est stable d'une variante
 * à l'autre : `0x1D69` sur le 464. Le résultat est ensuite vérifié — un bloc
 * non-majoré doit contenir des codes imprimables, sinon on a trouvé un motif
 * fortuit et non la vraie table.
 *
 * @param {Buffer} rom Contenu de la ROM.
 * @returns {{offset: number, table: number[]}|null} Position et 240 octets.
 */
function localiserTable(rom) {
    const taille = TAILLE_BLOC * NOMBRE_BLOCS;
    const candidats = [];

    for (let i = 0; i + taille <= rom.length; i++) {
        let correspond = true;
        for (let j = 0; j < SIGNATURE_COMMUNE.length; j++) {
            if (rom[i + j] !== SIGNATURE_COMMUNE[j]) { correspond = false; break; }
        }
        if (!correspond) continue;

        const table = Array.from(rom.subarray(i, i + taille));
        // Garde-fou : un vrai bloc non-majoré est majoritairement composé de
        // caractères. Un motif fortuit dans du code Z80 ne l'est pas.
        const imprimables = table.slice(0, TAILLE_BLOC).filter(estImprimable).length;
        if (imprimables >= DENSITE_MIN) candidats.push({ offset: i, table, imprimables });
    }

    if (candidats.length === 0) return null;
    // En cas de collision, on retient le bloc le plus riche en caractères :
    // c'est le plus proche d'une vraie table de frappe.
    candidats.sort((a, b) => b.imprimables - a.imprimables);
    return candidats[0];
}

/**
 * Convertit les 240 octets en table `caractère → { line, bit, shift }`.
 *
 * @param {number[]} table Les 240 octets, 3 blocs de 80.
 * @returns {Map<string, {line: number, bit: number, shift: boolean}>}
 */
function decoderTable(table) {
    const resultat = new Map();

    // Piège n°2 : le bloc NU d'abord, en lignes croissantes, puis le bloc
    // MAJORÉ. L'ordre des deux boucles est toute la différence entre une table
    // correcte et une table où `m` et `M` se mangent l'un l'autre.
    //
    // Le bloc COPY passe en DERNIER, et ses combinaisons sont rendues
    // explicites : c'est là que vivent les caractères absents des deux
    // premiers, et les traiter à égalité avec les autres ferait perdre les
    // touches à modificateur simple.
    //
    //   [index du bloc, shift, ctrl]
    //
    // Le bloc COPY est lu SANS shift : la seule position qu'il apporte est
    // `8:1` = `~`, et la table UK de référence la donne en `8:1:0:1`, c'est-à-dire
    // CTRL seul, sans SHIFT. Cette valeur a été vérifiée sur le comportement réel
    // du firmware UK, pas déduite : c'est elle qui fait que `~` reste
    // tapable, puisque l'injection ne pose jamais SHIFT+CTRL ensemble.
    const BLOCS = [
        [0, false, false],   // nu      : `a` sur 8:5
        [1, true, false],    // majoré  : `A` sur 8:5
        [2, false, true],    // COPY    : `~` sur 8:1, en CTRL seul
    ];

    for (const [indexBloc, shift, ctrl] of BLOCS) {
        for (let ligne = 0; ligne <= DERNIERE_LIGNE_UTILE; ligne++) {
            for (let bit = 0; bit < 8; bit++) {
                const code = table[indexBloc * TAILLE_BLOC + ligne * 8 + bit];
                if (!estImprimable(code)) continue;

                // Indexée par OCTET et non par caractère : deux libellés
                // différents peuvent partager le même octet, et c'est l'octet
                // qui fait la position. La clé évite aussi qu'un caractère déjà
                // trouvé soit écrasé par une occurrence plus basse.
                if (resultat.has(code)) continue;
                resultat.set(code, { line: ligne, bit, shift, ctrl });
            }
        }
    }
    return resultat;
}

/**
 * Rend la table au format du source : `'l:b:shift:ctrl'` → libellés lisibles.
 *
 * Les caractères français ne sont pas ASCII : leur octet est affiché entre
 * chevrons, ce qui rend le source relisible plutôt que d'y écrire un caractère
 * Latin-1 arbitraire.
 *
 * @param {Map<number, {line: number, bit: number, shift: boolean, ctrl: boolean}>} table
 * @returns {Object} Objet trié par position de matrice.
 */
function versSource(table) {
    const parPosition = {};
    for (const [code, { line, bit, shift, ctrl }] of table) {
        const cle = `${line}:${bit}:${shift ? 1 : 0}:${ctrl ? 1 : 0}`;
        const libelle = libelleDe(code);
        (parPosition[cle] ||= []).push(libelle);
    }
    // Tri des lignes pour un source lisible et stable d'un run à l'autre.
    const triee = {};
    for (const cle of Object.keys(parPosition).sort((a, b) => {
        const [la, ba] = a.split(':').map(Number);
        const [lb, bb] = b.split(':').map(Number);
        return la !== lb ? la - lb : ba - bb;
    })) {
        triee[cle] = parPosition[cle];
    }
    return triee;
}

/**
 * Libellé source d'un octet : le caractère lui-même si lisible, sinon un nom
 * conventionnel ou sa valeur hexadécimale.
 *
 * @param {number} code Octet produit par le firmware.
 * @returns {string} Libellé à écrire dans le source.
 */
function libelleDe(code) {
    switch (code) {
        case 0x09: return 'TAB';
        case 0x0D: return 'CR';
        case 0x20: return 'SP';
        // Le backslash est rendu par un nom lisible : `buildAutoTypeMap()`
        // le reconvertit, et cela évite d'échapper des chaînes dans le source.
        case 0x5C: return 'BS';
    }
    // ASCII imprimable : le caractère, avec l'apostrophe échappée.
    if (code >= 0x21 && code <= 0x7E) {
        const c = String.fromCharCode(code);
        return c === "'" ? "\\'" : c;
    }
    return `X${code.toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * Extrait la table d'une ROM.
 *
 * @param {string} chemin Chemin du fichier ROM.
 * @returns {{offset: number, table: Map<string, object>}|null}
 */
function extraire(chemin) {
    if (!existsSync(chemin)) return null;
    const rom = readFileSync(chemin);
    const trouve = localiserTable(rom);
    if (!trouve) return null;
    return { offset: trouve.offset, table: decoderTable(trouve.table) };
}

// ─── Point d'entrée ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const argDe = (nom) => {
    const a = args.find((x) => x.startsWith(`--${nom}=`));
    return a ? a.split('=').slice(1).join('=') : undefined;
};

const LANGUES = [
    { code: 'UK', lang: 'english' },
    { code: 'FR', lang: 'french' },
    { code: 'ES', lang: 'spanish' },
];

/** `--source` : n'émet que l'objet de table, prêt à coller dans Keyboard.js. */
const SOURCE_SEULE = args.includes('--source');

const seule = argDe('lang');
const cibles = seule ? LANGUES.filter((l) => l.lang === seule) : LANGUES;
if (cibles.length === 0) {
    console.error(`Langue inconnue : ${seule}`);
    process.exit(1);
}

for (const { code, lang } of cibles) {
    const romForcee = argDe('rom');
    const chemin = romForcee || resolve(ROM_DIR, lang, '464.ROM');
    const resultat = extraire(chemin);

    if (!resultat) {
        console.error(`✗ ${code} — table introuvable dans ${chemin}`);
        continue;
    }

    const parSource = versSource(resultat.table);
    const entrees = Object.keys(parSource).length;

    if (SOURCE_SEULE) {
        // Une ligne de source par ligne de la matrice, comme dans Keyboard.js.
        let groupe = '';
        let ligneCourante = null;
        for (const [cle, libelles] of Object.entries(parSource)) {
            const ligneMatrice = cle.split(':')[0];
            if (ligneCourante === null) ligneCourante = ligneMatrice;
            if (ligneMatrice !== ligneCourante) {
                console.log(`// Ligne ${ligneCourante}`);
                console.log(groupe);
                groupe = '';
                ligneCourante = ligneMatrice;
            }
            groupe += `'${cle}': [${libelles.map((l) => `'${l}'`).join(', ')}], `;
        }
        if (groupe) {
            console.log(`// Ligne ${ligneCourante}`);
            console.log(groupe);
        }
        continue;
    }

    console.log(`\n${'═'.repeat(72)}`);
    console.log(`${code} — ${chemin.replace(RACINE + '/', '')}`);
    console.log(`offset 0x${resultat.offset.toString(16).toUpperCase()} — ${entrees} positions, ${resultat.table.size} caractères`);
    console.log('═'.repeat(72));

    let ligne = '';
    for (const [cle, libelles] of Object.entries(parSource)) {
        const liste = libelles.map((l) => `'${l}'`).join(', ');
        ligne += `'${cle}': [${liste}], `;
        if (ligne.length > 140) { console.log(ligne); ligne = ''; }
    }
    if (ligne) console.log(ligne);
}