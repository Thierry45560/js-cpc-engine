/**
 * @file tests/helpers/z80-harness.mjs
 * @description Harnais de test pour le cœur Z80 (site/js/core/cpu/Z80.js).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI UN CHARGEMENT MANUEL
 * ─────────────────────────────────────────────────────────────────────────────
 * `site/js/core/cpu/Z80.js` est un script classique destiné au navigateur : il
 * n'a ni `export`, ni `import`, et déclare `class Z80_CPU` ainsi que des
 * `const` au niveau module. En script classique ces déclarations vivent dans
 * le *lexical scope global* — donc `window.Z80_CPU === undefined`, et un
 * simple `import` Node échouerait (`no matching export`).
 *
 * On lit donc le fichier et on l'évalue en lui ajoutant une expression de
 * retour. C'est le même code exécuté, à l'identique : aucune transformation,
 * aucun shim, donc ce que teste la suite est exactement ce qui tourne en prod.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LE BUS
 * ─────────────────────────────────────────────────────────────────────────────
 * `Z80_CPU` n'a aucune dépendance externe : tout passe par un objet `bus` de
 * six méthodes. On fournit ici :
 *  - 64 Ko de RAM (Uint8Array) en espace d'adressage plat ;
 *  - un journal des écritures I/O différées (`cpu.ioWriteState`) reproduisant
 *    le protocole de `IO_Manager` / `Emulator_Core.executeTicks` ;
 *  - un compteur de T-states alimenté par `executeTicks(n)`.
 *
 * ⚠ CONVENTION DE COMPTAGE DES T-STATES (à lire avant d'écrire un test)
 * `fetchOpcode()` n'appelle PAS `executeTicks`, et `exec()` n'ajoute rien.
 * Le cycle M1 (3 T-states) n'est donc jamais compté par le cœur. De plus,
 * l'écart avec le matériel n'est pas constant (voir tests/z80/timing.test.mjs) :
 * ce n'est pas « matériel − 3 ». Les tests de timing doivent donc asserter
 * les valeurs *du cœur* (régression) ou utiliser `hardwareTicks()` qui
 * applique le delta documenté — jamais supposer que core === hardware.
 */

/* eslint-disable no-new-func */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Chemin absolu du cœur Z80 sous test. */
export const Z80_SOURCE_PATH = resolve(HERE, '../../site/js/core/cpu/Z80.js');

/** Adresse par défaut où `execInstr` charge le programme à tester. */
export const DEFAULT_ORIGIN = 0x0100;

/** Pile par défaut : 2 octets sous le haut, comme un reset Z80 réel. */
export const DEFAULT_SP = 0xFFFE;

let _cachedCpuClass = null;

/**
 * Charge et instancie la classe `Z80_CPU` depuis le fichier source.
 * Le résultat est mis en cache : les tables d'opcodes sont construites une
 * seule fois pour l'ensemble de la suite.
 *
 * On évalue le fichier via `vm.runInThisContext` plutôt que `new Function` :
 * `vm` prend un `filename`, ce qui permet à V8 d'attribuer la couverture au
 * vrai fichier `site/js/core/cpu/Z80.js` au lieu d'afficher 0 %.
 *
 * Le code source n'est en rien modifié : on se contente de le faire
 * s'enregistrer dans le scope lexical global (il s'agit déjà d'un script
 * classique, pas d'un module) et d'exposer la classe sur `globalThis`.
 *
 * @returns {Function} la classe `Z80_CPU`
 */
export function loadZ80CPU() {
  if (_cachedCpuClass) return _cachedCpuClass;

  const source = readFileSync(Z80_SOURCE_PATH, 'utf8');

  // Le préfixe `use strict` du fichier reste en tête de script, donc
  // l'ensemble est évalué en mode strict — exactement comme dans le
  // navigateur.
  runInThisContext(`${source}\n;globalThis.__Z80_CPU_EXPORT__ = Z80_CPU;`, {
    filename: Z80_SOURCE_PATH,
  });

  _cachedCpuClass = globalThis.__Z80_CPU_EXPORT__;
  delete globalThis.__Z80_CPU_EXPORT__;

  if (typeof _cachedCpuClass !== 'function') {
    throw new Error(
      `z80-harness: Z80_CPU introuvable dans ${Z80_SOURCE_PATH}. ` +
        'Le fichier source a peut-être changé de forme.',
    );
  }
  return _cachedCpuClass;
}

/**
 * Machine Z80 de test : CPU + bus simulé sur 64 Ko.
 *
 * Reproduit fidèlement le contrat de `CPC_Bus.js` :
 *  - `readMemory` / `writeMemory` sur un tableau plat ;
 *  - `readIO` alimenté par un handler remplaçable ;
 *  - `executeTicks` incrémente un compteur ;
 *  - `getIntStatus` / `acknowledgeInterrupt` pilotent le vecteur d'interruption.
 */
