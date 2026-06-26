import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getAuthConfigStatus } from '@/lib/auth/config';
import { AUTH_COOKIE_NAME } from '@/lib/auth/constants';
import { verifyAuthToken } from '@/lib/auth/session';

function isPublicAssetPath(pathname: string): boolean {
  return /\.[^/]+$/.test(pathname);
}

function isLoginPath(pathname: string): boolean {
  if (pathname === '/login' || pathname.startsWith('/login/')) {
    return true;
  }

  // REST login endpoint — must be reachable before authentication.
  // The route handler performs its own credential validation and issues
  // a token; middleware auth would create a chicken-and-egg.
  if (pathname === '/api/auth/login') {
    return true;
  }

  return false;
}

function isAlwaysBypassPath(pathname: string): boolean {
  if (pathname.startsWith('/.well-known/workflow/')) {
    return true;
  }

  // Internal IM stream-consumer endpoint. Triggered fire-and-forget by
  // routeAdapterMessage right after startWorkflow. Carries a workflow
  // runId (unguessable ULID, wrun_...) + IM threadId; both values
  // originated from an already-authenticated webhook callback. There is
  // no user session to check (this is a server-to-server fetch), and
  // the endpoint is idempotent w.r.t. an unknown runId (the workflow
  // readable just closes empty). Authenticated via the unguessable
  // runId rather than a session cookie.
  if (pathname === '/api/internal/im-stream') {
    return true;
  }

  return isPublicAssetPath(pathname);
}

function isAgentdBypassPath(pathname: string): boolean {
  return (
    pathname === '/api/agentd/v1' ||
    pathname.startsWith('/api/agentd/v1/') ||
    pathname === '/api/soul' ||
    pathname.startsWith('/api/soul/')
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return mismatch === 0;
}

function readBearerToken(value: string | null): string {
  if (!value?.startsWith('Bearer ')) {
    return '';
  }

  return value.slice('Bearer '.length);
}

function hasValidAgentdApiKey(request: NextRequest): boolean {
  const expected = process.env.AGENTD_API_KEY;
  if (!expected) {
    return false;
  }

  const provided =
    request.headers.get('x-api-key') ||
    readBearerToken(request.headers.get('authorization'));

  return provided ? constantTimeEqual(provided, expected) : false;
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (isLoginPath(pathname) || isAlwaysBypassPath(pathname)) {
    return NextResponse.next();
  }

  const isBotRoute = /^\/api\/bot\/[^/]+(?:\/|$)/.test(pathname);
  if (isBotRoute) {
    return NextResponse.next();
  }

  if (isAgentdBypassPath(pathname) && hasValidAgentdApiKey(request)) {
    return NextResponse.next();
  }

  const authConfig = getAuthConfigStatus();
  if (!authConfig.isConfigured) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        {
          error:
            'Authentication is not configured. Set AUTH_SECRET in environment variables, then redeploy the app.',
          missingEnvVars: authConfig.missingEnvVars,
          exampleEnvFile: authConfig.exampleEnvFile,
        },
        { status: 503 },
      );
    }

    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  // CLI and other programmatic clients authenticate with a user auth
  // token carried in the Authorization: Bearer header. The token format
  // is identical to the cookie value (base64url(payload).base64url(hmac)),
  // so verifyAuthToken handles both. This does NOT apply to /api/agentd/v1/*
  // and /api/soul/* — those routes are bypassed above and use AGENTD_API_KEY.
  const token =
    request.cookies.get(AUTH_COOKIE_NAME)?.value ||
    readBearerToken(request.headers.get('authorization'));

  const session = await verifyAuthToken(token);

  if (session) {
    if (pathname === '/login') {
      return NextResponse.redirect(new URL('/', request.url));
    }

    const response = NextResponse.next();
    response.headers.set('x-user-id', session.userId);
    response.headers.set('x-user-name', session.username);
    return response;
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const redirectTo = `${pathname}${search}`;
  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('redirectTo', redirectTo);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.well-known/workflow/).*)',
  ],
};
