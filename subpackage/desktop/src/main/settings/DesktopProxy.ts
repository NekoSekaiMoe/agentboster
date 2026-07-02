import { app, session } from "electron";
import type { AppSettings } from "../../shared/types";

type DesktopProxySettings = Pick<
	AppSettings,
	"desktopProxyEnabled" | "desktopProxyUrl" | "desktopProxyBypass"
>;

export async function applyDesktopProxy(settings: DesktopProxySettings) {
	const config = buildDesktopProxyConfig(settings);
	await session.defaultSession.setProxy(config);
	await app.setProxy(config);
}

function buildDesktopProxyConfig(settings: DesktopProxySettings) {
	if (!settings.desktopProxyEnabled) return { mode: "direct" as const };

	const proxyRules = normalizeProxyRules(settings.desktopProxyUrl);
	if (!proxyRules) return { mode: "direct" as const };

	return {
		mode: "fixed_servers" as const,
		proxyRules,
		proxyBypassRules: normalizeBypassRules(settings.desktopProxyBypass),
	};
}

function normalizeProxyRules(value: string) {
	const trimmed = value.trim();
	if (!trimmed) return "";
	const normalized = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
		? trimmed
		: `http://${trimmed}`;

	try {
		const url = new URL(normalized);
		if (!url.hostname) return "";
		return url.href.replace(/\/$/, "");
	} catch {
		return "";
	}
}

function normalizeBypassRules(value: string) {
	return value
		.split(/[,\n;]/)
		.map((item) => item.trim())
		.filter(Boolean)
		.join(";");
}
