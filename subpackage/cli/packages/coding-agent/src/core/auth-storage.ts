/**
 * Minimal AuthStorage for the Agentboster fork.
 *
 * The full pi AuthStorage managed per-provider API keys, OAuth
 * tokens, credential files, locking, and refresh. In this fork auth
 * is a single bearer token stored in ~/.config/agentboster-cli/config.json and
 * handled by the adapter — AuthStorage only exists so pi's internal
 * is-authed checks pass.
 */

export type AuthCredential =
  | { type: 'api_key'; key: string; env?: string }
  | { type: 'oauth'; accessToken: string; expires: number };

export type AuthStorageData = Record<string, AuthCredential>;

export interface AuthStatus {
  type: 'api_key' | 'oauth' | 'none';
}

export interface GetApiKeyOptions {
  signal?: AbortSignal;
}

export class AuthStorage {
  private data: AuthStorageData = {};

  static create(_authPath?: string, _modelsPath?: string): AuthStorage {
    return new AuthStorage();
  }

  set(provider: string, credential: AuthCredential): void {
    this.data[provider] = credential;
  }

  get(provider: string): AuthCredential | undefined {
    return this.data[provider];
  }

  hasAuth(provider: string): boolean {
    return provider in this.data;
  }

  list(): string[] {
    return Object.keys(this.data);
  }

  getAuthStatus(provider: string): AuthStatus {
    const cred = this.data[provider];
    if (!cred) return { type: 'none' };
    return { type: cred.type };
  }

  setRuntimeApiKey(_provider: string, _apiKey: string): void {
    // Stored in ModelRegistry's runtimeApiKeys instead.
  }

  async getApiKey(provider: string): Promise<string | undefined> {
    const cred = this.data[provider];
    if (cred?.type === 'api_key') return cred.key;
    return undefined;
  }

  async login(_providerId: string): Promise<void> {
    throw new Error(
      'OAuth login not available in this fork. Use `agentboster-cli login`.',
    );
  }

  logout(provider: string): void {
    delete this.data[provider];
  }

  reload(): void {}
}
