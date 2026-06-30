/**
 * Inline base64 of the announcement image. The .base64 file is a plain
 * text file produced from `base64 -w0 clankolas.png`, bundled by
 * esbuild's text loader so the PNG ships inside agentboster.cjs.
 */
import data from "./clankolas.png.base64";
import fs from "node:fs";
import { getBundledInteractiveAssetPath } from "../../../config.ts";

const IMAGE_FILENAME = "clankolas.png";

let cached: string | undefined;
let attempted = false;

/**
 * Return base64-encoded PNG bytes for the bundled announcement image.
 * Tries the esbuild-inlined copy first, then falls back to the file
 * on disk (used in tsx dev mode where the .base64 import resolves to
 * a real file path).
 */
export function getClankolasBase64(): string | undefined {
	if (attempted) return cached;
	attempted = true;
	// The inlined data has no newlines (we used `base64 -w0`); strip
	// any whitespace just in case the loader added trailing newline.
	const inline = (data as unknown as string)?.trim();
	if (inline && /^[A-Za-z0-9+/=\s]+$/.test(inline) && inline.length > 100) {
		cached = inline;
		return cached;
	}
	try {
		cached = fs
			.readFileSync(getBundledInteractiveAssetPath(IMAGE_FILENAME))
			.toString("base64");
	} catch {
		cached = undefined;
	}
	return cached;
}
