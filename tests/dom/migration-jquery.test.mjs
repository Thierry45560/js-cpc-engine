/**
 * @file tests/dom/migration-jquery.test.mjs
 * @description Garde-fous de la migration jQuery → DOM natif.
 *
 * La migration a remplacé 334 appels `$(...)` par `document.querySelector`,
 * `addEventListener`, `classList` et la Web Animations API. Ces tests,
 * purement statiques, empêchent jQuery de revenir :
 *   1. plus aucun appel `$(` dans `site/js/` ;
 *   2. plus aucune méthode exclusive à jQuery ;
 *   3. plus aucune balise `<script>` jQuery dans le HTML d'exemple ;
 *   4. tous les branchements d'événements de `UI_DOM.js` passent par le
 *      registre `brancher()`, sans quoi un `bind*()` rappelé deux fois
 *      empilerait les écouteurs (jQuery le faisait silencieusement avec
 *      `.off().on()`).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Liste récursivement les fichiers `.js` d'un dossier.
 * @param {string} dossier
 * @returns {string[]} chemins absolus
 */
function listerJs(dossier) {
  const sortie = [];
  for (const nom of readdirSync(dossier)) {
    const chemin = join(dossier, nom);
    if (statSync(chemin).isDirectory()) sortie.push(...listerJs(chemin));
    else if (nom.endsWith('.js')) sortie.push(chemin);
  }
  return sortie;
}

/**
 * Renvoie les lignes d'un fichier *sans* leur contenu (commentaires de bloc
 * et de ligne retirés), en conservant la numérotation d'origine.
 * @param {string} chemin
 * @returns {string[]} lignes de code
 */
function lignesDeCode(chemin) {
  return sansCommentaires(readFileSync(chemin, 'utf8').split('\n'));
}

/**
 * Variante de `lignesDeCode` pour du texte déjà en mémoire (un bloc `<script>`
 * inline extrait du HTML, par exemple).
 * @param {string} texte
 * @returns {string[]} lignes de code
 */
function lignesDeCodeTexte(texte) {
  return sansCommentaires(texte.split('\n'));
}

/**
 * Retire commentaires de bloc et de ligne, en conservant la numérotation.
 * @param {string[]} lignes
 * @returns {string[]}
 */
function sansCommentaires(lignes) {
  const sortie = [];
  let dansBloc = false;
  for (const brut of lignes) {
    let ligne = brut;
    if (dansBloc) {
      const fin = ligne.indexOf('*/');
      if (fin === -1) { sortie.push(''); continue; }
      ligne = ligne.slice(fin + 2);
      dansBloc = false;
    }
    const debut = ligne.indexOf('/*');
    if (debut !== -1 && ligne.indexOf('*/', debut) === -1) {
      ligne = ligne.slice(0, debut);
      dansBloc = true;
    }
    sortie.push(ligne.replace(/\/\/.*$/, ''));
  }
  return sortie;
}

const FICHIERS_SRC = listerJs(join(RACINE, 'site/js'));

/**
 * Renvoie les lignes de code (hors commentaires) contenant `motif`.
 * @param {RegExp} motif
 * @returns {{fichier:string, ligne:number, texte:string}[]}
 */
function chercher(motif) {
  const trouve = [];
  for (const fichier of FICHIERS_SRC) {
    lignesDeCode(fichier).forEach((texte, i) => {
      if (texte.trim() && motif.test(texte)) {
        trouve.push({ fichier: relative(RACINE, fichier), ligne: i + 1, texte: texte.trim() });
      }
    });
  }
  return trouve;
}

