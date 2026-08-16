/**
 * Base64 of the announcement image, loaded at runtime from the PNG that
 * copy-assets ships alongside both layouts (dist and source). The previous
 * static import of `./clankolas.png.base64` (an esbuild text-loader asset)
 * broke non-bundle modes: the .base64 file is never emitted to dist, so
 * Node/jiti failed resolving it. Reading the PNG directly keeps a single
 * code path that works in dev, dist, bundle, and extension-loader modes.
 */

import fs from 'node:fs';
import { getBundledInteractiveAssetPath } from '../../../config.ts';

const IMAGE_FILENAME = 'clankolas.png';

let cached: string | undefined;
let attempted = false;

/**
 * Return base64-encoded PNG bytes for the bundled announcement image.
 */
export function getClankolasBase64(): string | undefined {
  if (attempted) return cached;
  attempted = true;
  try {
    cached = fs
      .readFileSync(getBundledInteractiveAssetPath(IMAGE_FILENAME))
      .toString('base64');
  } catch {
    cached = undefined;
  }
  return cached;
}
