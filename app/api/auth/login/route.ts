import {
  AUTH_TTL_SECONDS,
  createAuthToken,
  validateCredentials,
} from '@/lib/auth';
import { seedInitialUser, userCount } from '@/lib/core/db/users';
import { createLogger } from '@/lib/utils/logger';
import { z } from 'zod';

const logger = createLogger('api.auth.login');

const requestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function POST(request: Request) {
  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await request.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        { ok: false, error: 'Username and password are required.' },
        { status: 400 },
      );
    }
    return Response.json(
      { ok: false, error: 'Invalid request body.' },
      { status: 400 },
    );
  }

  const username = body.username.trim();
  const password = body.password;

  if (!username || !password) {
    return Response.json(
      { ok: false, error: 'Username and password are required.' },
      { status: 400 },
    );
  }

  // Seed initial user from env vars if no users exist yet. Mirrors
  // loginAction in app/(auth)/actions.ts so first-install works whether
  // the client is a browser or a CLI.
  const count = await userCount();
  if (count === 0) {
    await seedInitialUser();
  }

  const user = await validateCredentials({ username, password });
  if (!user) {
    logger.info('login:invalid_credentials', { username });
    return Response.json(
      { ok: false, error: 'Invalid username or password.' },
      { status: 401 },
    );
  }

  const token = await createAuthToken(user.id, user.username);
  const issuedAt = Date.now();
  const expiresAt = issuedAt + AUTH_TTL_SECONDS * 1000;

  logger.info('login:success', { userId: user.id });

  return Response.json({
    ok: true,
    token,
    expiresAt,
    user: {
      id: user.id,
      username: user.username,
    },
  });
}
