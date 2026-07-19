// Web HTTP API — auth surface.
//
// Source of truth: /lib/auth/session.ts, /lib/auth/pair-code.ts,
// /lib/extra/auth/types.ts
//
// These types mirror the wire shape used by the Web tier's auth
// patterns (cookie session, pair-code exchange, API key, JWT). They
// are hand-ported as structural interfaces so the SDK type-checks
// without depending on `next/`, `drizzle-orm`, or the Web tier's
// runtime modules. Keep them 1:1 with the source — drift is caught by
// `scripts/regen-web.py`.

// Source: /lib/auth/session.ts
export interface AuthSession {
  userId: string;
  username: string;
  issuedAt: number;
  expiresAt: number;
  /**
   * Device id (jti). Present on tokens issued via CLI pairing.
   * Absent on legacy tokens and on web cookie sessions (which are
   * not bound to a device row).
   */
  jti?: string;
}

// Source: /lib/auth/pair-code.ts
export interface PairCodeEntry {
  userId: string;
  username: string;
  label?: string;
  createdAt: number;
}

// Source: /lib/auth/pair-code.ts
export interface PairCodeListing {
  code: string;
  label?: string;
  createdAt: number;
  expiresInSeconds: number;
}

// Source: /lib/extra/auth/types.ts
//
// Wire-safe subset of the source `User` interface. The source extends
// a `StoredUser` row that pulls in drizzle-orm inferred column types
// and includes `passwordHash`; the SDK surface omits `passwordHash`
// because it is a server-side credential that must never appear in
// SDK-facing DTOs or be sent over the wire to extension authors and
// external integrators. Web tier routes that return a user to SDK
// consumers should map internal `StoredUser` rows through a sanitizer
// that drops `passwordHash` before serialization.
export interface User {
  id: string;
  username: string;
  roles: string[];
  apiKeys: ApiKey[];
  createdAt: number;
}

// Source: /lib/extra/auth/types.ts
export interface ApiKey {
  key: string;
  name: string;
  scopes: string[];
  expiresAt?: number;
}

// Source: /lib/extra/auth/types.ts
export interface TokenPayload {
  sub: string;
  username: string;
  iat: number;
  exp: number;
}

// Source: /lib/extra/auth/types.ts
export type L2AuthorizationWindow =
  | 'once'
  | '10min'
  | '1hour'
  | '1day'
  | 'session';

// Source: /lib/extra/auth/types.ts
//
// AuthProvider contract implemented by the Web tier's pluggable auth
// backends. Mirrored here so SDK consumers can declare
// interop/compatibility with the same interface. Method signatures
// preserve the source's exact parameter shapes and return types.
export interface IAuthProvider {
  register(username: string, password: string): Promise<User>;
  login(
    username: string,
    password: string,
  ): Promise<{ user: User; jwt: string }>;
  createApiKey(userId: string, name: string, scopes: string[]): Promise<ApiKey>;
  validateApiKey(key: string): Promise<User | null>;
  generateJWT(user: User): Promise<string>;
  validateJWT(token: string): Promise<TokenPayload | null>;
  changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<void>;
}
