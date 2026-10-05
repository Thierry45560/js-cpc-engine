/**
 * @file scripts/audit-psg-audio.mjs
 * @description Compare la sortie audio du PSG avant/après les corrections §9.12.1.
 *
 * Charge deux versions du fichier dans deux contextes `vm` **séparés** (le
 * fichier déclare un `const` de module : rejouer le script deux fois dans le
 * même contexte serait une `SyntaxError` de redeclaration), puis les soumet à
 * un stimulus identique et compare les traces complètes des trois sorties.
 *
 *   npm run audit:psg              # compare HEAD à l'arbre de travail
 *   node scripts/audit-psg-audio.mjs /tmp/avant.js
 *
 * La version de référence est relue depuis `git show HEAD:site/js/core/audio/AY38910.js`.
 * Une fois les corrections commitées, les deux sources sont identiques : dans
 * ce cas, fournir explicitement l'ancienne version :
 *
 *   git show <commit-avant>:site/js/core/audio/AY38910.js > /tmp/avant.js
 *   node scripts/audit-psg-audio.mjs /tmp/avant.js
 *
 * Scénarios : (1) 200 000 coups d'horloge sans reset, (2) les mêmes avec 8
 * resets, (3) pire cas analytique où seul le bruit est audible.
 * Code de sortie : 0 = aucun écart hors reset, 2 = écart hors reset.
 */

/* eslint-disable no-new-func */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const ICI = dirname(fileURLToPath(import.meta.url));
const CHEMIN = 'site/js/core/audio/AY38910.js';

/** @returns {string} le source de la version de travail */
const versionCourante = () => readFileSync(resolve(ICI, '..', CHEMIN), 'utf8');

/** @returns {string} le source de la version HEAD (avant corrections) */
const versionTete = () =>
  execFileSync('git', ['show', 'HEAD:' + CHEMIN], { cwd: resolve(ICI, '..'), encoding: 'utf8' });

const AVANT = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : versionTete();
const APRES = versionCourante();

if (AVANT === APRES) {
  console.warn('ATTENTION : les deux sources sont identiques, la comparaison est vide.');
  console.warn('Fournissez la version de référence : node scripts/audit-psg-audio.mjs /tmp/avant.js');
}

/**
 * Charge un PSG dans son propre contexte vm.
 * @param {string} source
 * @param {number} ppiPortC
 * @returns {object} l'espace de noms du PSG, câblé
 */
function charger(source, ppiPortC) {
  const contexte = createContext({ console, Math, Float32Array, Int32Array, Uint8Array });
  const psg = runInContext(
    `${source}\n;PSG_Sound_AY38910;`,
    contexte,
    { filename: CHEMIN },
  );
  psg.link({
    getPpiPortC: () => psg.__portC,
    readKeyboardRow: () => 0xFF,
  });
  psg.__portC = ppiPortC;
  return psg;
}

/**
 * Stimulus déterministe : écritures PPI + horloges, avec réinitialisations
 * périodiques. Retourne la trace des trois sorties et de l'état interne.
 * @param {object} psg
 * @param {{horloges:number, resets:number, graine:number}} opts
 * @returns {{sorties:number[], etats:string[]}}
 */
