import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync } from "node:child_process";

/**
 * Package the agentboster-cli into a self-contained tarball.
 *
 * Output layout (under agentboster-cli-<version>/):
 *   agentboster-cli        shell entry (chmod +x, execs node agentboster-cli.cjs)
 *   agentboster-cli.cjs    single-file bundle (all JS + inlined theme
 *                      JSON, export templates, vendored libs, and
 *                      the announcement PNG; ~9 MB)
 *
 * Runtime requirements on the target machine:
 *   - Node.js >= 22 on PATH (the `agentboster-cli` wrapper is `exec node …`)
 *   - GNU tar on the build machine (used only for packaging)
 *
 * No node_modules, no dist/, no package.json needed at runtime: every
 * asset is inlined into agentboster-cli.cjs by esbuild.
 */

const root = resolveRoot();
const codingAgentDir = join(root, "packages", "coding-agent");
const cjsPath = join(codingAgentDir, "dist", "agentboster-cli.cjs");
const pkgPath = join(codingAgentDir, "package.json");

if (!existsSync(cjsPath)) {
	console.error(
		"agentboster-cli.cjs not found. Run `npm run bundle` before `npm run package`.",
	);
	process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
// Allow CI / release pipelines to override the version without editing
// package.json. The override is purely cosmetic — it only affects the
// tarball name + the version banner the CLI prints on first run.
// Falls back to package.json's version when unset (local dev builds).
const version = process.env.AGENTBOSTER_CLI_VERSION || pkg.version || "0.0.0";
const dirName = `agentboster-cli-${version}`;
const tarGz = `${dirName}.tar.gz`;
const stagingDir = join(root, ".pkg-staging");
const stagingInner = join(stagingDir, dirName);
const outPath = join(root, tarGz);

// Reset staging.
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingInner, { recursive: true });

// 1) agentboster-cli.cjs (executable bit for direct `./agentboster-cli.cjs` use).
writeFileSync(join(stagingInner, "agentboster-cli.cjs"), readFileSync(cjsPath));
chmodSync(join(stagingInner, "agentboster-cli.cjs"), 0o755);

// 2) Shell entry — convenience so users run `./agentboster-cli` not
//    `./agentboster-cli.cjs`. `exec node` replaces the shell process so
//    signals (Ctrl+C, SIGTERM) reach the CLI directly.
const entryScript = [
	"#!/bin/sh",
	'# Shell entry for agentboster-cli. Requires Node.js >= 22 on PATH.',
	'exec node "$(dirname "$0")/agentboster-cli.cjs" "$@"',
	"",
].join("\n");
writeFileSync(join(stagingInner, "agentboster-cli"), entryScript, { mode: 0o755 });
chmodSync(join(stagingInner, "agentboster-cli"), 0o755);

// 3) computer-use-mcp binary (same directory)
packageComputerUseMcp(stagingInner);

// 4) Create the tarball with reproducible metadata.
//    Pass argv directly via execFileSync (no shell) so paths containing
//    spaces or drive letters (Windows D:\…) don't need shell-specific
//    quoting. Going through cmd.exe via execSync(string) would wrap each
//    arg in single quotes that cmd treats as literal characters, making
//    tar try to open a filename like 'D:\…\foo.tar.gz' (with the quote
//    chars in the name).
{
	const { binary, args } = buildTarInvocation({ stagingDir, outPath, dirName });
	execFileSync(binary, args, { stdio: "inherit" });
}

// Cleanup staging.
rmSync(stagingDir, { recursive: true, force: true });

const sizeMb = (statSync(outPath).size / 1024 / 1024).toFixed(1);
console.log(`packaged: ${tarGz} (${sizeMb} MB)`);
console.log(`install:  tar xzf ${tarGz} && ./${dirName}/agentboster-cli --version`);

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

/**
 * Build a reproducible tar invocation for the staging directory.
 *
 * Returns `{ binary, args }` so the caller can use execFileSync(argv)
 * directly — no shell, no quoting. This matters on Windows, where
 * execSync(string) goes through cmd.exe and a Unix-style single-quote
 * wrap becomes part of the filename (`tar: Failed to open ''D:\…''`).
 *
 * Reproducibility flags (`--owner=0 --group=0 --mtime=@0 --format=ustar`)
 * are GNU tar syntax. macOS ships libarchive's bsdtar as `/usr/bin/tar`,
 * but the version on GitHub's macos-26 runner rejects `--mtime`
 * outright, so we prefer `gtar` (Homebrew GNU Tar, present on every
 * GitHub macOS runner) when available.
 *
 * Strategy (in order):
 *   1. `gtar` whose --version advertises "GNU tar" — macOS via Homebrew.
 *   2. `tar` whose --version advertises "GNU tar" — Linux distros.
 *   3. Plain `tar` (Windows ships libarchive bsdtar as tar.exe; bare
 *      metal containers may have only busybox tar). Emit a plain
 *      `-czf` invocation: still produces a valid tarball, just not
 *      byte-reproducible.
 */
