/**
 * @file tests/helpers/zexall-runner.mjs
 * @description Exécuteur de ZEXALL (Z80 instruction set exerciser) en Node pur.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QU'EST-CE QUE ZEXALL ?
 * ─────────────────────────────────────────────────────────────────────────────
 * Programme de référence de Frank D. Cringle (1994). Pour chaque famille
 * d'instructions, il fait varier un « état machine » (16 octets : opérande
 * mémoire, IY, IX, HL, DE, BC, AF, SP) sur des vecteurs d'incrément et de
 * décalage, exécute l'instruction sous test, puis calcule un **CRC 32** de
 * l'état résultant et le compare à une valeur obtenue sur du silicium réel.
 *
 * C'est le test de conformité de référence du Z80 : 67 familles, ~67 000 cas.
 * Un CPU qui le passe est conforme au Z80 réel pour tout ce que la suite
 * couvre — registres, drapeaux, et mémoire. C'est pourquoi il prime sur toute
 * opinion a priori : voir §9 de RAPPORT.md.
 *
 * Source : https://github.com/agn453/ZEXALL (répertoire de référence,
 * `zexall.z80` + `zexall.com`). Le binaire est embarqué tel quel, sans
 * modification, et son SHA-256 est vérifié au chargement.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LE PROBLÈME : ZEXALL EST UN PROGRAMME CP/M
 * ─────────────────────────────────────────────────────────────────────────────
 * `zexall.com` est un binaire CP/M. Il attend donc un appel système, et il
 * n'utilise que deux fonctions BDOS :
 *
 *   C = 2  →  write character, le caractère est dans E
 *   C = 9  →  write string $, le pointeur est dans DE (terminée par '$')
 *
 * Plus un `jp 0` final (« warm boot ») qui signale la fin normale.
 *
 * On fournit donc un **stub BDOS en assembleur Z80**, écrit à la main et
 * posé en mémoire vive. Il n'est PAS lié à CPC/M : c'est 30 octets qui
 * suffisent, et cela évite toute dépendance.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEUX PIÈGES D'IMPLÉMENTATION (les deux ont coûté du temps)
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. `call 5` pointe sur l'adresse 0x0005, et le vecteur qui s'y trouve fait
 *    3 octets — dont 0x0006 et 0x0007, que ZEXALL lit comme pile initiale
 *    (`ld hl,(6)` / `ld sp,hl` à l'entrée). Un `jp nn` à 0x0005 écrase donc
 *    la pile. On utilise `RST 0x18` (opcode 0xDF), qui tient sur **un seul
 *    octet** et libère 0x0006-0x0007.
 *
 * 2. `RST` empile une adresse de retour comme `call`. L'entrée du stub se
 *    trouve donc un niveau plus haut dans la pile que le `call 5` de ZEXALL.
 *    Sans un `POP AF` en 0x0018, le `RET` final dépilerait 0x0006 (l'adresse
 *    suivant le RST) au lieu de revenir dans ZEXALL.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PORT DE SORTIE
 * ─────────────────────────────────────────────────────────────────────────────
 * Le stub émet chaque caractère par `LD (PORT),E`. On intercepte cette
 * adresse dans `writeMemory`. 0x00F0 est choisie parce qu'elle est à la fois
 * hors de la zone du programme (0x0100-0x22FF) et hors de la pile (qui
 * descend depuis 0xFFFF).
 */

/* eslint-disable no-new-func */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadZ80CPU } from './z80-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Le binaire CP/M de ZEXALL, embarqué tel quel. */
export const ZEXALL_BINARY_PATH = resolve(HERE, '../fixtures/zexall.com');

/**
 * Empreinte du binaire embarqué. Si ce SHA change, le programme de
 * conformance exécuté n'est plus celui attendu — le résultat perdrait son
 * sens. Volontairement en dur plutôt que recalculé : on veut détecter le
 * remplacement, pas l'accepter silencieusement.
 */
export const ZEXALL_SHA256 =
  '6e2da55147a04f28d303d5da6a1e6b771557ac244653590a0f24a2d39c8537e8';

/** Adresse de chargement du .com (convention CP/M). */
const ORIGIN = 0x0100;

/** Adresse du vecteur BDOS. */
const BDOS_VECTOR = 0x0005;

/** Adresse du stub BDOS, cible du `RST 0x18`. */
const STUB_ORIGIN = 0x0018;

/** Adresse interceptée par `writeMemory` pour récupérer les caractères. */
const OUTPUT_PORT = 0x00F0;