function stimulus(psg, { horloges, resets, graine }) {
  const rnd = mulberry32(graine);
  const sorties = [];
  const etats = [];
  let prochainReset = resets > 0 ? Math.floor(horloges / resets) : Infinity;

  for (let t = 0; t < horloges; t++) {
    if (t === prochainReset) {
      psg.reset();
      etats.push('reset:t' + t + ':sel=' + psg.Sel_Reg_Index
        + ',bruit=' + psg.Noise_Gen.Noise_Output_Bit
        + ',bruitCpt=' + psg.Noise_Gen.Counter_Val);
      prochainReset += Math.floor(horloges / resets);
      continue;
    }
    // 1 écriture sur 3 : sélection puis valeur sur le bus PPI.
    if (rnd() < 0.34) {
      psg.__portC = 0x80 | 3;                       // mode 11 : sélection
      psg.writePort(Math.floor(rnd() * 16) & 0x0F);
      psg.__portC = 0x80 | 2;                       // mode 10 : écriture
      psg.writePort(Math.floor(rnd() * 256) & 0xFF);
      psg.__portC = 0x80 | 1;                       // mode 01 : lecture
      psg.readPort();
    }
    psg.Clock_Cycle();
    sorties.push(psg.Output_ChanA, psg.Output_ChanB, psg.Output_ChanC);
    if (t % 1000 === 0) {
      etats.push('t' + t
        + ',sel=' + psg.Sel_Reg_Index
        + ',per=' + [...psg.chanPeriods].join('/')
        + ',tgl=' + [...psg.chanToggles].join('/')
        + ',graine=0x' + psg.Noise_Seed.toString(16)
        + ',env=' + psg.Envelope_Gen.Volume_Level + '/' + psg.Envelope_Gen.Counter_Val);
    }
  }
  return { sorties, etats };
}

/**
 * PRNG déterministe (mulberry32) : deux exécutions donnent la même suite.
 * @param {number} a
 * @returns {() => number}
 */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Compare deux tableaux de nombres et renvoie les divergences.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {{indice:number, avant:number, apres:number}[]}
 */
function divergences(a, b) {
  const out = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (!Object.is(a[i], b[i])) out.push({ indice: i, avant: a[i], apres: b[i] });
  }
  if (a.length !== b.length) out.push({ indice: -1, avant: a.length, apres: b.length });
  return out;
}

const psgAvant = charger(AVANT, 0);
const psgApres = charger(APRES, 0);

// ---------------------------------------------------------------------------
// Scénario 1 — aucun reset en cours d'exécution : la sélection et le bruit
// ne sont jamais consultés, on doit obtenir des sorties strictement identiques.
// ---------------------------------------------------------------------------
const SANS_RESET = { horloges: 200_000, resets: 0, graine: 12345 };
const a1 = stimulus(psgAvant, SANS_RESET);
psgAvant.reset();
const b1 = stimulus(psgApres, SANS_RESET);

const d1 = divergences(a1.sorties, b1.sorties);
const e1 = divergences(a1.etats, b1.etats);

console.log('=== Scénario 1 : ' + SANS_RESET.horloges + ' coups d\'horloge, aucun reset ===');
console.log('  échantillons de sortie : ' + a1.sorties.length);
console.log('  divergences de sortie  : ' + d1.length);
console.log('  divergences d\'état     : ' + e1.length);
if (d1.length) console.log('  ' + JSON.stringify(d1.slice(0, 10)));

// ---------------------------------------------------------------------------
// Scénario 2 — 8 resets en cours d'exécution : le reset est le seul moment où
// les corrections peuvent se voir.
// ---------------------------------------------------------------------------
const AVEC_RESET = { horloges: 200_000, resets: 8, graine: 12345 };
psgAvant.reset();
const a2 = stimulus(psgAvant, AVEC_RESET);
psgApres.reset();
const b2 = stimulus(psgApres, AVEC_RESET);

const d2 = divergences(a2.sorties, b2.sorties);

console.log();
console.log('=== Scénario 2 : ' + AVEC_RESET.horloges + ' coups d\'horloge, '
  + AVEC_RESET.resets + ' resets ===');
console.log('  échantillons de sortie : ' + a2.sorties.length);
console.log('  divergences de sortie  : ' + d2.length);
if (d2.length) {
  const premieres = d2.slice(0, 12);
  console.log('  premières divergences  :');
  for (const d of premieres) {
    console.log('    échantillon ' + d.indice + ' (t=' + Math.floor(d.indice / 3)
      + ', canal ' + (d.indice % 3) + ') : ' + d.avant + ' -> ' + d.apres);
  }
  const dernier = d2[d2.length - 1];
  console.log('  dernière divergence    : échantillon ' + dernier.indice
    + ' (t=' + Math.floor(dernier.indice / 3) + ')');
}

