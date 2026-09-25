import * as esbuild from "esbuild";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Bundle agentboster CLI into a single JS file.
 *
 * Entry:  packages/coding-agent/src/cli.ts
 * Output: packages/coding-agent/dist/agentboster-cli.js (standalone, ESM, node22)
 *
 * All workspace packages (tui, ai, agent, adapter, coding-agent) and
 * their TS sources are inlined into the bundle. Native deps (node:
 * built-ins, packages with binary bindings) stay external — they're
 * resolved at runtime from node_modules.
 */

const entry = "packages/coding-agent/src/cli.ts";
// The real bundle. The published entry (agentboster-cli.cjs) is a tiny shim
// that enables Node's persistent compile cache first (pi 0.86.1), then
// requires this file — same layout as pi's dist/bundle/{cli,cli-runtime}.js.
const runtimeOutfile = "packages/coding-agent/dist/agentboster-cli-runtime.cjs";
const shimOutfile = "packages/coding-agent/dist/agentboster-cli.cjs";

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
		outfile: runtimeOutfile,
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
		// Inline non-TS assets as modules so source code can `import`
		// them and have esbuild fold the contents into the bundle.
		loader: {
			".json": "json",
			".html": "text",
			".css": "text",
			".base64": "text",
		},
		plugins: [
			{
				name: "vendor-js-as-text",
				// The export-html templates import template.js and the
				// marked/highlight vendor JS as *text* (string content),
				// not as executable modules — they get embedded into the
				// generated HTML at runtime. Without this override esbuild
				// would parse and inline them as JS modules, polluting the
				// bundle scope. We re-resolve matching paths to a custom
				// namespace and serve their raw contents as text.
				setup(build) {
					const textSuffixes = [
						"template.js",
						"marked.min.js",
						"highlight.min.js",
					];
					const ns = "vendor-js-text";
					build.onResolve({ filter: /\.js$/ }, (args) => {
						if (textSuffixes.some((s) => args.path.endsWith(s))) {
							const resolved = path.resolve(
								path.dirname(args.importer),
								args.path,
							);
							return { path: resolved, namespace: ns };
						}
						return null;
					});
					build.onLoad({ filter: /.*/, namespace: ns }, (args) => {
						const contents = fs.readFileSync(args.path, "utf8");
						return { contents, loader: "text" };
					});
				},
			},
		],
		external,
		logLevel: "info",
	});
} catch (err) {
	console.error("bundle failed:", err);
	process.exit(1);
}

// Entry shim: enable Node's persistent compile cache before loading the
// runtime bundle, reducing repeat launch time. Mirrors pi 0.86.1's
// dist/bundle/cli.js. enableCompileCache() landed in Node 22.8; the CLI
// requires >= 22.19, but keep the optional-call guard for exotic runtimes.
fs.writeFileSync(
	shimOutfile,
	[
		"#!/usr/bin/env node",
		"// Entry shim for agentboster-cli: enables Node's persistent compile cache",
		"// (pi 0.86.1) and loads the real bundle. Keep this file tiny — it must stay",
		"// outside the big require so the cache is armed before compilation.",
		"try { require('node:module').enableCompileCache?.(); } catch {}",
		"require('./agentboster-cli-runtime.cjs');",
		"",
	].join("\n"),
);

console.log(`bundle: ${runtimeOutfile}`);
console.log(`bundle: ${shimOutfile} (compile-cache shim)`);
