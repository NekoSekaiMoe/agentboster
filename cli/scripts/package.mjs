import {
	chmodSync,
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
 *   agentboster        shell entry (chmod +x, execs node agentboster.cjs)
 *   agentboster.cjs    single-file bundle (all JS + inlined theme
 *                      JSON, export templates, vendored libs, and
 *                      the announcement PNG; ~9 MB)
 *
 * Runtime requirements on the target machine:
 *   - Node.js >= 22 on PATH (the `agentboster` wrapper is `exec node …`)
 *   - GNU tar on the build machine (used only for packaging)
 *
 * No node_modules, no dist/, no package.json needed at runtime: every
 * asset is inlined into agentboster.cjs by esbuild.
 */

const root = resolveRoot();
const codingAgentDir = join(root, "packages", "coding-agent");
const cjsPath = join(codingAgentDir, "dist", "agentboster.cjs");
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
writeFileSync(join(stagingInner, "agentboster.cjs"), readFileSync(cjsPath));
chmodSync(join(stagingInner, "agentboster.cjs"), 0o755);

// 2) Shell entry — convenience so users run `./agentboster` not
//    `./agentboster.cjs`. `exec node` replaces the shell process so
//    signals (Ctrl+C, SIGTERM) reach the CLI directly.
const entryScript = [
	"#!/bin/sh",
	'# Shell entry for agentboster CLI. Requires Node.js >= 22 on PATH.',
	'exec node "$(dirname "$0")/agentboster.cjs" "$@"',
	"",
].join("\n");
writeFileSync(join(stagingInner, "agentboster"), entryScript, { mode: 0o755 });
chmodSync(join(stagingInner, "agentboster"), 0o755);

// 3) Create the tarball. GNU tar; --owner=0 --group=0 --mtime=@0 for
//    reproducible output (same inputs → byte-identical archive).
execSync(
	`tar -C ${shellQuote(stagingDir)} ` +
		`--owner=0 --group=0 --mtime=@0 ` +
		`--format=ustar ` +
		`-czf ${shellQuote(outPath)} ${shellQuote(dirName)}`,
	{ stdio: "inherit" },
);

// Cleanup staging.
rmSync(stagingDir, { recursive: true, force: true });

const sizeMb = (statSync(outPath).size / 1024 / 1024).toFixed(1);
console.log(`packaged: ${tarGz} (${sizeMb} MB)`);
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
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