export class TestMachine {
  /**
   * @param {object}  [options]
   * @param {number}  [options.origin=0x0100] adresse de chargement du programme
   * @param {number}  [options.sp=0xFFFE]    valeur initiale de SP
   * @param {number}  [options.irqVector=0xFF] valeur renvoyée par acknowledgeInterrupt
   * @param {number}  [options.intStatus=0]   ligne d'interruption maquette (0 = aucune)
   */
  constructor({
    origin = DEFAULT_ORIGIN,
    sp = DEFAULT_SP,
    irqVector = 0xFF,
    intStatus = 0,
  } = {}) {
    const Z80_CPU = loadZ80CPU();

    /** @type {Uint8Array} espace d'adressage 64 Ko. */
    this.mem = new Uint8Array(0x10000);
    /** @type {number} T-states écoulés. */
    this.ticks = 0;
    /** @type {number} ligne IRQ maquettée (ce que voit `getIntStatus`). */
    this.intStatus = intStatus;
    /** @type {number} valeur de bus renvoyée à `acknowledgeInterrupt`. */
    this.irqVector = irqVector;
    /** @type {{priority:number, addr:number, value:number}[]} journal des OUT. */
    this.ioOut = [];
    /** @type {{addr:number, value:number}[]} journal des IN. */
    this.ioIn = [];
    /** @type {Function|null} handler IN personnalisé : (addr) => 0..255. */
    this.ioReadHandler = null;

    // Note : `self` et non `this` dans les fléchées — le CPU lie les six
    // méthodes avec `.bind(bus)`, donc `this` y vaudrait l'objet bus lui-même.
    const self = this;

    /** @type {object} implémente le contrat bus attendu par Z80_CPU. */
    this.bus = {
      readMemory(addr) {
        return self.mem[addr & 0xFFFF];
      },
      writeMemory(addr, value) {
        self.mem[addr & 0xFFFF] = value & 0xFF;
      },
      readIO(addr) {
        self.ioIn.push({ addr: addr & 0xFFFF, value: 0 });
        const value =
          self.ioReadHandler === null ? 0xFF : self.ioReadHandler(addr) & 0xFF;
        self.ioIn[self.ioIn.length - 1].value = value;
        return value;
      },
      executeTicks(count) {
        self.ticks += count;
      },
      getIntStatus() {
        return self.intStatus;
      },
      acknowledgeInterrupt() {
        return self.irqVector;
      },
    };

    this.cpu = new Z80_CPU(this.bus);
    this.origin = origin;
    this.cpu.regSP = sp;
    this.cpu.regPC = origin;
  }

  /**
   * Écrit un programme en mémoire.
   * @param {number[]} bytes opcodes et opérandes
   * @param {number}   [at=this.origin] adresse de destination
   * @returns {this}
   */
  load(bytes, at = this.origin) {
    for (let i = 0; i < bytes.length; i++) this.mem[(at + i) & 0xFFFF] = bytes[i] & 0xFF;
    return this;
  }

  /**
   * Positionne un registre 8 bits. Accepte la lettre canonique du Z80.
   * @param {string} name 'A'|'B'|'C'|'D'|'E'|'F'|'H'|'L'
   * @param {number} value 0..255
   * @returns {this}
   */
  setReg8(name, value) {
    this.cpu.r8[Z80_R8_INDEX[name]] = value & 0xFF;
    return this;
  }

  /**
   * Positionne un registre 16 bits.
   * @param {string} name 'BC'|'DE'|'HL'|'AF'|'SP'|'IX'|'IY'
   * @param {number} value 0..65535
   * @returns {this}
   */
  setReg16(name, value) {
    const v = value & 0xFFFF;
    switch (name) {
      case 'BC': this.cpu.r16[0] = v; break;
      case 'DE': this.cpu.r16[1] = v; break;
      case 'HL': this.cpu.r16[2] = v; break;
      case 'AF': this.cpu.r16[3] = v; break;
      case 'SP': this.cpu.regSP = v; break;
      case 'IX': this.cpu.idxRegs[0] = v; break;
      case 'IY': this.cpu.idxRegs[1] = v; break;
      default: throw new Error(`setReg16: registre inconnu '${name}'`);
    }
    return this;
  }

  /**
   * Lit un registre 16 bits.
   * @param {string} name 'BC'|'DE'|'HL'|'AF'|'SP'|'IX'|'IY'|'WZ'
   * @returns {number}
   */
  getReg16(name) {
    switch (name) {
      case 'BC': return this.cpu.r16[0];
      case 'DE': return this.cpu.r16[1];
      case 'HL': return this.cpu.r16[2];
      case 'AF': return this.cpu.r16[3];
      case 'SP': return this.cpu.regSP;
      case 'IX': return this.cpu.idxRegs[0];
      case 'IY': return this.cpu.idxRegs[1];
      case 'WZ': return this.cpu.regWZ;
      default: throw new Error(`getReg16: registre inconnu '${name}'`);
    }
  }

  /**
   * Lit un registre 8 bits.
   * @param {string} name 'A'|'B'|'C'|'D'|'E'|'F'|'H'|'L'
   * @returns {number}
   */
  getReg8(name) {
    return this.cpu.r8[Z80_R8_INDEX[name]];
  }

