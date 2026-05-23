export interface User {
  id: string;
  username: string;
  passwordHash?: string;
  roles: string[];
  apiKeys: ApiKey[];
  createdAt: number;
}

export interface ApiKey {
  key: string;
  name: string;
  scopes: string[];
  expiresAt?: number;
}

export interface TokenPayload {
  sub: string;
  username: string;
  iat: number;
  exp: number;
}

export type L2AuthorizationWindow =
  | 'once'
  | '10min'
  | '1hour'
  | '1day'
  | 'session';

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
