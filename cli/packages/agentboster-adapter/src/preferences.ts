/**
 * Read and write the user's model preferences on the web backend.
 *
 * Mirrors GET/PATCH /api/cli/preferences. The same blob is used by the
 * web chat and IM channels, so a model/thinking change made from the
 * terminal propagates to every surface and vice versa. The CLI never
 * stores these locally — it always pulls the latest on startup and
 * pushes on change.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface UserPreferences {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface PreferencesResponse {
	ok: boolean;
	preferences: UserPreferences | null;
}

/**
 * Fetch the caller's current preferences. Returns null on auth failure
 * or network error — caller should treat null as "no preference set".
 */
export async function fetchUserPreferences(baseUrl: string, token: string): Promise<UserPreferences | null> {
	const root = baseUrl.replace(/\/$/, "");
	try {
		const response = await fetch(`${root}/api/cli/preferences`, {
			headers: {
				authorization: `Bearer ${token}`,
				cookie: `clawless-auth=${token}`,
			},
		});
		if (!response.ok) return null;
		const body = (await response.json()) as PreferencesResponse;
		return body.preferences ?? null;
	} catch {
		return null;
	}
}

/**
 * Merge-patch the caller's preferences. `undefined` fields are left
 * unchanged on the server; `null` clears them. Resolves to the updated
 * preferences (or null if the request failed).
 */
export async function patchUserPreferences(
	baseUrl: string,
	token: string,
	patch: {
		model?: string | null;
		thinkingLevel?: ThinkingLevel | null;
	},
): Promise<UserPreferences | null> {
	const root = baseUrl.replace(/\/$/, "");
	try {
		const response = await fetch(`${root}/api/cli/preferences`, {
			method: "PATCH",
			headers: {
				authorization: `Bearer ${token}`,
				cookie: `clawless-auth=${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(patch),
		});
		if (!response.ok) return null;
		const body = (await response.json()) as PreferencesResponse;
		return body.preferences ?? null;
	} catch {
		return null;
	}
}
