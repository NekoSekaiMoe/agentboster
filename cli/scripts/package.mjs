import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

/**
 * Package the agentboster CLI into a self-contained tarball.
 *
 * Output layout (under agentboster-cli-<version>/):
 *   agentboster              shell entry (chmod +x, execs node agentboster.cjs)
 *   agentboster.cjs          esbuild bundle (all JS, ~8MB)
 *   package.json             minimal manifest carrying name/version/piConfig
 *   dist/
 *     modes/interactive/theme/*.json    builtin color themes
 *     modes/interactive/assets/*.png    inline image placeholders
 *     core/export-html/template.*       session-export HTML template
 *     core/export-html/vendor/*.js      marked.js (vendored)
 *
 * Runtime requirements on the target machine:
 *   - Node.js >= 22 on PATH (the `agentboster` wrapper is `exec node …`)
 *   - GNU tar on the build machine (used only for packaging)
 *
 * No node_modules needed: every require() in agentboster.cjs resolves
 * to a Node.js builtin. The optional native addons (node-pty, zlib-sync,
 * playwright) are listed as esbuild externals but never reached in
 * CLI-only mode — upstream code paths that load them are gated behind
 * features this fork disables.
 */

const root = resolveRoot();
const codingAgentDir = join(root, "packages", "coding-agent");
const distDir = join(codingAgentDir, "dist");
const cjsPath = join(distDir, "agentboster.cjs");
const pkgPath = join(codingAgentDir, "package.json");

if (!existsSync(cjsPath)) {
	console.error(
		"agentboster.cjs not found. Run `npm run bundle` before `npm run package`.",
	);
	process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const version = pkg.version ?? "0.0.0";
const dirName = `agentboster-cli-${version}`;
const tarGz = `${dirName}.tar.gz`;
const stagingDir = join(root, ".pkg-staging");
const stagingInner = join(stagingDir, dirName);
const outPath = join(root, tarGz);

// Reset staging.
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingInner, { recursive: true });

// 1) agentboster.cjs (executable bit for direct `./agentboster.cjs` use).
cpSync(cjsPath, join(stagingInner, "agentboster.cjs"));
chmodSync(join(stagingInner, "agentboster.cjs"), 0o755);

// 2) Shell entry.
const entryScript = [
	"#!/bin/sh",
	'# Shell entry for agentboster CLI. Requires Node.js >= 22 on PATH.',
	'exec node "$(dirname "$0")/agentboster.cjs" "$@"',
	"",
].join("\n");
writeFileSync(join(stagingInner, "agentboster"), entryScript, {
	mode: 0o755,
});
chmodSync(join(stagingInner, "agentboster"), 0o755);

// 3) package.json (minimal, but keeps piConfig so APP_NAME resolves).
const manifest = {
	name: "agentboster-cli",
	version,
	description: pkg.description ?? "Agentboster CLI",
	type: "commonjs",
	main: "agentboster.cjs",
	bin: { agentboster: "agentboster" },
	piConfig: pkg.piConfig,
};
writeFileSync(
	join(stagingInner, "package.json"),
	`${JSON.stringify(manifest, null, 2)}\n`,
);

// 4) Runtime assets — mirror the copy-assets npm script layout.
const assetDirs = [
	"modes/interactive/theme",
	"modes/interactive/assets",
	"core/export-html/vendor",
];
for (const sub of assetDirs) {
	cpSync(join(distDir, sub), join(stagingInner, "dist", sub), {
		recursive: true,
	});
}
// Template files (not in a subdir of their own).
for (const f of ["template.html", "template.css", "template.js"]) {
	const src = join(distDir, "core", "export-html", f);
	if (existsSync(src)) {
		mkdirSync(join(stagingInner, "dist", "core", "export-html"), {
			recursive: true,
		});
		cpSync(src, join(stagingInner, "dist", "core", "export-html", f));
	}
}

// 5) Create the tarball. GNU tar; --owner=0 --group=0 for reproducible
//    output; --mtime anchors the timestamp so the same inputs produce
//    byte-identical archives.
execSync(
	`tar -C ${shellQuote(stagingDir)} ` +
		`--owner=0 --group=0 --mtime=@0 ` +
		`--format=ustar ` +
		`-czf ${shellQuote(outPath)} ${shellQuote(dirName)}`,
	{ stdio: "inherit" },
);

// Cleanup staging.
rmSync(stagingDir, { recursive: true, force: true });

const sizeKb = Math.round(statSync(outPath).size / 1024);
console.log(`packaged: ${tarGz} (${sizeKb} KB)`);
console.log(`install:  tar xzf ${tarGz} && ./${dirName}/agentboster --version`);

// ---------------------------------------------------------------------------

function resolveRoot() {
	const here = dirname(fileURLToPath(import.meta.url));
	let dir = here;
	while (dir !== dirname(dir)) {
		if (
			existsSync(join(dir, "package.json")) &&
			existsSync(join(dir, "packages"))
		) {
			return dir;
		}
		dir = dirname(dir);
	}
	return here;
}

function shellQuote(s) {
	// Simple POSIX single-quote — paths here contain no single quotes.
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
