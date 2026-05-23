import { isApiKeyValid } from './api-keys';
import { type JWTOptions, createJWT, verifyJWT } from './jwt';
import type { ApiKey, IAuthProvider, TokenPayload, User } from './types';
import {
  addApiKeyToUser,
  authenticateUser,
  changeUserPassword,
  createUser,
  getUserByApiKey,
} from './users';

export interface AuthProviderOptions extends JWTOptions {}

export class AuthProvider implements IAuthProvider {
  private jwtOptions: JWTOptions;

  constructor(options: AuthProviderOptions) {
    this.jwtOptions = options;
  }

  async register(username: string, password: string): Promise<User> {
    return createUser(username, password);
  }

  async login(
    username: string,
    password: string,
  ): Promise<{ user: User; jwt: string }> {
    const user = await authenticateUser(username, password);
    if (!user) {
      throw new Error('Invalid username or password.');
    }
    const jwt = await this.generateJWT(user);
    return { user, jwt };
  }

  async createApiKey(
    userId: string,
    name: string,
    scopes: string[],
  ): Promise<ApiKey> {
    return addApiKeyToUser(userId, name, scopes);
  }

  async validateApiKey(key: string): Promise<User | null> {
    const user = getUserByApiKey(key);
    if (!user) return null;

    const apiKey = user.apiKeys.find((k: { key: string }) => k.key === key);
    if (!apiKey || !isApiKeyValid(apiKey)) return null;

    return user;
  }

  async generateJWT(user: User): Promise<string> {
    return createJWT(user, this.jwtOptions);
  }

  async validateJWT(token: string): Promise<TokenPayload | null> {
    return verifyJWT(token, this.jwtOptions.secret);
  }

  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<void> {
    return changeUserPassword(userId, oldPassword, newPassword);
  }
}
