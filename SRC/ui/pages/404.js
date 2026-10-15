/**
 * @file        404.js
 * @description 404 error page: shows the wrong URL, runs a typewriter animation
 *              in the fake CPC screen and sets the footer year.
 * @author      Thierry MAIGNAN
 * @project     JS CPC V2 — Amstrad in your browser
 */

'use strict';

/* Dynamic footer year */
document.getElementById('footer-year').textContent = new Date().getFullYear();

/* Show the wrong URL */
var path = window.location.pathname;
document.getElementById('bad-url').textContent = path || '/???';

/* Typewriter animation: types the path into the CPC prompt, character by
   character, terminal style. */
(function typewriterPath() {
    var text  = path.length > 30 ? path.slice(-30) : path; // max 30 characters
    var el    = document.getElementById('typed-path');
    var i     = 0;

    el.textContent = '';

    var timer = setInterval(function () {
        if (i >= text.length) { clearInterval(timer); return; }
        el.textContent += text[i++];
    }, 55);
}());
