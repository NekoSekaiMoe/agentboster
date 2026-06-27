import * as esbuild from "esbuild";

/**
 * Bundle agentboster CLI into a single JS file.
 *
 * Entry:  packages/coding-agent/src/cli.ts
 * Output: packages/coding-agent/dist/agentboster.js (standalone, ESM, node22)
 *
 * All workspace packages (tui, ai, agent, adapter, coding-agent) and
 * their TS sources are inlined into the bundle. Native deps (node:
 * built-ins, packages with binary bindings) stay external — they're
 * resolved at runtime from node_modules.
 */

const entry = "packages/coding-agent/src/cli.ts";
const outfile = "packages/coding-agent/dist/agentboster.cjs";

/** Packages to keep external (don't try to bundle). */
const external = [
	// Node built-ins — implicit with platform=node but keep for clarity.
	"node:*",
	// Native addons / postinstall-installed binaries — must stay external.
	"node-pty",
	"zlib-sync",
	"playwright",
	"@playwright/test",
	"sharp",
	"canvas",
	"fsevents",
	// Heavy optional deps we don't want to inline.
	"bun",
	// Packages that ship pre-built .node files or WASM that esbuild can't bundle safely.
	"iconv-lite",
];

try {
	await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		platform: "node",
		format: "cjs",
		target: "node22",
		outfile,
		sourcemap: false,
		minify: false,
		keepNames: true,
		// Provide import.meta.url shim for CJS bundle (config.ts uses it
		// to locate package root). Without this, `import.meta.url` is
		// undefined and fileURLToPath throws.
		banner: {
			js: [
				"const __agentboster_import_meta_url = require('url').pathToFileURL(__filename).href;",
				"const import_meta_url = __agentboster_import_meta_url;",
			].join("\n"),
		},
		define: {
			"import.meta.url": "__agentboster_import_meta_url",
		},
		external,
		logLevel: "info",
	});
} catch (err) {
	console.error("bundle failed:", err);
	process.exit(1);
}

console.log(`bundle: ${outfile}`);
