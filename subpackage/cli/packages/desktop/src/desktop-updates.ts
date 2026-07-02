import { invoke } from "@tauri-apps/api/core";

export type DesktopPlatform = "macos" | "windows" | "linux" | "unknown";
export type DesktopArch = "x64" | "arm64" | "unknown";

interface GitHubReleaseAsset {
	name?: string;
	browser_download_url?: string;
}

interface GitHubReleasePayload {
	tag_name?: string;
	html_url?: string;
	assets?: GitHubReleaseAsset[];
}

interface RawDesktopRuntimeInfo {
	platform?: string;
	arch?: string;
	version?: string;
}

export interface DesktopRuntimeInfo {
	platform: DesktopPlatform;
	arch: DesktopArch;
	version: string;
}

export interface DesktopUpdateStatus {
	checkedAt: number;
	platform: DesktopPlatform;
	arch: DesktopArch;
	currentVersion: string;
	latestVersion: string | null;
	updateAvailable: boolean;
	releaseUrl: string;
	assetName: string | null;
	assetUrl: string | null;
	note: string | null;
}

const REPO_OWNER = "gustavonline";
const REPO_NAME = "pi-desktop";
const RELEASES_BASE_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;
const RELEASES_LATEST_API_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

function sanitizeVersion(raw: string | null | undefined): string {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return "0.0.0";
	return trimmed.replace(/^v/i, "").trim() || "0.0.0";
}

function parseSemver(version: string): [number, number, number] | null {
	const normalized = sanitizeVersion(version).split("-")[0] ?? "";
	const parts = normalized.split(".");
	if (parts.length < 2) return null;
	const major = Number(parts[0] ?? 0);
	const minor = Number(parts[1] ?? 0);
	const patch = Number(parts[2] ?? 0);
	if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
	if (major < 0 || minor < 0 || patch < 0) return null;
	return [major, minor, patch];
}

function isNewerVersion(latest: string, current: string): boolean {
	const latestTuple = parseSemver(latest);
	const currentTuple = parseSemver(current);
	if (latestTuple && currentTuple) {
		const [lMaj, lMin, lPatch] = latestTuple;
		const [cMaj, cMin, cPatch] = currentTuple;
		if (lMaj !== cMaj) return lMaj > cMaj;
		if (lMin !== cMin) return lMin > cMin;
		return lPatch > cPatch;
	}
	return sanitizeVersion(latest) !== sanitizeVersion(current);
}

function normalizePlatform(raw: string | null | undefined): DesktopPlatform {
	const value = (raw ?? "").toLowerCase();
	if (value.includes("mac") || value.includes("darwin")) return "macos";
	if (value.includes("win")) return "windows";
	if (value.includes("linux")) return "linux";
	return "unknown";
}

function normalizeArch(raw: string | null | undefined): DesktopArch {
	const value = (raw ?? "").toLowerCase();
	if (value.includes("aarch64") || value.includes("arm64")) return "arm64";
	if (value.includes("x86_64") || value.includes("amd64") || value.includes("x64") || value.includes("x86")) return "x64";
	return "unknown";
}

function inferRuntimeFromNavigator(): DesktopRuntimeInfo {
	const ua = (navigator.userAgent || "").toLowerCase();
	const platform = normalizePlatform([navigator.platform, ua].join(" "));
	const arch = normalizeArch(ua);
	return {
		platform,
		arch,
		version: "0.0.0",
	};
}

async function getRuntimeInfo(): Promise<DesktopRuntimeInfo> {
	try {
		const raw = await invoke<RawDesktopRuntimeInfo>("get_desktop_runtime_info");
		return {
			platform: normalizePlatform(raw.platform),
			arch: normalizeArch(raw.arch),
			version: sanitizeVersion(raw.version),
		};
	} catch {
		return inferRuntimeFromNavigator();
	}
}

function archHints(name: string): { mentionsArm64: boolean; mentionsX64: boolean } {
	const lower = name.toLowerCase();
	return {
		mentionsArm64: /(aarch64|arm64)/.test(lower),
		mentionsX64: /(x64|x86_64|amd64|win64|intel)/.test(lower),
	};
}