/** Pile initiale, telle que ZEXALL la lit en 0x0006-0x0007. */
const INITIAL_SP = 0xFFFF;

/**
 * Stub BDOS, en assembleur, avec les adresses résolues à la main.
 *
 * ```
 * 0018  F1          POP AF          ; dépile l'adresse retour du RST (piège n°2)
 * 0019  79          LD A,C
 * 001A  FE 09       CP 9
 * 001C  20 14       JR NZ,$0032     ; → fonction 2 (caractère dans E)
 * 001E  D5          PUSH DE         ; fonction 9 : DE = pointeur de la chaîne
 * 001F  E1          POP HL          ; → HL, pour ne pas détruire DE
 * 0020  7E          LD A,(HL)       ; ┐
 * 0021  FE 24       CP '$'          ; │ boucle d'édition
 * 0023  28 0B       JR Z,$0030      ; ┘ sortie sur '$'
 * 0025  5F          LD E,A
 * 0026  0E 02       LD C,2          ;    _write character_
 * 0028  CD 32 00    CALL $0032      ; ┐
 * 002B  23          INC HL          ; │
 * 002C  C3 20 00    JP $0020        ; ┘
 * 002F  00          (alignement)
 * 0030  C9          RET             ; fin fonction 9 → retour dans ZEXALL
 * 0031  00          (alignement)
 * 0032  32 F0 00    LD ($00F0),E    ; émet le caractère sur le port
 * 0035  C9          RET
 * ```
 *
 * `JR` et `CALL` sont résolus à la main ; toute modification doit être
 * recalculée, d'où les adresses écrites en commentaire.
 */
const BDOS_STUB = Object.freeze([
  0xf1,                   // 0018  POP AF
  0x79,                   // 0019  LD A,C
  0xfe, 0x09,             // 001A  CP 9
  0x20, 0x14,             // 001C  JR NZ,$0032
  0xd5,                   // 001E  PUSH DE
  0xe1,                   // 001F  POP HL
  0x7e,                   // 0020  LD A,(HL)
  0xfe, 0x24,             // 0021  CP '$'
  0x28, 0x0b,             // 0023  JR Z,$0030
  0x5f,                   // 0025  LD E,A
  0x0e, 0x02,             // 0026  LD C,2
  0xcd, 0x32, 0x00,       // 0028  CALL $0032
  0x23,                   // 002B  INC HL
  0xc3, 0x20, 0x00,       // 002C  JP $0020
  0x00,                   // 002F
  0xc9,                   // 0030  RET
  0x00,                   // 0031
  0x32, 0xf0, 0x00,       // 0032  LD ($00F0),E
  0xc9,                   // 0035  RET
]);

/** `RST 0x18` : un octet, ne consomme pas 0x0006-0x0007 (cf. piège n°1). */
const RST_0x18 = 0xdf;

/**
 * Lit et vérifie le binaire ZEXALL embarqué.
 * @returns {Buffer}
 */
export function loadZexallBinary() {
  const binary = readFileSync(ZEXALL_BINARY_PATH);
  const actual = createHash('sha256').update(binary).digest('hex');
  if (actual !== ZEXALL_SHA256) {
    throw new Error(
      `zexall: SHA-256 du binaire inattendu.\n` +
        `  attendu : ${ZEXALL_SHA256}\n` +
        `  obtenu  : ${actual}\n` +
        `Le programme de conformance exécuté n'est plus celui documenté ; ` +
        `un résultat vert n'aurait aucun sens.`,
    );
  }
  return binary;
}

/**
 * Assemble la sortie texte de ZEXALL en résultats structurés.
 *
 * ZEXALL écrit deux choses : un nom de test suivi de «  OK », ou bien
 * «  ERROR **** crc expected:xxxxxxxx found:xxxxxxxx ».
 *
 * @param {string} text sortie brute accumulée
 * @returns {{tests: {name: string, status: 'OK'|'ERROR', expected?: string, found?: string}[],
 *            passed: number, failed: number, completed: boolean}}
 */
