"use strict";

/**
 * @module cpc-keyboard-map
 * @description Table de correspondance clavier physique → matrice du CPC.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI CE FICHIER
 * ─────────────────────────────────────────────────────────────────────────────
 * La table était auparavant enterrée dans `Keyboard.js`, sous la forme d'un
 * `Array(256)` indexé par `KeyboardEvent.keyCode`. Deux problèmes :
 *
 *   - `keyCode` est **obsolète**. Il était défini par le layout du *système*
 *     d'exploitation, pas par la position physique de la touche : même valeur
 *     pour « A » sur un clavier US et « Q » sur un clavier français. Il est
 *     de plus figé depuis 2009 et absent de la spécification DOM moderne.
 *   - la table ne pouvait pas être lue sans charger tout `Keyboard.js`, donc
 *     charger la table imposait de charger le module entier.
 *
 * `KeyboardEvent.code` est son remplaçant standard : il décrit la **position
 * physique** de la touche, indépendante du layout. C'est exactement la
 * sémantique que l'ancien `keyCodeMap` avait en pratique — il mappait déjà la
 * position physique, comme le prouve l'échange A↔Q du layout AZERTY. La
 * migration est donc fidèle, et non un changement de comportement.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FORMAT
 * ─────────────────────────────────────────────────────────────────────────────
 * `line` est la ligne 0-9 de la matrice du CPC. `bit` est l'**index** du bit
 * dans cette ligne (0-7), pas son masque : `1 << bit`. Écrire 5 plutôt que 32
 * se lit « bit 5 » et évite de se tromper de poids.
 *
 * Les positions viennent du manuel technique Amstrad CPC 464/664/6128, et ont
 * été dérivées programmatiquement de l'ancienne table pour qu'aucune ne soit
 * perdue ou transposée à la migration.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DISPOSITIONS
 * ─────────────────────────────────────────────────────────────────────────────
 * Le clavier du CPC est un AZERTY : sa position Q contient la touche marquée
 * « A » sur un clavier QWERTY, et inversement. On ne peut donc pas se contenter
 * d'un seul dictionnaire — il en faut un par firmware.
 *
 *   US — QWERTY de référence (firmware anglais)
 *   FR — AZERTY français (firmware français)
 *   ES — QWERTY espagnol (firmware espagnol, Ñ sur Backquote)
 *
 * Seules ces trois dispositions sont exposées : elles correspondent aux ROM
 * firmware fournies. Les utilisateurs germanophones/italophones peuvent
 * sélectionner US, qui reste une disposition physique event.code stable.
 *
 * Pour ajouter une touche : ajouter son KeyboardEvent.code comme clé, puis sa
 * position CPC `{ line: 0..9, bit: 0..7 }`. Le bit est un index, pas un masque.
 * Ajoutez les différences propres à un layout dans son objet ci-dessous ; ne
 * placez une entrée dans CPC_KEY_COMMON que si sa position est identique partout.

 *
 * `CPC_KEY_COMMON` factorise les touches identiques dans les trois
 * dispositions ; chaque layout n'écrit que ses différences. Les touches de
 * modificateur de la main droite (`ShiftRight`, `ControlRight`, `AltRight`)
 * sont ajoutées en fin de fichier, pour toutes les dispositions.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Touches communes aux trois dispositions (69)
// ─────────────────────────────────────────────────────────────────────────────

const CPC_KEY_MAP_DATA = (() => {
const CPC_KEY_COMMON = {

    // ── Ligne 0 — pavé numérique 3/6/9 et flèches ──────────────────────────
    "ArrowUp":       { line: 0, bit: 0 },
    "ArrowRight":    { line: 0, bit: 1 },
    "ArrowDown":     { line: 0, bit: 2 },
    "F9":            { line: 0, bit: 3 },   // F1-F10 = touches 7-0, pour claviers sans pavé
    "Numpad9":       { line: 0, bit: 3 },
    "F6":            { line: 0, bit: 4 },
    "Numpad6":       { line: 0, bit: 4 },
    "Numpad3":       { line: 0, bit: 5 },
    "F3":            { line: 0, bit: 5 },
    "Insert":        { line: 0, bit: 6 },   // touche COPY du CPC
    "NumpadDecimal": { line: 0, bit: 7 },
    "Home":          { line: 0, bit: 7 },   // même position que le pavé (héritage de l'ancienne table)

    // ── Ligne 1 — pavé numérique 7/8/5/1/2/0 ───────────────────────────────
    "ArrowLeft":     { line: 1, bit: 0 },
    "AltLeft":       { line: 1, bit: 1 },   // touche CAPS du CPC
    "F7":            { line: 1, bit: 2 },
    "Numpad7":       { line: 1, bit: 2 },
    "F8":            { line: 1, bit: 3 },
    "Numpad8":       { line: 1, bit: 3 },
    "F5":            { line: 1, bit: 4 },
    "Numpad5":       { line: 1, bit: 4 },
    "F1":            { line: 1, bit: 5 },
    "Numpad1":       { line: 1, bit: 5 },
    "F2":            { line: 1, bit: 6 },
    "Numpad2":       { line: 1, bit: 6 },
    "F10":           { line: 1, bit: 7 },
    "Numpad0":       { line: 1, bit: 7 },

    // ── Ligne 2 — RETURN, CLR, modificateurs, pavé 4 ───────────────────────
    // NB : `BracketLeft` et `BracketRight` ne sont **pas** communs — leur
    // position change en AZERTY, où [ et ] ne sont pas aux mêmes positions qu’en QWERTY.
    "Delete":        { line: 2, bit: 0 },   // touche CLR/HOME du CPC
    "Enter":         { line: 2, bit: 2 },
    "Numpad4":       { line: 2, bit: 4 },
    "F4":            { line: 2, bit: 4 },
    "ShiftLeft":     { line: 2, bit: 5 },
    "ControlLeft":   { line: 2, bit: 7 },

    // ── Lignes 3 à 9 ───────────────────────────────────────────────────────
    "KeyP":          { line: 3, bit: 3 },
    "Period":        { line: 3, bit: 7 },
    "Digit0":        { line: 4, bit: 0 },
    "Digit9":        { line: 4, bit: 1 },
    "KeyO":          { line: 4, bit: 2 },
    "KeyI":          { line: 4, bit: 3 },
    "KeyL":          { line: 4, bit: 4 },
    "KeyK":          { line: 4, bit: 5 },
    "Digit8":        { line: 5, bit: 0 },
    "Digit7":        { line: 5, bit: 1 },
    "KeyU":          { line: 5, bit: 2 },
    "KeyY":          { line: 5, bit: 3 },
    "KeyH":          { line: 5, bit: 4 },
    "KeyJ":          { line: 5, bit: 5 },
    "KeyN":          { line: 5, bit: 6 },
    "Space":         { line: 5, bit: 7 },
    "Digit6":        { line: 6, bit: 0 },
    "Digit5":        { line: 6, bit: 1 },
    "KeyR":          { line: 6, bit: 2 },
    "KeyT":          { line: 6, bit: 3 },
    "KeyG":          { line: 6, bit: 4 },
    "KeyF":          { line: 6, bit: 5 },
    "KeyB":          { line: 6, bit: 6 },
    "KeyV":          { line: 6, bit: 7 },
    "Digit4":        { line: 7, bit: 0 },
    "Digit3":        { line: 7, bit: 1 },
    "KeyE":          { line: 7, bit: 2 },
    "KeyS":          { line: 7, bit: 4 },
    "KeyD":          { line: 7, bit: 5 },
    "KeyC":          { line: 7, bit: 6 },
    "KeyX":          { line: 7, bit: 7 },
    "Digit1":        { line: 8, bit: 0 },
    "Digit2":        { line: 8, bit: 1 },
    "Escape":        { line: 8, bit: 2 },
    "Tab":           { line: 8, bit: 4 },
    "CapsLock":      { line: 8, bit: 6 },
    "Backspace":     { line: 9, bit: 7 },
};

/**
 * Table `KeyboardEvent.code` → position `{ line, bit }` pour chaque firmware.
 * @type {Object.<"US"|"FR"|"ES", Object.<string, {line:number, bit:number}>>}
 */
