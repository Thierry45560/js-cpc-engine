/**
 * @file        index.js
 * @description Script de la page d'accueil — Année dynamique du footer
 *              et citation aléatoire CPC/Z80/Amstrad.
 * @author      Thierry MAIGNAN
 * @project     JS CPC V2 — L'Amstrad dans votre Navigateur
 */

'use strict';

/* ── Année dynamique du footer ──────────────────────────────── */
document.getElementById('footer-year').textContent = new Date().getFullYear();

/* ─────────────────────────────────────────────────────────────
   50 citations aléatoires CPC / Z80 / Amstrad
   ───────────────────────────────────────────────────────────── */
var PHRASES = [
    '10 PRINT "HELLO, WORLD!" : GOTO 10',
    'RUN"BATMAN.BAS',
    'Le Z80 possède 158 instructions — l\'8080 n\'en avait que 78.',
    'LOAD""',
    'Alan Sugar a vendu ses premiers autoradios à 14 ans depuis son marché.',
    'MODE 0 : 160x200 pixels, 16 couleurs simultanées.',
    'MODE 1 : 320x200 pixels, 4 couleurs simultanées.',
    'MODE 2 : 640x200 pixels, 2 couleurs simultanées.',
    'Le CPC 6128 possède exactement 65 536 octets de RAM utilisateur.',
    'MOVE 200,200 : DRAW 300,300',
    'Le registre alternatif AF\' est invisible mais sauve des cycles.',
    'PRINT HEX$(65535) : \' Résultat : FFFF',
    'DIM A(10) : FOR I=1 TO 10 : A(I)=I*I : NEXT I',
    'La puce AY-3-8912 du CPC génère 3 canaux sonores + 3 canaux bruit.',
    'SOUND 1,200,100,15',
    'Le CPC 464 est sorti en France le 1er juin 1984.',
    'MERGE"BASIC.BAS',
    'Le CPC+ intègre un ASIC capable de gérer des sprites matériels.',
    'INK 0,0 : INK 1,26 : PAPER 0 : PEN 1',
    'Plus de 3 millions de CPC vendus en Europe entre 1984 et 1990.',
    'CALL &BC0E : \' Appel ROM BASIC — lance une commande système.',
    'Le Z80 peut adresser 64 Ko de mémoire directement (bus 16 bits).',
    'Amstrad a racheté Sinclair Research en 1986 pour 5 millions de livres.',
    'POKE &C000, 85 : PEEK(&C000) retourne 85.',
    'Le CPC génère une interruption toutes les 52 lignes de balayage.',
    'OPENIN"DATA.DAT" : LINE INPUT#9, L$ : CLOSEIN',
    'La fréquence d\'horloge du Z80 dans le CPC est de 4 MHz exactement.',
    'BORDER 26 : \' Change la couleur du bord en vert.',
    'Le CPC 6128 dispose de deux banques RAM de 64 Ko commutables.',
    'REM -- JS CPC V2 : 100% JavaScript, 0 plugin requis.',
    'IX et IY sont les registres d\'index 16 bits exclusifs au Z80.',
    'CHAIN MERGE"PART2.BAS",1000',
    'Le format DSK est un standard d\'image de disquette 3 pouces CPC.',
    'SPEED KEY 50,30 : \' Répétition clavier rapide.',
    'Le CRTC (6845) contrôle la génération vidéo du CPC frame par frame.',
    'CLEAR : \' Réinitialise toutes les variables BASIC.',
    'Amstrad a vendu 1 million de CPC 464 en seulement 6 mois.',
    'RESUME NEXT : \' Reprend l\'exécution après une erreur.',
    'Le bus Z80 est cadencé par le CRTC — le CPU est suspendu pendant l\'accès vidéo.',
    'AFTER 50,1 GOSUB 1000 : \' Timer software CPC BASIC.',
    'La palette complète du CPC propose 27 couleurs uniques.',
    'DEFINT A-Z : \' Force tous les entiers — BASIC plus rapide.',
    'Le CPC 6128 Plus introduit 4096 couleurs via son ASIC.',
    'TAG : TAGOFF : \' Mode texte graphique du CPC.',
    'Le Z80 exécute en moyenne 1 million d\'instructions par seconde à 4 MHz.',
    'SYMBOL AFTER 240 : \' Redéfinit les caractères utilisateur.',
    'Alan Sugar est devenu Lord Sugar par décret royal en 2009.',
    'EVERY 100,2 GOSUB 500 : \' Interruption périodique BASIC.',
    'Le GX4000 est la seule console de jeux produite par Amstrad (1990).',
    'DRAW TO ANGLE 90,100 : \' Tracé relatif en mode Logo.'
];

/**
 * Affiche une citation aléatoire dans le bloc "Le CPC a la parole"
 * avec une transition d'opacité.
 */
function showRandomPrompt() {
    var idx  = Math.floor(Math.random() * PHRASES.length);
    var text = PHRASES[idx];
    var el   = document.getElementById('prompt-content');

    el.style.opacity = 0;
    setTimeout(function () {
        el.textContent      = text;
        el.style.transition = 'opacity 0.4s ease';
        el.style.opacity    = 1;
    }, 150);
}

/* ── Affichage initial ───────────────────────────────────────── */
showRandomPrompt();
