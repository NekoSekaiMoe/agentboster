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
import { execSync } from "node:child_process";

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
//    GNU tar and BSD tar (macOS default /usr/bin/tar) take different
//    flags for forcing owner/group/mtime. Detect which one is on PATH
//    and use the matching invocation — otherwise macOS runners fail
//    with "tar: Option --mtime=@0 is not supported".
execSync(buildTarCommand({
	stagingDir,
	outPath,
	dirName,
}), { stdio: "inherit" });

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

function shellQuote(s) {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a reproducible tar(1) command for the staging directory.
 *
 * GNU tar (Linux) and BSD tar (macOS /usr/bin/tar) take incompatible
 * flags for forcing owner/group/mtime:
 *   - GNU: `--owner=0 --group=0 --mtime=@0 --format=ustar`
 *   - BSD: `--uid 0 --gid 0 --mtime 0 --format ustar`
 *
 * Detect which binary is on PATH and emit the matching invocation.
 * Falls back to plain `tar` (no reproducibility flags) if the version
 * string doesn't match either known pattern, so we always produce a
 * tarball rather than crash on an unexpected tar implementation.
 *
 * Note: GNU tar accepts `--mtime='@0'` (epoch seconds via @ prefix);
 * BSD tar's `--mtime` takes a literal epoch integer, no @.
 */
function buildTarCommand({ stagingDir, outPath, dirName }) {
	const isGnuTar = (() => {
		try {
			const out = execSync("tar --version", { stdio: ["ignore", "pipe", "ignore"] }).toString();
			return /GNU tar/i.test(out);
		} catch {
			return false;
		}
	})();

	const args = [
		"tar",
		"-C", shellQuote(stagingDir),
	];
	if (isGnuTar) {
		args.push(
			"--owner=0",
			"--group=0",
			"--mtime=@0",
			"--format=ustar",
		);
	} else {
		// BSD tar (macOS default). `--mtime 0` is the epoch; the @ prefix
		// is GNU-only and BSD tar rejects it with "Option --mtime=@0 is
		// not supported". `--format ustar` is BSD's syntax (space, not =).
		args.push(
			"--uid", "0",
			"--gid", "0",
			"--mtime", "0",
			"--format", "ustar",
		);
	}
	args.push(
		"-czf", shellQuote(outPath),
		shellQuote(dirName),
	);
	return args.join(" ");
}

/**
 * Package computer-use-mcp binary into the tarball.
 * The binary must be built beforehand (cargo build --release).
 */
function packageComputerUseMcp(destDir) {
	const binaryName = process.platform === 'win32' ? 'computer-use-mcp.exe' : 'computer-use-mcp';
	const mcpWorkspaceDir = resolve(root, '..', 'computer-use-mcp');
	const mcpCrateDir = join(mcpWorkspaceDir, 'server');

	if (!existsSync(mcpCrateDir)) {
		console.warn(`⚠️  computer-use-mcp crate not found at ${mcpCrateDir}, skipping`);
		console.warn('    CLI will work without computer-use capabilities.');
		return;
	}

	// Try to find pre-built binary (CI or local cargo build)
	// Cargo puts artifacts in the workspace-level target/, not server/target/
	const rustTarget = getRustTarget();
	const candidates = [
		rustTarget ? join(mcpWorkspaceDir, 'target', rustTarget, 'release', binaryName) : null,
		join(mcpWorkspaceDir, 'target', 'release', binaryName),
	].filter(Boolean);

	let sourcePath = null;
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			sourcePath = candidate;
			break;
		}
	}

	// If not found, try to build it
	if (!sourcePath && rustTarget) {
		try {
			console.log(`Building computer-use-mcp for ${rustTarget}...`);
			execSync(`cargo build --release --target ${rustTarget}`, {
				cwd: mcpCrateDir,
				stdio: 'inherit',
			});
			sourcePath = join(mcpWorkspaceDir, 'target', rustTarget, 'release', binaryName);
		} catch (err) {
			console.warn(`⚠️  Failed to build computer-use-mcp: ${err.message}`);
			console.warn('    CLI will work without computer-use capabilities.');
			return;
		}
	}

	if (!sourcePath || !existsSync(sourcePath)) {
		console.warn('⚠️  computer-use-mcp binary not found after build attempt, skipping');
		console.warn('    CLI will work without computer-use capabilities.');
		return;
	}

	// Copy to destDir (same level as agentboster-cli)
	const destPath = join(destDir, binaryName);
	copyFileSync(sourcePath, destPath);
	if (process.platform !== 'win32') {
		chmodSync(destPath, 0o755);
	}
	console.log(`✓ Copied computer-use-mcp → ${binaryName}`);
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