export function parseZexallOutput(text) {
  const tests = [];
  let completed = false;

  // Une ligne = « <nom>....  OK » ou « <nom>....  ERROR **** ... ».
  for (const rawLine of text.split(/[\r\n]+/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (/^Tests complete/i.test(line)) {
      completed = true;
      continue;
    }
    if (/^Z80 instruction exerciser/i.test(line)) continue;

    // Format réel (zexall.z80 : `ermsg1` / `phex8` / `ermsg2` / `phex8`) :
    //   <nom>....  ERROR **** crc expected:XXXXXXXX found:YYYYYYYY
    // `phex8` n'émet aucun saut de ligne, donc tout tient sur une ligne.
    const error = line.match(/^(.*?)\.+\s+ERROR\s+\*+\s*crc expected:([0-9a-f]+)\s+found:([0-9a-f]+)/i);
    if (error) {
      tests.push({
        name: error[1].trim(),
        status: 'ERROR',
        expected: error[2],
        found: error[3],
      });
      continue;
    }

    const ok = line.match(/^(.*?)\.+\s+OK$/i);
    if (ok) {
      tests.push({ name: ok[1].trim(), status: 'OK' });
    }
  }

  return {
    tests,
    passed: tests.filter((t) => t.status === 'OK').length,
    failed: tests.filter((t) => t.status === 'ERROR').length,
    completed,
  };
}

/**
 * Exécute ZEXALL en entier et renvoie le rapport.
 *
 * ⚠ COÛT : ~5,8 milliards d'instructions, soit plusieurs minutes sur Node.
 * C'est pourquoi `tests/z80/zexall.test.mjs` ne s'exécute que sur demande
 * explicite (variable d'environnement `ZEXALL=1`) : le rôle de ZEXALL est
 * la **non-régression ponctuelle**, pas la boucle de feedback quotidienne.
 *
 * @param {object}   [options]
 * @param {number}   [options.maxInstructions=2e10] garde-fou anti-boucle
 * @param {Function} [options.onProgress]          (n) => void, à chaque « OK »
 * @returns {{ok: boolean, timedOut: boolean, output: string,
 *            instructions: number, ticks: number, seconds: number,
 *            tests: object[], passed: number, failed: number, completed: boolean}}
 */
export function runZexall({ maxInstructions = 2e10, onProgress } = {}) {
  const binary = loadZexallBinary();
  const Z80_CPU = loadZ80CPU();

  const mem = new Uint8Array(0x10000);
  const chars = [];
  let ticks = 0;

  // Installation de l'image CP/M minimale.
  mem[BDOS_VECTOR] = RST_0x18;
  mem.set(BDOS_STUB, STUB_ORIGIN);
  mem.set(binary, ORIGIN);
  // ZEXALL fait `ld hl,(6)` / `ld sp,hl` : on renseigne donc 0x0006-0x0007
  // avec la pile initiale, comme le ferait un BDOS réel.
  mem[0x0006] = (INITIAL_SP >> 8) & 0xff;
  mem[0x0007] = INITIAL_SP & 0xff;

  const bus = {
    readMemory: (addr) => mem[addr & 0xffff],
    writeMemory(addr, value) {
      const a = addr & 0xffff;
      if (a === OUTPUT_PORT) {
        chars.push(value & 0xff);
      } else {
        mem[a] = value & 0xff;
      }
    },
    readIO: () => 0xff,
    executeTicks(count) {
      ticks += count;
    },
    // ZEXALL fait `di` avant chaque cas de test ; aucune IRQ n'est due.
    getIntStatus: () => 0,
    acknowledgeInterrupt: () => 0xff,
  };

  const cpu = new Z80_CPU(bus);
  cpu.reset();
  cpu.regPC = ORIGIN;
  cpu.regSP = INITIAL_SP;

  const startedAt = Date.now();
  let instructions = 0;
  let lastReported = 0;

  // `jp 0` = « warm boot » = fin normale de ZEXALL.
  while (cpu.regPC !== 0x0000 && instructions < maxInstructions) {
    cpu.exec();
    // Sans ce reset, l'écriture I/O différée (`ioWriteState`) rejouerait la
    // même sortie à chaque T-state — exactement le rôle de
    // `IO_Manager.clearIoWriteState` dans CPC_Bus.js.
    cpu.ioWriteState = 0;
    instructions++;

    if (onProgress && instructions - lastReported >= 500_000_000) {
      lastReported = instructions;
      onProgress(instructions);
    }
  }

  const seconds = (Date.now() - startedAt) / 1000;
  const output = Buffer.from(chars).toString('latin1');
  const report = parseZexallOutput(output);

  return {
    ok:
      !report.failed &&
      report.completed &&
      report.tests.length > 0 &&
      cpu.regPC === 0x0000,
    timedOut: cpu.regPC !== 0x0000,
    output,
    instructions,
    ticks,
    seconds,
    ...report,
  };
}