function buildTarInvocation({ stagingDir, outPath, dirName }) {
	const binary = resolveTarBinary();
	const args = ["-C", stagingDir];
	if (binary !== null) {
		args.push("--owner=0", "--group=0", "--mtime=@0", "--format=ustar");
	}
	args.push("-czf", outPath, dirName);
	return { binary: binary ?? "tar", args };
}

/**
 * Locate a GNU tar binary, or return null if none is available.
 *
 * Prefers `gtar` (macOS Homebrew alias) over `tar` so macOS runners use
 * real GNU tar instead of the partial-compat bsdtar wrapper.
 */
function resolveTarBinary() {
	const candidates = ["gtar", "tar"];
	for (const cand of candidates) {
		try {
			const out = execSync(`${cand} --version`, {
				stdio: ["ignore", "pipe", "ignore"],
			}).toString();
			if (/GNU tar/i.test(out)) {
				return cand;
			}
		} catch {
			// Binary not on PATH; try the next candidate.
		}
	}
	return null;
}

/**
 * Package computer-use-mcp binary into the tarball.
 *
 * Binary lookup order (first hit wins):
 *   1. `$MCP_BINARY_PATH/<name>` — set by CI workflows that already
 *      built the per-target binary in a separate job and downloaded it
 *      via actions/download-artifact (e.g. build-all.yml's package-cli
 *      job). This is the only path that works on every runner OS,
 *      because the cargo build that produced the binary ran on a
 *      dedicated job with the right system deps installed.
 *   2. `subpackage/computer-use-mcp/target/<rust-target>/release/<name>`
 *      — local dev: user ran `cargo build --release --target <triple>`.
 *   3. `subpackage/computer-use-mcp/target/release/<name>`
 *      — local dev: user ran `cargo build --release` (host triple).
 *
 * We deliberately do NOT auto-invoke `cargo build` when no binary is
 * found. The previous behavior did, and it broke CI: package-cli runs
 * on macOS/Windows/Linux runners without the Linux-only system deps
 * (libwayland-dev, libpipewire-0.3-dev, …) that computer-use-mcp's
 * build script needs, so the auto-build panicked mid-tarball. Local
 * users get a clear warning telling them to build first.
 */
function packageComputerUseMcp(destDir) {
	const binaryName = process.platform === 'win32' ? 'computer-use-mcp.exe' : 'computer-use-mcp';
	const mcpWorkspaceDir = resolve(root, '..', 'computer-use-mcp');
	const rustTarget = getRustTarget();

	// 1) CI artifact directory (MCP_BINARY_PATH). Absolute or relative
	//    to the cli workspace root.
	const candidates = [];
	const envPath = process.env.MCP_BINARY_PATH;
	if (envPath) {
		candidates.push(resolve(root, envPath, binaryName));
	}
	// 2) Local cargo build with explicit --target.
	if (rustTarget) {
		candidates.push(join(mcpWorkspaceDir, 'target', rustTarget, 'release', binaryName));
	}
	// 3) Local cargo build on host triple.
	candidates.push(join(mcpWorkspaceDir, 'target', 'release', binaryName));

	const sourcePath = candidates.find(existsSync);
	if (!sourcePath) {
		console.warn('⚠️  computer-use-mcp binary not found.');
		console.warn('    Searched:');
		for (const c of candidates) console.warn(`      - ${c}`);
		console.warn('    Set MCP_BINARY_PATH to a directory containing the');
		console.warn(`    pre-built ${binaryName} (CI), or run \`cargo build --release\``);
		console.warn('    in subpackage/computer-use-mcp (local dev).');
		console.warn('    CLI will work without computer-use capabilities.');
		return;
	}

	// Copy to destDir (same level as agentboster-cli)
	const destPath = join(destDir, binaryName);
	copyFileSync(sourcePath, destPath);
	if (process.platform !== 'win32') {
		chmodSync(destPath, 0o755);
	}
	console.log(`✓ Copied computer-use-mcp → ${binaryName} (from ${sourcePath})`);
}

function getRustTarget() {
	const targets = {
		'darwin-arm64': 'aarch64-apple-darwin',
		'darwin-x64': 'x86_64-apple-darwin',
		'linux-x64': 'x86_64-unknown-linux-gnu',
		'linux-arm64': 'aarch64-unknown-linux-gnu',
		'win32-x64': 'x86_64-pc-windows-msvc',
	};
	return targets[`${process.platform}-${process.arch}`] || null;
}