const CPC_KEYBOARD_MAPS = {

    // ── QWERTY de référence ────────────────────────────────────────────────
    US: Object.assign({}, CPC_KEY_COMMON, {
        "KeyQ":         { line: 8, bit: 3 },
        "KeyA":         { line: 8, bit: 5 },
        "KeyZ":         { line: 8, bit: 7 },
        "KeyW":         { line: 7, bit: 3 },
        "KeyM":         { line: 4, bit: 6 },
        "Equal":        { line: 3, bit: 0 },
        "Minus":        { line: 3, bit: 1 },
        "Backquote":    { line: 3, bit: 2 },
        "Quote":        { line: 3, bit: 4 },
        "Semicolon":    { line: 3, bit: 5 },
        "Slash":        { line: 3, bit: 6 },
        "Comma":        { line: 4, bit: 7 },
        "BracketLeft":  { line: 2, bit: 1 },
        "BracketRight": { line: 2, bit: 3 },
        // La touche `\` est câblée ligne 2, bit 6 en QWERTY, contre 2:1 en
        // AZERTY : elle n'est donc pas factorisée dans le socle commun. Sans
        // cette entrée, AutoType ne pouvait pas taper `\` ni `|`, très utilisés
        // par les RSX.
        "Backslash":    { line: 2, bit: 6 },
    }),

    // ── AZERTY français ────────────────────────────────────────────────────
    // Attention : `KeyZ` occupe ici la position W du CPC, et `KeyW` la position
    // Z — l'inversion est le cœur même de la disposition AZERTY. C'est
    // l'erreur la plus facile à commettre en transposant la table à la main ;
    // le test « AZERTY : A↔Q et Z↔W » la verrouille.
    // A↔Q et Z↔W par rapport au QWERTY : la touche physique « KeyA » occupe la
    // position Q du CPC, et réciproquement. C'est la defining feature de l'AZERTY.
    //
    // Les positions des caractères spéciaux sont celles de la ROM française
    // (scripts/extract-keytrans.mjs), et non des transpositions manuelles.
    // Sur un AZERTY les caractères imprimés diffèrent des positions US :
    // la touche « Minus » porte « - » mais la ROM FR produit « ) » en 3:1,
    // la touche « Backslash » porte « * » mais la ROM FR produit « $ » en 2:6,
    // etc. Le mapping reflète la POSITION PHYSIQUE de la touche, pas le
    // caractère imprimé — c'est ce qui fait que le CPC affiche le caractère
    // produit par la ROM FR et non une approximation.
    FR: Object.assign({}, CPC_KEY_COMMON, {
        "KeyQ":         { line: 8, bit: 5 },
        "KeyA":         { line: 8, bit: 3 },
        "KeyZ":         { line: 7, bit: 3 },
        "KeyW":         { line: 8, bit: 7 },
        "KeyM":         { line: 3, bit: 5 },
        // Caractères spéciaux — event.code = position physique US,
        // position CPC = où la ROM FR produit le caractère pour cette position.
        "Backquote":    { line: 3, bit: 2 },   // ROM FR : ^ en 3:2
        "Quote":        { line: 3, bit: 4 },   // ROM FR : | en 3:4
        "Equal":        { line: 3, bit: 0 },   // ROM FR : - en 3:0
        "Slash":        { line: 3, bit: 6 },   // ROM FR : = en 3:6
        "Semicolon":    { line: 3, bit: 6 },   // ROM FR : = en 3:6 (même touche physique que Slash sur AZERTY pour le caractère =)
        "Minus":        { line: 3, bit: 1 },   // ROM FR : ) en 3:1
        "Comma":        { line: 4, bit: 7 },   // ROM FR : ; en 4:7
        "Backslash":    { line: 2, bit: 6 },   // ROM FR : $ en 2:6
        "BracketLeft":  { line: 2, bit: 1 },   // ROM FR : * en 2:1
        "BracketRight": { line: 2, bit: 3 },   // ROM FR : # en 2:3
        // « AltRight » et « AltGraph » sont la même touche physique côté DOM.
        // L'ancienne table y assignait deux positions différentes, ce qui n'a
        // plus de sens avec `code` : celle de « AltRight » est retenue, l'autre
        // (touche CAPS du CPC) est déjà couverte par « AltLeft ».
        "AltRight":     { line: 5, bit: 0 },
    }),

    // ── QWERTY espagnol ────────────────────────────────────────────────────
    // Comme l'anglais, sauf « : » et « ; » inversés, et « Ñ » sur la touche
    // US « ` » (Backquote).
    ES: Object.assign({}, CPC_KEY_COMMON, {
        "KeyQ":         { line: 8, bit: 3 },
        "KeyA":         { line: 8, bit: 5 },
        "KeyZ":         { line: 8, bit: 7 },
        "KeyW":         { line: 7, bit: 3 },
        "KeyM":         { line: 4, bit: 6 },
        "Equal":        { line: 3, bit: 0 },
        "Minus":        { line: 3, bit: 1 },
        "Backquote":    { line: 3, bit: 4 },   // Ñ
        "Semicolon":    { line: 3, bit: 5 },
        "Slash":        { line: 3, bit: 6 },
        "Comma":        { line: 4, bit: 7 },
        "BracketLeft":  { line: 2, bit: 1 },
        "BracketRight": { line: 2, bit: 3 },
        "Backslash":    { line: 2, bit: 6 },
    }),
};