describe('Migration jQuery → DOM natif — site/js/', () => {
  it('ne contient plus aucun appel $(...)', () => {
    // La seule exception tolérée est la chaîne BASIC `PRINT HEX$(65535)`
    // d'un exemple de programme dans index.js.
    const restants = chercher(/\$\(/).filter((o) => !/PRINT HEX/.test(o.texte));
    expect(restants, JSON.stringify(restants, null, 2)).toEqual([]);
  });

  it('n’utilise plus aucune méthode exclusive à jQuery', () => {
    const METHODES = [
      'addClass', 'removeClass', 'hasClass', 'removeAttr',
      'slideUp', 'slideDown', 'fadeIn', 'fadeOut',
    ];
    const motif = new RegExp('\\.(' + METHODES.join('|') + ')\\(');
    expect(chercher(motif)).toEqual([]);
  });

  it('n’utilise plus .toggle() de jQuery sur un élément', () => {
    // `.classList.toggle(c)` est la forme native ; `.toggle(show)` ne l'est pas.
    expect(chercher(/\.toggle\(/).filter((o) => !/classList\.toggle\(/.test(o.texte)))
      .toEqual([]);
  });

  it('n’utilise plus .on( / .off( de jQuery', () => {
    // `.on(` reste possible sur des objets non-DOM : on ne retient que les
    // lignes où l’objet est manifestement un sélecteur jQuery.
    const restants = chercher(/\.on\(|\.off\(/).filter((o) => /\$|jQuery/.test(o.texte));
    expect(restants, JSON.stringify(restants, null, 2)).toEqual([]);
  });

  it('expose un registre d’écouteurs permettant le retrait', () => {
    const ui = readFileSync(join(RACINE, 'site/js/adapters/dom/UI_DOM.js'), 'utf8');
    expect(ui).toContain('function brancher(');
    expect(ui).toContain('function detacher(');
    expect(ui).toContain('detach(selecteur)');
  });

  it('branche tous les événements de UI_DOM via le registre', () => {
    // Un `addEventListener` direct dans un bind*() Empilerait les handlers
    // quand la fonction est appelée deux fois — ce qui arrive : chaque
    // module rappelle son propre bind*() au démarrage.
    const lignes = lignesDeCode(join(RACINE, 'site/js/adapters/dom/UI_DOM.js'))
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    // Seuls `cible.addEventListener` (dans brancher/detacher) et
    // `document.addEventListener` (écouteurs globaux sans état) sont admis.
    const interdits = lignes.filter((l) =>
      l.includes('addEventListener') &&
      !l.includes('cible.addEventListener') &&
      !l.includes('document.addEventListener'));
    expect(interdits, JSON.stringify(interdits, null, 2)).toEqual([]);
  });
});

describe('Migration jQuery → DOM natif — examples/', () => {
  it('ne charge plus jQuery dans le HTML de démonstration', () => {
    const html = readFileSync(join(RACINE, 'examples/cpc-minimal.html'), 'utf8');
    const balises = html.match(/<script[^>]*src=[^>]*>/g) || [];
    const avecJquery = balises.filter((b) => /jquery/i.test(b));
    expect(avecJquery).toEqual([]);
  });

  it('documente l’absence de dépendance jQuery', () => {
    const html = readFileSync(join(RACINE, 'examples/cpc-minimal.html'), 'utf8');
    expect(html).toMatch(/No jQuery/i);
  });

  it('n’utilise plus jQuery dans le script inline', () => {
    // Le test précédent ne portait que sur les balises <script src>. Il laissait
    // donc passer le bloc <script> inline de la page — qui contenait encore un
    // `$(function () { … })` de 20 lignes, et qui plantait à l’exécution avec
    // « $ is not defined ». C’est un rappel : « pas de jQuery dans le HTML »
    // doit vouloir dire *tout* le HTML, balises externes et inline confondues.
    const html = readFileSync(join(RACINE, 'examples/cpc-minimal.html'), 'utf8');
    const blocs = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
      .map((m) => m[1])
      .filter((code) => code.trim().length > 0);
    expect(blocs.length).toBeGreaterThan(0);

    const coupables = [];
    blocs.forEach((code, i) => {
      for (const ligne of lignesDeCodeTexte(code).map((l) => l.trim())) {
        if (ligne.length === 0) continue;
        if (/\$/.test(ligne) || /\bjQuery\b/i.test(ligne)) {
          coupables.push(`bloc inline #${i + 1} : ${ligne}`);
        }
      }
    });
    expect(coupables).toEqual([]);
  });

  it('n’utilise plus jQuery dans les attributs de gestionnaire inline', () => {
    // Troisième cas, trouvé par le navigateur après les deux autres : un
    // `onclick="$('#drivea-input').click()"` dans le balisage. Ni le grep sur
    // `$(`, ni l’extraction des blocs <script> ne le voyaient — un attribut
    // `on*=` n’est ni du JS de fichier, ni du JS de bloc.
    const html = readFileSync(join(RACINE, 'examples/cpc-minimal.html'), 'utf8');
    const attributs = [...html.matchAll(/\bon[a-z]+\s*=\s*"([^"]*)"/gi)]
      .map((m) => m[1])
      .filter((code) => code.trim().length > 0);
    expect(attributs.length).toBeGreaterThan(0);

    const coupables = attributs.filter((code) => /(^|[^\w$])\$\s*\(/.test(code) || /\bjQuery\b/i.test(code));
    expect(coupables).toEqual([]);
  });
});

describe('Migration jQuery → DOM natif — documentation', () => {
  it('le README ne propose plus de balise script jQuery', () => {
    const readme = readFileSync(join(RACINE, 'README.md'), 'utf8');
    const balises = readme.match(/<script[^>]*src=[^>]*>/g) || [];
    expect(balises.filter((b) => /jquery/i.test(b))).toEqual([]);
  });

  it('les en-têtes de modules ne listent plus jQuery comme dépendance', () => {
    const interdits = [];
    for (const fichier of FICHIERS_SRC) {
      const texte = readFileSync(fichier, 'utf8');
      const lignes = texte.split('\n');
      lignes.forEach((l, i) => {
        if (!/@depends|Global dependencies|Global dependencies:/.test(l)) return;
        if (/jQuery|\$\(/.test(l)) interdits.push(`${relative(RACINE, fichier)}:${i + 1}`);
      });
    }
    expect(interdits).toEqual([]);
  });
});