/**
 * @file        404.js
 * @description Page d'erreur 404 — Affichage de l'URL erronée,
 *              animation typewriter dans le faux écran CPC et
 *              année dynamique du footer.
 * @author      Thierry MAIGNAN
 * @project     JS CPC V2 — L'Amstrad dans votre Navigateur
 */

'use strict';

/* ── Année dynamique du footer ──────────────────────────────── */
document.getElementById('footer-year').textContent = new Date().getFullYear();

/* ── Affichage de l'URL erronée ─────────────────────────────── */
var path = window.location.pathname;
document.getElementById('bad-url').textContent = path || '/???';

/* ─────────────────────────────────────────────────────────────
   Animation typewriter — Saisie du chemin dans le prompt CPC
   Affiche le pathname caractère par caractère, style terminal.
   ───────────────────────────────────────────────────────────── */
(function typewriterPath() {
    var text  = path.length > 30 ? path.slice(-30) : path; // max 30 caractères
    var el    = document.getElementById('typed-path');
    var i     = 0;

    el.textContent = '';

    var timer = setInterval(function () {
        if (i >= text.length) { clearInterval(timer); return; }
        el.textContent += text[i++];
    }, 55);
}());