/**
 * Modificateurs, traités à part du dictionnaire de touches ordinaires.
 *
 * Ils sont listés explicitement parce que leur état doit être connu même
 * quand aucune touche ne les porte dans la matrice : AutoType a besoin de
 * maintenir SHIFT et CTRL pressés pendant qu'il injecte une autre touche, et
 * le relâchement global sur `blur` doit les remettre à zéro.
 *
 * Les versions droites (`ShiftRight`, `ControlRight`) sont des touches
 * distinctes côté DOM et partagent la position CPC de leur homologue gauche —
 * le CPC n'a qu'une touche SHIFT et une touche CTRL.
 *
 * @type {Object.<string, {line:number, bit:number}>}
 */
const CPC_MODIFIER_KEYS = {
    "ShiftLeft":     { line: 2, bit: 5 },
    "ShiftRight":    { line: 2, bit: 5 },
    "ControlLeft":   { line: 2, bit: 7 },
    "ControlRight":  { line: 2, bit: 7 },
    "AltLeft":       { line: 1, bit: 1 },
    "CapsLock":      { line: 8, bit: 6 },
};

/**
 * Noms des modificateurs pour chaque `code` de `CPC_MODIFIER_KEYS`.
 * Les états logiques des modificateurs sont tenus à jour par Keyboard.
 * @type {Object.<string, string>}
 */
