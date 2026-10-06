/**
 * JS CPC Module: BasicTokenizer  (ES6)
 * ─────────────────────────────────────────────────────────────────────────────
 * Convertit un listing BASIC Locomotive (ASCII) en programme TOKENISÉ, tel que
 * le BASIC du CPC l'attend en mémoire à partir de &0170, et sait l'y écrire.
 *
 * ─── Pourquoi tokeniser côté PC ──────────────────────────────────────────────
 * Le mode « Auto-type » frappe le listing caractère par caractère : c'est le
 * firmware qui tokenise, mais au rythme de la matrice clavier — plusieurs
 * secondes pour un programme moyen. Écrire directement la forme tokenisée
 * revient à ce que fait un chargeur de cassette, en supprimant l'attente.
 *
 * ─── Organisation de la mémoire BASIC ────────────────────────────────────────
 *   0040-016F  zone d'entrée (lignes saisies, non tokenisées)
 *   0170-…     PROGRAMME (tokenisé) → variables → tableaux → espace libre
 *              → chaînes, qui croissent vers le bas depuis HIMEM
 *
 * Le programme se termine par une longueur de ligne nulle (00 00).
 *
 * ─── Pointeurs à remettre à jour ─────────────────────────────────────────────
 * BASIC ne relit pas la mémoire pour savoir où s'arrête le programme : il
 * s'appuie sur quatre pointeurs, qui doivent tous valoir « &0170 + taille ».
 *
 *   BASIC 1.1 (664, 6128, 6128+) : &AE66 &AE68 &AE6A &AE6C
 *   BASIC 1.0 (464, 464+)        : &AE83 &AE85 &AE87 &AE89
 *
 * (Amstrad CPC Firmware Manual, « Use of memory by the OS » ; mêmes adresses que
 * celles utilisées par les chargeurs BASIC en assembleur.)
 *
 * ─── Format d'une ligne ──────────────────────────────────────────────────────
 *   [longueur 2o LE] [numéro 2o LE] [tokens + ASCII + chaînes] [00]
 *   longueur = 5 + nombre d'octets du corps
 *
 * Aucune dépendance : le module ne connaît ni le bus ni le DOM. `injecter()`
 * reçoit la fonction d'écriture en paramètre, ce qui le rend testable seul.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const BasicTokenizer = (() => {

    /** Adresse du premier octet du programme BASIC. */
    const ADRESSE_PROGRAMME = 0x0170;

    /**
     * Dernière adresse utilisable par le programme, par version de firmware.
     * Au-delà, on écraserait la zone de travail du BASIC (&AC00…).
     */
    const LIMITE_BASIC_1_0 = 0xae85;
    const LIMITE_BASIC_1_1 = 0xae68;

    // ─────────────────────────────────────────────────────────────────────────
    // Tables de tokens
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Mots-clés sans préfixe (0x80-0xFF). Les formes composées qui retombent sur
     * le même token que leur premier mot (LINE INPUT, CHAIN MERGE, EVERY GOSUB,
     * WINDOW SWAP, GRAPHICS PAPER…) n'ont pas besoin d'entrée dédiée.
     * @type {Object<string, number>}
     */
    const MOTS = {
        after: 0x80, auto: 0x81, border: 0x82, call: 0x83, cat: 0x84,
        chain: 0x85, clear: 0x86, clg: 0x87, closein: 0x88, closeout: 0x89,
        cls: 0x8a, cont: 0x8b, data: 0x8c, def: 0x8d, defint: 0x8e,
        defreal: 0x8f, defstr: 0x90, deg: 0x91, delete: 0x92, dim: 0x93,
        draw: 0x94, drawr: 0x95, edit: 0x96, else: 0x97, end: 0x98,
        ent: 0x99, env: 0x9a, erase: 0x9b, error: 0x9c, every: 0x9d,
        for: 0x9e, gosub: 0x9f, goto: 0xa0, if: 0xa1, ink: 0xa2,
        input: 0xa3, key: 0xa4, let: 0xa5, line: 0xa6, list: 0xa7,
        load: 0xa8, locate: 0xa9, memory: 0xaa, merge: 0xab, mid$: 0xac,
        mode: 0xad, move: 0xae, mover: 0xaf, next: 0xb0, new: 0xb1,
        on: 0xb2, openin: 0xb6, openout: 0xb7, origin: 0xb8, out: 0xb9,
        paper: 0xba, pen: 0xbb, plot: 0xbc, plotr: 0xbd, poke: 0xbe,
        print: 0xbf, rad: 0xc1, randomize: 0xc2, read: 0xc3, release: 0xc4,
        rem: 0xc5, renum: 0xc6, restore: 0xc7, resume: 0xc8, return: 0xc9,
        run: 0xca, save: 0xcb, sound: 0xcc, speed: 0xcd, stop: 0xce,
        symbol: 0xcf, tag: 0xd0, tagoff: 0xd1, troff: 0xd2, tron: 0xd3,
        wait: 0xd4, wend: 0xd5, while: 0xd6, width: 0xd7, window: 0xd8,
        write: 0xd9, zone: 0xda, di: 0xdb, ei: 0xdc, fill: 0xdd,
        graphics: 0xde, mask: 0xdf, frame: 0xe0, cursor: 0xe1, erl: 0xe3,
        fn: 0xe4, spc: 0xe5, step: 0xe6, swap: 0xe7, tab: 0xea,
        then: 0xeb, to: 0xec, using: 0xed, and: 0xfa, mod: 0xfb,
        or: 0xfc, xor: 0xfd, not: 0xfe,
    };

    /**
     * Fonctions, préfixées par 0xFF. Le nom porte son éventuel « $ ».
     * @type {Object<string, number>}
     */
    const FONCTIONS = {
        abs: 0x00, asc: 0x01, atn: 0x02, "chr$": 0x03, cint: 0x04,
        cos: 0x05, creal: 0x06, exp: 0x07, fix: 0x08, fre: 0x09,
        inkey: 0x0a, inp: 0x0b, int: 0x0c, joy: 0x0d, len: 0x0e,
        log: 0x0f, log10: 0x10, "lower$": 0x11, peek: 0x12, remain: 0x13,
        sgn: 0x14, sin: 0x15, "space$": 0x16, sq: 0x17, sqr: 0x18,
        "str$": 0x19, tan: 0x1a, unt: 0x1b, "upper$": 0x1c, val: 0x1d,
        eof: 0x40, err: 0x41, himem: 0x42, "inkey$": 0x43, pi: 0x44,
        rnd: 0x45, time: 0x46, xpos: 0x47, ypos: 0x48, derr: 0x49,
        "bin$": 0x71, "dec$": 0x72, "hex$": 0x73, instr: 0x74, "left$": 0x75,
        max: 0x76, min: 0x77, pos: 0x78, "right$": 0x79, round: 0x7a,
        "string$": 0x7b, test: 0x7c, testr: 0x7d, "copychr$": 0x7e, vpos: 0x7f,
    };

    /**
     * Formes composées dont le token DIFFÈRE de celui du premier mot.
     * (Les autres composées — LINE INPUT, CHAIN MERGE… — partagent le token de
     * leur premier mot et n'ont donc pas besoin d'être listées ici.)
     * @type {Object<string, number>}
     */
    const COMPOSES = {
        "on error goto": 0xb4,
        "on error go to": 0xb4,
        "on break": 0xb3,
        "on sq": 0xb5,
        "go sub": 0x9f,
        "go to": 0xa0,
    };

    /**
     * Mots-clés qui ouvrent une zone recopiée telle quelle, sans tokenisation,
     * avec le caractère qui la referme :
     *
     *   REM  → « eol » : tout le reste de la ligne. Un « : » y est du texte de
     *          commentaire, pas un séparateur ;
     *   DATA → « : » : la liste des données s'arrête au prochain séparateur
     *          d'instruction. C'est indispensable, car « DATA 0,0 :REM Salle 1 »
     *          est un idiome courant et un DATA peut, en BASIC 1.1, être suivi
     *          d'autres instructions. Avaler le « : » dans les données casse la
     *          ligne (« Syntax error » sur le CPC).
     * @type {Object<string, string>}
     */
    const BRUTS = { rem: "eol", data: ":" };

    /**
     * Liste unique de recherche, triée du mot le plus long au plus court : c'est
     * ce tri qui fait gagner INKEY$ sur INKEY, MODE sur MOD, STRING$ sur STR$.
     * @type {Array<{mot: string, octets: number[], brut: boolean, separateur: boolean}>}
     */
    const LISTE = [];

    Object.keys(COMPOSES).forEach((mot) => {
        LISTE.push({ mot: mot, octets: [COMPOSES[mot]], brut: false, separateur: false });
    });
    Object.keys(MOTS).forEach((mot) => {
        LISTE.push({
            mot: mot,
            octets: [MOTS[mot]],
            brut: BRUTS[mot] || null,
            separateur: false,
        });
    });
    Object.keys(FONCTIONS).forEach((mot) => {
        LISTE.push({ mot: mot, octets: [0xff, FONCTIONS[mot]], brut: false, separateur: false });
    });

    // ELSE est stocké précédé d'un séparateur d'instruction (01) : le BASIC
    // détecte la fin de la branche THEN en cherchant cette séquence.
    LISTE.forEach((entree) => {
        if (entree.mot === "else") entree.separateur = true;
    });

    LISTE.sort((a, b) => b.mot.length - a.mot.length);

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Vrai pour les lettres A-Z / a-z.
     * @param {number} code Code ASCII.
     * @returns {boolean}
     */
    const estLettre = (code) => (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);

    /**
     * Vrai pour les lettres et les chiffres (suite d'un nom de variable).
     * @param {number} code Code ASCII.
     * @returns {boolean}
     */
    const estAlphanum = (code) => estLettre(code) || (code >= 0x30 && code <= 0x39);

    /**
     * Un mot-clé ne se termine que sur une frontière : « TOTAL » ne doit pas
     * donner « TO » + « TAL ». Les chiffres restent admis juste après
     * (« GOTO100 » est valide).
     * @param {string} minuscule Ligne en minuscules.
     * @param {number} index     Index après le mot-clé.
     * @returns {boolean}
     */
    const frontiere = (minuscule, index) =>
        index >= minuscule.length || !estLettre(minuscule.charCodeAt(index));

    /**
     * Cherche le mot-clé le plus long reconnu à la position donnée.
     * Les tables sont en minuscules : la comparaison se fait donc sur la ligne
     * mise en minuscules.
     * @param {string} minuscule Ligne en minuscules.
     * @param {number} i         Position de départ.
     * @returns {{entree: object, longueur: number}|null}
     */
    function chercherMot(minuscule, i) {
        for (let k = 0; k < LISTE.length; k++) {
            const entree = LISTE[k];
            if (minuscule.startsWith(entree.mot, i) && frontiere(minuscule, i + entree.mot.length)) {
                return { entree: entree, longueur: entree.mot.length };
            }
        }
        return null;
    }

    /**
     * Encode un réel au format BASIC.
     *
     * Disposition : mantisse sur 4 octets (octet 3 : bit 7 = signe, bits 6-0 =
     * mantisse 30-24) puis exposant biaisé de 128. La valeur vaut 1,xxxx × 2^e ;
     * le « 1 » de tête est implicite et n'est donc pas stocké.
     *
     * Le biais de 128 est celui de la documentation du format — et c'est le seul
     * qui rende 0,5 cohérent : avec 129, 0,5 tomberait dans les exposants positifs
     * alors que son exposant mathématique vaut -1.
     *
     * @param {number} nombre Valeur à encoder.
     * @returns {number[]} 5 octets.
     */
    function octetsFlottant(nombre) {
        let signe = 0;
        let valeur = nombre;
        let mantisse = 0;
        let exposant = 0;

        if (valeur !== 0) {
            if (valeur < 0) { signe = 0x80; valeur = -valeur; }
            exposant = Math.floor(Math.log(valeur) / Math.LN2);
            let m = valeur / Math.pow(2, exposant);
            if (m >= 2) { exposant += 1; m /= 2; }
            if (m < 1) { exposant -= 1; m *= 2; }

            let bits = Math.round((m - 1) * 2147483648);
            // Un arrondi peut faire grimper la mantisse à 2,0 : on renormalise.
            if (bits >= 2147483648) { bits = 0; exposant += 1; }
            mantisse = bits;
            exposant += 128;
        }

        const m = mantisse >>> 0;
        return [
            m & 0xff,
            (m >>> 8) & 0xff,
            (m >>> 16) & 0xff,
            ((m >>> 24) & 0x7f) | signe,
            exposant & 0xff,
        ];
    }

    /**
     * Lit un nombre à partir de `i` et renvoie ses octets tokenisés.
     *
     * Règles du tokeniseur Locomotive :
     *   0 à 9          → un seul octet (0x0E + n)
     *   10 à 255       → 0x19 suivi de la valeur
     *   jusqu'à 32767  → 0x1A suivi de la valeur sur 2 octets
     *   sinon (réels)  → 0x1F suivi du réel sur 5 octets
     * Binaire « &X… » → 0x1B ; hexadécimal « &H… » ou « &… » → 0x1C.
     *
     * @param {string} texte Ligne source.
     * @param {number} i     Position de départ.
     * @returns {{octets: number[], suivant: number}}
     */
    function lireNombre(texte, i) {
        const n = texte.length;

        if (texte[i] === "&") {
            let j = i + 1;
            let base = 16;
            let token = 0x1c;
            const lettre = j < n ? texte[j].toUpperCase() : "";
            if (lettre === "X") { base = 2; token = 0x1b; j++; }
            else if (lettre === "H") { j++; }
            const debut = j;
            const motif = base === 2 ? /[01]/ : /[0-9A-Fa-f]/;
            while (j < n && motif.test(texte[j])) j++;
            const valeur = (debut === j ? 0 : parseInt(texte.slice(debut, j), base)) & 0xffff;
            return { octets: [token, valeur & 0xff, (valeur >>> 8) & 0xff], suivant: j };
        }

        let j = i;
        let point = false;
        while (j < n) {
            const c = texte[j];
            if (c >= "0" && c <= "9") { j++; continue; }
            if (c === "." && !point) { point = true; j++; continue; }
            break;
        }

        const valeur = parseFloat(texte.slice(i, j));
        if (!point && Number.isInteger(valeur) && valeur >= 0) {
            if (valeur <= 9) return { octets: [0x0e + valeur], suivant: j };
            if (valeur <= 0xff) return { octets: [0x19, valeur], suivant: j };
            if (valeur <= 0x7fff) {
                return { octets: [0x1a, valeur & 0xff, (valeur >>> 8) & 0xff], suivant: j };
            }
        }
        return { octets: [0x1f].concat(octetsFlottant(valeur)), suivant: j };
    }

    /**
     * Lit un nom de variable et le tokenise.
     *
     * Un nom est stocké : [token de type] [offset 16 bits, nul ici]
     * [lettres, dernier caractère avec le bit 7 posé]. Le type vient du suffixe
     * (« % », « $ », « ! »), l'absence de suffixe donnant le type « quelconque ».
     *
     * @param {string} texte Ligne source.
     * @param {number} i     Position de départ (une lettre).
     * @returns {{octets: number[], suivant: number}}
     */
    function lireVariable(texte, i) {
        const n = texte.length;
        let j = i;
        while (j < n && estAlphanum(texte.charCodeAt(j))) j++;

        let suffixe = "";
        if (j < n && (texte[j] === "$" || texte[j] === "%" || texte[j] === "!")) {
            suffixe = texte[j];
            j++;
        }

        let type = 0x0d;
        if (suffixe === "$") type = 0x03;
        else if (suffixe === "%") type = 0x02;
        else if (suffixe === "!") type = 0x04;

        const nom = texte.slice(i, j - (suffixe ? 1 : 0));
        const octets = [type, 0x00, 0x00];
        for (let k = 0; k < nom.length; k++) {
            const code = nom.charCodeAt(k) & 0x7f;
            octets.push(k === nom.length - 1 ? (code | 0x80) : code);
        }
        return { octets: octets, suivant: j };
    }

    /** Opérateurs d'un seul caractère, hors comparaisons. */
    const OPERATEURS = { "+": 0xf4, "-": 0xf5, "*": 0xf6, "/": 0xf7, "^": 0xf8, "\\": 0xf9, ":": 0x01 };

    /**
     * Mots-clés après lesquels un entier nu est un NUMÉRO DE LIGNE et non une
     * constante : « GOTO 100 » donne le token 0x1E suivi de 100, pas la constante
     * 0x19 0x64. Sans cela, GOTO et GOSUB — omniprésents — seraient refusés par
     * l'interpréteur, qui attend là le type « numéro de ligne ».
     * Indexé par le dernier octet du token.
     * @type {Object<number, boolean>}
     */
    const ATTEND_UN_NUMERO = {
        0x92: true, // DELETE
        0x97: true, // ELSE (branche « ELSE 200 »)
        0x9f: true, // GOSUB
        0xa0: true, // GOTO
        0xa7: true, // LIST
        0xc6: true, // RENUM
        0xc7: true, // RESTORE
        0xc8: true, // RESUME
        0xca: true, // RUN
        0xeb: true, // THEN
    };

    /**
     * Recopie une zone non tokenisée (commentaire ou données) et renvoie la
     * position où elle se termine.
     *
     * `arret` est le caractère qui referme la zone ; la valeur « eol » (qui ne
     * peut égaler aucun caractère) signifie « jusqu'à la fin de ligne ». Un
     * caractère d'arrêt rencontré DANS une chaîne entre guillemets est inerte :
     * « DATA "a:b" » garde bien son deux-points.
     *
     * @param {string}   texte  Ligne source.
     * @param {number}   i      Position de départ.
     * @param {string}   arret  Caractère d'arrêt, ou « eol ».
     * @param {number[]} sortie Octets déjà produits, à compléter.
     * @returns {number} Position après la zone.
     */
    function copierBrut(texte, i, arret, sortie) {
        const n = texte.length;
        while (i < n && texte[i] !== arret) {
            const c = texte[i];
            sortie.push(c.charCodeAt(0) & 0xff);
            i++;
            if (c === '"') {
                while (i < n && texte[i] !== '"') { sortie.push(texte.charCodeAt(i) & 0xff); i++; }
                if (i < n) { sortie.push(0x22); i++; }
            }
        }
        return i;
    }

    /**
     * Tokenise le corps d'une ligne (sans son numéro).
     * @param {string} texte Corps de la ligne.
     * @returns {number[]} Octets tokenisés.
     */
    function tokeniserCorps(texte) {
        const sortie = [];
        const minuscule = texte.toLowerCase();
        const n = texte.length;
        let i = 0;
        // Vrai quand le dernier mot-clé émis introduit un numéro de ligne.
        let attendNumero = false;

        while (i < n) {
            const ch = texte[i];
            const code = texte.charCodeAt(i);
            // Un mot-clé vaut pour le jeton suivant tant qu'aucun autre jeton
            // n'est émis : une espace ne rompt pas le contexte.
            const attendait = attendNumero;
            if (code !== 0x20) attendNumero = false;

            // Chaîne littérale : les guillemets font partie du flux, le contenu
            // est recopié tel quel (aucun mot-clé n'y est reconnu).
            if (ch === '"') {
                sortie.push(0x22);
                i++;
                while (i < n && texte[i] !== '"') { sortie.push(texte.charCodeAt(i) & 0xff); i++; }
                if (i < n) { sortie.push(0x22); i++; }
                continue;
            }

            // Commentaire par apostrophe : même office que REM, mais précédé d'un
            // séparateur d'instruction comme ELSE.
            if (ch === "'") {
                sortie.push(0x01, 0xc0);
                i++;
                while (i < n) { sortie.push(texte.charCodeAt(i) & 0xff); i++; }
                break;
            }

            // RSX : « | » puis un octet d'offset nul, puis le nom (dernier
            // caractère avec le bit 7 posé).
            if (ch === "|") {
                sortie.push(0x7c, 0x00);
                i++;
                const debut = i;
                while (i < n && estAlphanum(texte.charCodeAt(i))) i++;
                const nom = texte.slice(debut, i).toUpperCase();
                for (let k = 0; k < nom.length; k++) {
                    const c = nom.charCodeAt(k) & 0x7f;
                    sortie.push(k === nom.length - 1 ? (c | 0x80) : c);
                }
                if (nom.length === 0) sortie.push(0x80);
                continue;
            }

            // Nombre (décimal, ou binaire / hexadécimal préfixé par « & »).
            if ((code >= 0x30 && code <= 0x39) || ch === "&") {
                if (attendait && code >= 0x30 && code <= 0x39) {
                    let fin = i;
                    while (fin < n && texte.charCodeAt(fin) >= 0x30 && texte.charCodeAt(fin) <= 0x39) fin++;
                    const numero = parseInt(texte.slice(i, fin), 10);
                    if (numero >= 1 && numero <= 65535) {
                        sortie.push(0x1e, numero & 0xff, (numero >>> 8) & 0xff);
                        i = fin;
                        continue;
                    }
                }
                const nombre = lireNombre(texte, i);
                for (let k = 0; k < nombre.octets.length; k++) sortie.push(nombre.octets[k]);
                i = nombre.suivant;
                continue;
            }

            // Mot : mot-clé reconnu en priorité, sinon nom de variable. Le nom
            // d'une tableau ou d'une fonction (suivi de « ( ») est tokenisé par
            // la suite de la boucle, ce qui produit bien ( arguments ).
            if (estLettre(code)) {
                const trouve = chercherMot(minuscule, i);
                if (trouve) {
                    const entree = trouve.entree;
                    if (entree.separateur) sortie.push(0x01);
                    for (let k = 0; k < entree.octets.length; k++) sortie.push(entree.octets[k]);
                    i += trouve.longueur;
                    attendNumero = ATTEND_UN_NUMERO[entree.octets[entree.octets.length - 1]] === true;
                    if (entree.brut) {
                        i = copierBrut(texte, i, entree.brut, sortie);
                    }
                    continue;
                }
                const variable = lireVariable(texte, i);
                for (let k = 0; k < variable.octets.length; k++) sortie.push(variable.octets[k]);
                i = variable.suivant;
                continue;
            }

            // Comparaisons, y compris les formes inversées acceptées par le BASIC.
            if (ch === ">" || ch === "<" || ch === "=") {
                const deux = texte.substr(i, 2);
                if (deux === ">=" || deux === "=>") { sortie.push(0xf0); i += 2; continue; }
                if (deux === "<=" || deux === "=<") { sortie.push(0xf3); i += 2; continue; }
                if (deux === "<>") { sortie.push(0xf2); i += 2; continue; }
                sortie.push(ch === ">" ? 0xee : (ch === "<" ? 0xf1 : 0xef));
                i++;
                continue;
            }

            if (Object.prototype.hasOwnProperty.call(OPERATEURS, ch)) {
                sortie.push(OPERATEURS[ch]);
                i++;
                continue;
            }

            // Espaces, « ; », « # », parenthèses… : déjà leur propre code ASCII.
            sortie.push(code & 0xff);
            i++;
        }

        return sortie;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // API
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Tokenise un listing BASIC complet.
     *
     * Chaque ligne doit commencer par son numéro ; un espace suit le numéro et
     * n'est pas conservé (comportement du BASIC : « 10 PRINT » donne PRINT en
     * premier token, pas une espace).
     *
     * @param {string} source Listing en ASCII, lignes séparées par LF ou CRLF.
     * @returns {{octets: Uint8Array, lignes: number, erreurs: Array<{ligne: number, message: string}>}}
     */
    function tokeniser(source) {
        const erreurs = [];
        const lignes = [];
        const brut = String(source == null ? "" : source).replace(/\r\n?/g, "\n").split("\n");

        for (let index = 0; index < brut.length; index++) {
            const texte = brut[index];
            if (texte.trim() === "") continue;

            const trouve = /^\s*(\d+)\s?(.*)$/.exec(texte);
            if (!trouve) {
                erreurs.push({
                    ligne: index + 1,
                    message: "Numéro de ligne manquant",
                });
                continue;
            }

            const numero = parseInt(trouve[1], 10);
            if (numero < 1 || numero > 65535) {
                erreurs.push({
                    ligne: index + 1,
                    message: "Numéro de ligne hors bornes (1-65535)",
                });
                continue;
            }

            const corps = tokeniserCorps(trouve[2]);
            const taille = corps.length + 5;
            const octets = [
                taille & 0xff, (taille >>> 8) & 0xff,
                numero & 0xff, (numero >>> 8) & 0xff,
            ].concat(corps);
            octets.push(0x00);
            lignes.push(octets);
        }

        const total = [];
        for (let l = 0; l < lignes.length; l++) {
            for (let o = 0; o < lignes[l].length; o++) total.push(lignes[l][o]);
        }
        total.push(0x00, 0x00); // fin de programme : longueur de ligne nulle

        return { octets: Uint8Array.from(total), lignes: lignes.length, erreurs: erreurs };
    }

    /**
     * Adresses des quatre pointeurs BASIC pour un type de machine donné.
     * @param {number} machineType `Machine_Type` de l'émulateur.
     * @returns {number[]} Quatre adresses.
     */
    function pointeursPour(machineType) {
        // 0 = 464, 5 = 464+ (BASIC 1.0) ; 1 = 664, 2 = 6128, 4 = 6128+ (BASIC 1.1).
        return (machineType === 0 || machineType === 5)
            ? [0xae83, 0xae85, 0xae87, 0xae89]
            : [0xae66, 0xae68, 0xae6a, 0xae6c];
    }

    /**
     * Écrit un programme BASIC tokenisé en mémoire et met à jour les pointeurs.
     *
     * ATTENTION : le programme remplace intégralement celui présent en mémoire
     * (et ses variables) — c'est le rôle de l'appelant de prévenir l'utilisateur.
     *
     * @param {string}   source      Listing ASCII.
     * @param {number}   machineType `Machine_Type` de l'émulateur.
     * @param {Function} ecrire      `(adresse, valeur) => void`, écriture 8 bits.
     * @returns {{ok: boolean, erreurs: Array, lignes: number, octets: number, adresseFin: number}}
     */
    function injecter(source, machineType, ecrire) {
        const resultat = tokeniser(source);
        if (resultat.erreurs.length > 0) {
            return {
                ok: false, erreurs: resultat.erreurs, lignes: 0, octets: 0, adresseFin: 0,
            };
        }

        const basic10 = machineType === 0 || machineType === 5;
        const limite = basic10 ? LIMITE_BASIC_1_0 : LIMITE_BASIC_1_1;
        const adresseFin = ADRESSE_PROGRAMME + resultat.octets.length;

        if (adresseFin > limite) {
            return {
                ok: false,
                erreurs: [{
                    ligne: 0,
                    message: "Programme trop volumineux (" + resultat.octets.length
                        + " octets, maximum " + (limite - ADRESSE_PROGRAMME) + ")",
                }],
                lignes: resultat.lignes, octets: resultat.octets.length, adresseFin: 0,
            };
        }

        if (typeof ecrire !== "function") {
            return {
                ok: false,
                erreurs: [{ ligne: 0, message: "Aucune fonction d'écriture mémoire" }],
                lignes: 0, octets: 0, adresseFin: 0,
            };
        }

        for (let k = 0; k < resultat.octets.length; k++) {
            ecrire(ADRESSE_PROGRAMME + k, resultat.octets[k]);
        }

        // BASIC ne s'arrête pas à la marque de fin : il lui faut les quatre
        // pointeurs alignés sur la fin du programme, sinon RUN part sur les
        // restes de l'ancien programme.
        const pointeurs = pointeursPour(machineType);
        for (let p = 0; p < pointeurs.length; p++) {
            ecrire(pointeurs[p], adresseFin & 0xff);
            ecrire(pointeurs[p] + 1, (adresseFin >>> 8) & 0xff);
        }

        return {
            ok: true,
            erreurs: [],
            lignes: resultat.lignes,
            octets: resultat.octets.length,
            adresseFin: adresseFin,
        };
    }

    return {
        ADRESSE_PROGRAMME: ADRESSE_PROGRAMME,
        tokeniser: tokeniser,
        pointeursPour: pointeursPour,
        injecter: injecter,
    };
})();