  /** @returns {object} le drapeau F en bits, decomposed pour les assertions. */
  get flags() {
    const f = this.getReg8('F');
    return {
      raw: f,
      S: (f >> 7) & 1,
      Z: (f >> 6) & 1,
      Y: (f >> 5) & 1,
      H: (f >> 4) & 1,
      X: (f >> 3) & 1,
      PV: (f >> 2) & 1,
      N: (f >> 1) & 1,
      C: f & 1,
    };
  }

  /**
   * Collecte une écriture I/O différée et remet `ioWriteState` à 0.
   *
   * C'est exactement ce que fait `IO_Manager` via
   * `clearIoWriteState: () => { CPU_Z80.ioWriteState = 0; }` dans CPC_Bus.js.
   * Sans cet appel, `cpu.ioWriteState` resterait armé et le moteur
   * rejouerait la même écriture à chaque T-state.
   * @returns {this}
   */
  flushDeferredIO() {
    if (this.cpu.ioWriteState !== 0) {
      this.ioOut.push({
        priority: this.cpu.ioWriteState,
        addr: this.cpu.ioWriteAddr,
        value: this.cpu.ioWriteVal,
      });
      this.cpu.ioWriteState = 0;
    }
    return this;
  }

  /**
   * Exécute une instruction (`cpu.exec()`) puis draine l'I/O différée.
   * @returns {number} les T-states consommés par cette instruction
   */
  step() {
    const before = this.ticks;
    this.cpu.exec();
    this.flushDeferredIO();
    return this.ticks - before;
  }

  /**
   * Exécute jusqu'à ce que PC atteigne `target`, pour les instructions
   * ré-exécutées (LDIR, CPIR, INIR…) qui rembobinent PC.
   * @param {number} target adresse d'arrêt
   * @param {number} [maxSteps=65536] garde-fou anti-boucle infinie
   * @returns {number} nombre d'instructions exécutées
   */
  stepUntil(target, maxSteps = 65536) {
    let n = 0;
    while (this.cpu.regPC !== target && n < maxSteps) {
      this.step();
      n++;
    }
    if (this.cpu.regPC !== target) {
      throw new Error(
        `stepUntil: PC stuck at 0x${this.cpu.regPC.toString(16)} ` +
          `(attendu 0x${target.toString(16)}) après ${maxSteps} instructions`,
      );
    }
    return n;
  }
}

/**
 * Ordre canonique Z80 des registres 8 bits → offset dans `cpu.r8`.
 * Le cœur stocke dans l'ordre [C,B,E,D,L,H,F,A] pour permettre l'aliasing
 * 8/16 bits via un ArrayBuffer partagé (voir Z80.js).
 */
export const Z80_R8_INDEX = Object.freeze({
  C: 0, B: 1, E: 2, D: 3, L: 4, H: 5, F: 6, A: 7,
});

/**
 * Construit une machine, charge un programme, applique un setup, exécute
 * `count` instructions et renvoie un instantané.
 *
 * @param {number[]} bytes programme à charger à l'origine
 * @param {object}   [options]
 * @param {Function} [options.setup]   (machine) => void — état avant exécution
 * @param {number}   [options.instructions=1] nombre d'exécutions
 * @param {number}   [options.origin]  adresse de chargement
 * @param {number}   [options.sp]      valeur initiale de SP
 * @param {number}   [options.irqVector]
 * @param {number}   [options.intStatus]
 * @returns {{machine: TestMachine, ticks: number, ticksPerStep: number[]}}
 */
export function execInstr(bytes, {
  setup,
  instructions = 1,
  origin = DEFAULT_ORIGIN,
  sp = DEFAULT_SP,
  irqVector = 0xFF,
  intStatus = 0,
} = {}) {
  const machine = new TestMachine({ origin, sp, irqVector, intStatus });
  machine.load(bytes, origin);
  if (setup) setup(machine);

  const ticksPerStep = [];
  for (let i = 0; i < instructions; i++) ticksPerStep.push(machine.step());

  return { machine, ticks: machine.ticks, ticksPerStep };
}

/**
 * Évalue une instruction et renvoie l'état résultant, sans la machine.
 * @param {number[]} bytes
 * @param {object}   [options] mêmes options que `execInstr`
 * @returns {{ticks: number, regs: object, flags: object, ioOut: object[], mem: Uint8Array}}
 */
export function run(bytes, options = {}) {
  const { machine, ticks } = execInstr(bytes, options);
  return {
    ticks,
    regs: machine.cpu.getState(),
    flags: machine.flags,
    ioOut: machine.ioOut,
    ioIn: machine.ioIn,
    mem: machine.mem,
    machine,
  };
}

/**
 * Encode une paire de registres 8 bits en mot 16 bits (octet haut d'abord).
 * @param {string} hi nom du registre haut
 * @param {string} lo nom du registre bas
 * @param {TestMachine} machine
 * @returns {number}
 */
export function pair(hi, lo, machine) {
  return ((machine.getReg8(hi) << 8) | machine.getReg8(lo)) & 0xFFFF;
}