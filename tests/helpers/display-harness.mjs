/** Small source-backed harness for the display frame synchronisation hook. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const DISPLAY_SOURCE_PATH = resolve(HERE, '../../site/js/core/video/Display.js');
const CACHE_KEY = '__DISPLAY_SYNC_EXPORT__';

export function loadDisplaySyncManager() {
  if (globalThis[CACHE_KEY]) return globalThis[CACHE_KEY];
  const source = readFileSync(DISPLAY_SOURCE_PATH, 'utf8');
  runInThisContext(
    `${source}\n;globalThis[${JSON.stringify(CACHE_KEY)}] = Display_Sync_Manager;`,
    { filename: DISPLAY_SOURCE_PATH },
  );
  return globalThis[CACHE_KEY];
}
