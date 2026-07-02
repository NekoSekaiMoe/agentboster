import type { AppSettings } from "../../shared/types";

type TelemetrySettingsStore = {
	get: () => AppSettings;
	update: (patch: Partial<AppSettings>) => Promise<AppSettings>;
};

type TelemetryMetadata = {
	appVersion: string;
	platform: NodeJS.Platform;
	arch: NodeJS.Architecture;
	packaged: boolean;
};

type TelemetryConfig = {
	projectKey?: string;
	host?: string;
};

type CaptureRequest = {
	url: string;
	body: {
		api_key: string;
		event: "app_heartbeat";
		distinct_id: string;
		properties: {
			app_version: string;
			platform: NodeJS.Platform;
			arch: NodeJS.Architecture;
			packaged: boolean;
			install_id: string;
			$set: {
				app_version: string;
				platform: NodeJS.Platform;
				arch: NodeJS.Architecture;
				packaged: boolean;
			};
		};
	};
};

export type TelemetryCapture = (request: CaptureRequest) => Promise<void>;

export type TelemetryServiceOptions = {
	settingsStore: TelemetrySettingsStore;
	capture: TelemetryCapture;
	config: TelemetryConfig;
	metadata: TelemetryMetadata;
	now?: () => Date;
	createInstallId?: () => string;
};

export class TelemetryService {
	private readonly now: () => Date;
	private readonly createInstallId: () => string;

	constructor(private readonly options: TelemetryServiceOptions) {
		this.now = options.now ?? (() => new Date());
		this.createInstallId = options.createInstallId ?? (() => crypto.randomUUID());
	}

	async sendHeartbeat() {
		const settings = this.options.settingsStore.get();
		const projectKey = this.options.config.projectKey?.trim();
		const host = normalizePostHogHost(this.options.config.host);
		if (
			!settings.telemetryEnabled ||
			!this.options.metadata.packaged ||
			!projectKey ||
			!host
		) {
			return;
		}

		const today = toLocalDateKey(this.now());
		if (settings.telemetryLastHeartbeatDate === today) return;

		const installId = settings.telemetryInstallId || this.createInstallId();
		await this.options.capture({
			url: `${host}/capture/`,
			body: {
				api_key: projectKey,
				event: "app_heartbeat",
				distinct_id: installId,
				properties: {
					app_version: this.options.metadata.appVersion,
					platform: this.options.metadata.platform,
					arch: this.options.metadata.arch,
					packaged: this.options.metadata.packaged,
					install_id: installId,
					$set: {
						app_version: this.options.metadata.appVersion,
						platform: this.options.metadata.platform,
						arch: this.options.metadata.arch,
						packaged: this.options.metadata.packaged,
					},
				},
			},
		});

		// Only mark the day as sent after PostHog accepts the request; transient
		// network failures should retry on next launch instead of silently losing data.
		await this.options.settingsStore.update({
			telemetryInstallId: installId,
			telemetryLastHeartbeatDate: today,
		});
	}
}

function normalizePostHogHost(host?: string) {
	const trimmed = host?.trim();
	if (!trimmed) return "";
	return trimmed.replace(/\/+$/, "");
}

function toLocalDateKey(date: Date) {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}
