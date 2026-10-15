import { defineConfig } from 'vitest/config';

import base from './vitest.config.mjs';

/**
 * Configuration Vitest — exécution de la seule suite longue ZEXALL.
 *
 * ZEXALL est opt-in parce qu'elle coûte plusieurs minutes (~5,8 milliards
 * d'instructions). On l'active ici via `test.env` plutôt qu'en exportant
 * `ZEXALL=1` dans le script npm : `test.env` est portable (Windows compris),
 * alors que la syntaxe POSIX `VAR=valeur commande` échoue sous cmd.exe.
 *
 *   npm run test:zexall
 *
 * On n'utilise volontairement PAS `mergeConfig` : il **concatène** les
 * tableaux, donc `include` se retrouverait contenir à la fois le motif glob
 * de la config de base et le chemin du fichier ZEXALL — la suite rapide
 * serait alors relancée en plus de ZEXALL. On reconstruit donc l'objet.
 */
export default defineConfig({
  // Les plugins (couverture V8) sont repris de la config de base.
  plugins: base.plugins,

  test: {
    ...base.test,

    // Uniquement ZEXALL — pas de fusion avec le motif glob de la base.
    include: ['tests/z80/zexall.test.mjs'],

    // Levée du drapeau lu par `tests/z80/zexall.test.mjs`.
    env: { ZEXALL: '1' },

    // Le test porte lui-même un timeout de 30 min ; celui-ci doit le
    // dépasse, sinon Vitest l'interrompt avant.
    testTimeout: 30 * 60 * 1000,

    // Une seule exécution : lancer ZEXALL en parallèle ne servirait à rien
    // et doublerait la charge mémoire.
    fileParallelism: false,
  },
});