const CPC_MODIFIER_NAMES = {
    "ShiftLeft": "shift",     "ShiftRight": "shift",
    "ControlLeft": "ctrl",    "ControlRight": "ctrl",
    "AltLeft": "alt",
    "CapsLock": "capsLock",
};

/** Les trois firmwares gérés, dans l'ordre de la liste du rapport. */
const CPC_LAYOUTS = ["US", "FR", "ES"];

/**
 * Choisit l'une des dispositions disponibles à partir d'une langue BCP 47.
 * Seules les ROM US/FR/ES sont distribuées ; de/it et autres langues prennent
 * donc le layout de référence US. `language` est injectable pour les tests.
 * @param {string} [language] navigator.language par défaut.
 * @returns {"US"|"FR"|"ES"}
 */
function detectLayoutFromNavigatorLanguage(language =
    (typeof navigator !== "undefined" ? navigator.language : "")) {
    const tag = String(language || "").toLowerCase();
    if (/^fr(?:-|$)/.test(tag)) return "FR";
    if (/^es(?:-|$)/.test(tag)) return "ES";
    return "US";
}

/**
 * Complète chaque disposition avec les touches de modificateur de la main
 * droite, absentes de `CPC_KEYBOARD_MAPS` car elles ne figurent ni dans la table
 * commune ni dans les différences de disposition.
 *
 * Le CPC n'a qu'une touche SHIFT et une touche CTRL : les deux versions
 * physiques partagent la position, ce qui est correct — les pressions
 * concurrentes se combinent, comme sur le clavier réel.
 *
 * `AltRight` n'y figure **pas** : en disposition française, cette touche est
 * mappée sur la touche 8 du CPC (héritage de l'ancienne table, qui s'en
 * servait pour produire « ! »). Elle n'y est donc pas un modificateur, et
 * `modifiers.alt` n'est pas suivi par son intermédiaire. Ce comportement est
 * conservé tel quel plutôt que corrigé ici : le modifier changerait la
 * disposition française, ce qui sort du cadre de cette refonte.
 */
for (const _layout of CPC_LAYOUTS) {
    for (const [code, pos] of Object.entries(CPC_MODIFIER_KEYS)) {
        if (CPC_KEYBOARD_MAPS[_layout][code] === undefined) {
            CPC_KEYBOARD_MAPS[_layout][code] = { line: pos.line, bit: pos.bit };
        }
    }
}

return Object.freeze({
    CPC_KEY_COMMON,
    CPC_KEYBOARD_MAPS,
    CPC_MODIFIER_KEYS,
    CPC_MODIFIER_NAMES,
    CPC_LAYOUTS,
    detectLayoutFromNavigatorLanguage,
});
})();