function scoreAsset(name: string, platform: DesktopPlatform, arch: DesktopArch): number {
	const lower = name.toLowerCase();
	const hints = archHints(lower);
	let score = -10_000;

	if (platform === "macos") {
		if (lower.endsWith(".dmg")) score = 500;
		else if (lower.endsWith(".app.tar.gz")) score = 380;
		else return score;
	}

	if (platform === "windows") {
		if (lower.endsWith(".msi")) score = 500;
		else if (lower.endsWith(".exe")) score = 470;
		else return score;
	}

	if (platform === "linux") {
		if (lower.endsWith(".appimage")) score = 500;
		else if (lower.endsWith(".deb")) score = 470;
		else return score;
	}

	if (platform === "unknown") {
		if (lower.endsWith(".dmg")) score = 300;
		else if (lower.endsWith(".msi")) score = 300;
		else if (lower.endsWith(".exe")) score = 290;
		else if (lower.endsWith(".appimage")) score = 280;
		else if (lower.endsWith(".deb")) score = 260;
		else return score;
	}

	if (arch === "arm64") {
		if (hints.mentionsArm64) score += 40;
		if (hints.mentionsX64) score -= 30;
	} else if (arch === "x64") {
		if (hints.mentionsX64) score += 40;
		if (hints.mentionsArm64) score -= 30;
	}

	return score;
}

function selectBestAsset(
	assets: GitHubReleaseAsset[],
	platform: DesktopPlatform,
	arch: DesktopArch,
): { name: string; url: string } | null {
	const normalizedAssets = assets
		.map((asset) => ({
			name: (asset.name ?? "").trim(),
			url: (asset.browser_download_url ?? "").trim(),
		}))
		.filter((asset) => asset.name.length > 0 && asset.url.length > 0);

	if (normalizedAssets.length === 0) return null;

	const scored = normalizedAssets
		.map((asset) => ({
			...asset,
			score: scoreAsset(asset.name, platform, arch),
		}))
		.sort((a, b) => b.score - a.score);

	const winner = scored[0];
	if (!winner || winner.score <= -10_000) return null;
	return { name: winner.name, url: winner.url };
}

export async function fetchDesktopUpdateStatus(): Promise<DesktopUpdateStatus> {
	const runtime = await getRuntimeInfo();
	const response = await fetch(RELEASES_LATEST_API_URL, {
		headers: {
			Accept: "application/vnd.github+json",
		},
	});

	if (!response.ok) {
		throw new Error(`Desktop release check failed (HTTP ${response.status})`);
	}

	const release = (await response.json()) as GitHubReleasePayload;
	const latestVersionRaw = (release.tag_name ?? "").trim();
	const latestVersion = latestVersionRaw ? sanitizeVersion(latestVersionRaw) : null;
	const currentVersion = sanitizeVersion(runtime.version);
	const releaseUrl = typeof release.html_url === "string" && release.html_url.trim().length > 0
		? release.html_url.trim()
		: RELEASES_BASE_URL;

	const updateAvailable = Boolean(latestVersion && isNewerVersion(latestVersion, currentVersion));
	const asset = selectBestAsset(release.assets ?? [], runtime.platform, runtime.arch);

	let note: string | null = null;
	if (updateAvailable && !asset) {
		note = "No installer matched this platform automatically. Open the release page to choose an asset manually.";
	} else if (runtime.platform === "unknown") {
		note = "Could not detect desktop platform reliably; using generic asset matching.";
	}

	return {
		checkedAt: Date.now(),
		platform: runtime.platform,
		arch: runtime.arch,
		currentVersion,
		latestVersion,
		updateAvailable,
		releaseUrl,
		assetName: asset?.name ?? null,
		assetUrl: asset?.url ?? null,
		note,
	};
}

export async function openDesktopUpdate(status: DesktopUpdateStatus): Promise<void> {
	const target = status.assetUrl ?? status.releaseUrl;
	if (!target) throw new Error("No desktop update URL available");

	try {
		const { open } = await import("@tauri-apps/plugin-shell");
		await open(target);
	} catch {
		window.open(target, "_blank", "noopener,noreferrer");
	}
}
