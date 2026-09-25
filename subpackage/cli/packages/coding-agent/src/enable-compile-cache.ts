/**
 * Enable Node's persistent compile cache as the very first module the CLI
 * evaluates (pi 0.86.1), reducing repeat launch time by letting V8 reuse
 * compiled bytecode. ESM evaluates imports in order, so importing this
 * module before everything else arms the cache before any heavier module
 * is compiled. No-op on runtimes without the API.
 */
import * as nodeModule from 'node:module';

try {
  (
    nodeModule as typeof nodeModule & {
      enableCompileCache?: () => unknown;
    }
  ).enableCompileCache?.();
} catch {
  // Ignore: cache directory may be unwritable or the API may be missing.
}