// ---------------------------------------------------------------------------
// Scénario 3 — pire cas : bruit ET tonalité actifs sur le canal A au moment
// exact du reset. C'est la seule configuration où la différence de
// `Noise_Output_Bit` peut être entendue (sortie = tonalité ET bruit).
// ---------------------------------------------------------------------------
const BRUIT_ACTIF = { horloges: 40, resets: 4, graine: 777 };
/**
 * @param {object} psg
 * @param {number} r7 valeur de mixeur : 0x36 = ton A + bruit A, 0x37 = bruit A seul
 * @returns {{sorties:number[], journal:string[]}}
 */
function pireCas(psg, r7) {
  const sorties = [];
  const temps = [];
  const journal = [];
  for (let t = 0; t < BRUIT_ACTIF.horloges; t++) {
    if (t % 10 === 0) {
      psg.reset();
      psg.Select_Register(7);  psg.Write_Register(r7);
      psg.Select_Register(8);  psg.Write_Register(0x0F);
      psg.Select_Register(0);  psg.Write_Register(0x02);
      psg.Select_Register(1);  psg.Write_Register(0x00);
      psg.Select_Register(6);  psg.Write_Register(0x01);
      journal.push('t' + t + ',apresReset'
        + ',sel=' + psg.Sel_Reg_Index
        + ',bruit=' + psg.Noise_Gen.Noise_Output_Bit
        + ',bruitCpt=' + psg.Noise_Gen.Counter_Val
        + ',tgl=' + psg.chanToggles[0]);
      continue;
    }
    psg.Clock_Cycle();
    temps.push(t);
    sorties.push(psg.Output_ChanA, psg.Output_ChanB, psg.Output_ChanC);
  }
  return { sorties, temps, journal };
}

/**
 * Exécute un pire cas sur les deux versions.
 * @param {number} r7
 * @returns {{div:object[], avant:object, apres:object}}
 */
function comparer(r7) {
  psgAvant.reset();
  const av = pireCas(psgAvant, r7);
  psgApres.reset();
  const ap = pireCas(psgApres, r7);
  return { div: divergences(av.sorties, ap.sorties), avant: av, apres: ap };
}

function rapport(titre, r) {
  console.log();
  console.log('=== ' + titre + ' ===');
  console.log('  échantillons : ' + r.avant.sorties.length
    + '   divergences de sortie : ' + r.div.length);
  for (const l of r.avant.journal) console.log('    avant  ' + l);
  for (const l of r.apres.journal) console.log('    après  ' + l);
  if (r.div.length) {
    const touches = r.div.map((d) => ({
      t: r.avant.temps[Math.floor(d.indice / 3)],
      avant: d.avant,
      apres: d.apres,
    }));
    console.log('  horloges touchées : ' + touches.map((x) => 't' + x.t).join(', '));
    console.log('  détail : ' + touches.map((x) => 't' + x.t + ' ' + x.avant + '->' + x.apres).join(', '));
  }
}

const c3a = comparer(0x37);   // bruit seul : isole le bit de bruit
const c3b = comparer(0x36);   // bruit + tonalité : cas réaliste

rapport('Scénario 3a : bruit seul (R7=0x37) — isole le bit de bruit', c3a);
rapport('Scénario 3b : bruit + tonalité (R7=0x36) — cas réaliste', c3b);
const d3 = c3a.div.length + c3b.div.length;

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
console.log();
const identiques = d1.length === 0 && d2.length === 0 && d3.length === 0;
if (identiques) {
  console.log('VERDICT : sorties audio strictement identiques avant/après,');
  console.log('          y compris dans le pire cas (bruit actif de part et d\'autre).');
} else if (d1.length === 0 && d2.length === 0) {
  console.log('VERDICT : identiques hors reset ; ' + c3a.div.length + '/' + c3a.avant.sorties.length
    + ' échantillons divergent dans le pire cas (bruit seul), ' + c3b.div.length
    + ' avec bruit + tonalité. Effet borné à un coup d\'horloge par reset.');
} else {
  console.log('VERDICT : DIVERGENCE hors reset — à examiner.');
  process.exitCode = 2;
}