/**
 * @file scripts/sync-site.mjs
 * @description Recopie la source canonique du moteur (`SRC/`) vers la copie
 * servie par le site (`site/js/`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI DEUX DOSSIERS
 * ─────────────────────────────────────────────────────────────────────────────
 * Le dépôt GitHub ne contient QUE le moteur : `SRC/`, les suites Z80/ZEXALL et
 * leur outillage. Le site web (`site/`) n'est pas versionné.
 *
 * Les pages HTML du site chargent leurs scripts par des chemins relatifs
 * (`js/core/cpu/Z80.js`) : la source doit donc se trouver physiquement sous
 * `site/js/` pour que www.js-cpc.fr fonctionne. `SRC/` est la seule copie
 * éditée à la main ; `site/js/` en est le miroir, régénéré par ce script.
 *
 *   npm run sync:site     # SRC/ → site/js/  (écrit)
 *   npm run check:site    # vérifie que les deux copies sont identiques
 *
 * `check:site` sort en code 1 dès qu'un fichier manque, est en trop ou diffère.
 * C'est le contrôle à passer avant de transférer `site/` chez l'hébergeur :
 * une copie oubliée signifierait un site qui tourne sur une version périmée du
 * moteur, sans aucun signe visible côté navigateur.
 *
 * Le miroir est exact : un fichier supprimé de `SRC/` est supprimé de
 * `site/js/`, et les sous-dossiers vidés sont retirés. Aucun fichier n'est
 * ajouté à `site/js/` par un autre chemin — le dossier ne contient que le
 * miroir.
 */

import { readFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICI = dirname(fileURLToPath(import.meta.url));
const RACINE = resolve(ICI, '..');

/** Source canonique, éditée à la main. */
const SOURCE = join(RACINE, 'SRC');

/** Miroir consommé par les pages du site (chemins relatifs `js/…`). */
const CIBLE = join(RACINE, 'site', 'js');

const VERIFICATION = process.argv.includes('--check');

/**
 * Indique si un chemin existe.
 *
 * Un clone du dépôt n'a pas de dossier `site/` : la vérification doit alors
 * NOMMER ce qui manque, pas s'interrompre sur un `ENOENT`.
 *
 * @param {string} chemin
 * @returns {Promise<boolean>}
 */
async function existe(chemin) {
  try {
    await stat(chemin);
    return true;
  } catch {
    return false;
  }
}

/**
 * Liste récursivement les fichiers d'un dossier, en chemins relatifs à celui-ci.
 * Les dossiers sont renvoyés en plus des fichiers (chaîne terminée par `/`) :
 * `--check` doit pouvoir signaler un dossier résiduel vide, qu'aucun fichier
 * en trop ne révélerait.
 *
 * @param {string} racine
 * @returns {Promise<Map<string, Buffer|null>>} chemin relatif → contenu
 */
async function lireArbre(racine) {
  const fichiers = new Map();

  /**
   * @param {string} dossier chemin absolu
   * @returns {Promise<void>}
   */
  async function parcourir(dossier) {
    const entrees = await readdir(dossier, { withFileTypes: true });
    for (const entree of entrees) {
      const absolu = join(dossier, entree.name);
      const relatif = relative(racine, absolu).split('\\').join('/');
      if (entree.isDirectory()) {
        fichiers.set(relatif + '/', null);
        await parcourir(absolu);
      } else if (entree.isFile()) {
        fichiers.set(relatif, await readFile(absolu));
      }
    }
  }

  await parcourir(racine);
  return fichiers;
}

/**
 * Compare deux arbres fichier par fichier.
 *
 * @param {Map<string, Buffer|null>} source
 * @param {Map<string, Buffer|null>} cible
 * @returns {{manquants:string[], enTrop:string[], differents:string[]}}
 */
function comparer(source, cible) {
  const manquants = [];
  const enTrop = [];
  const differents = [];

  for (const [chemin, contenu] of source) {
    if (!cible.has(chemin)) {
      manquants.push(chemin);
    } else if (contenu !== null && !cible.get(chemin).equals(contenu)) {
      differents.push(chemin);
    }
  }

  for (const chemin of cible.keys()) {
    if (!source.has(chemin)) enTrop.push(chemin);
  }

  return { manquants, enTrop, differents };
}

const ciblePresente = await existe(CIBLE);
const arbreSource = await lireArbre(SOURCE);
const arbreCible = ciblePresente ? await lireArbre(CIBLE) : new Map();
const ecarts = comparer(arbreSource, arbreCible);
const identiques = ciblePresente && !ecarts.manquants.length
  && !ecarts.enTrop.length && !ecarts.differents.length;

if (VERIFICATION) {
  if (!ciblePresente) {
    console.error('site/js est absent : lancez `npm run sync:site` pour le reconstruire depuis SRC/.');
    process.exitCode = 1;
  } else if (identiques) {
    const fichiers = [...arbreSource.keys()].filter((c) => !c.endsWith('/')).length;
    console.log('site/js est à jour : ' + fichiers + ' fichiers identiques à SRC/.');
    process.exitCode = 0;
  } else {
    console.error('site/js DIVERGE de SRC/ :');
    for (const chemin of ecarts.differents) console.error('  contenu différent : ' + chemin);
    for (const chemin of ecarts.manquants) console.error('  absent de site/js : ' + chemin);
    for (const chemin of ecarts.enTrop) console.error('  absent de SRC/    : ' + chemin);
    console.error();
    console.error('Lancez `npm run sync:site` pour reconstruire le miroir.');
    process.exitCode = 1;
  }
} else if (identiques) {
  console.log('site/js est déjà identique à SRC/ : rien à faire.');
} else {
  // Suppression d'abord : un fichier renommé dans SRC/ laisserait sinon
  // l'ancienne copie dans site/js/, où elle continuerait d'être servie.
  for (const chemin of ecarts.enTrop) {
    const absolu = join(CIBLE, chemin);
    await rm(absolu, { recursive: true, force: true });
    console.log('  supprimé  : ' + chemin);
  }

  for (const [chemin, contenu] of arbreSource) {
    if (contenu === null) {
      await mkdir(join(CIBLE, chemin), { recursive: true });
      continue;
    }
    if (arbreCible.has(chemin) && arbreCible.get(chemin).equals(contenu)) continue;

    const absolu = join(CIBLE, chemin);
    await mkdir(dirname(absolu), { recursive: true });
    await writeFile(absolu, contenu);
    console.log('  ' + (arbreCible.has(chemin) ? 'mis à jour: ' : 'copié     : ') + chemin);
  }

  const copies = [...arbreSource.keys()].filter(
    (chemin) => !chemin.endsWith('/') && (!arbreCible.has(chemin)
      || !arbreCible.get(chemin).equals(arbreSource.get(chemin))),
  ).length;
  console.log('site/js reconstruit depuis SRC/ : ' + copies + ' fichier(s) écrit(s), '
    + ecarts.enTrop.filter((c) => !c.endsWith('/')).length + ' supprimé(s).');
}
