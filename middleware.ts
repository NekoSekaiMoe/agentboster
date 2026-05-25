import { getAuthConfigStatus } from '@/lib/auth/config';
import { AUTH_COOKIE_NAME } from '@/lib/auth/constants';
import { verifyAuthToken } from '@/lib/auth/session';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

function isPublicAssetPath(pathname: string): boolean {
  return /\.[^/]+$/.test(pathname);
}

function isLoginPath(pathname: string): boolean {
  if (pathname === '/login' || pathname.startsWith('/login/')) {
    return true;
  }

  return false;
}

function isAlwaysBypassPath(pathname: string): boolean {
  if (pathname.startsWith('/.well-known/workflow/')) {
    return true;
  }

  return isPublicAssetPath(pathname);
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (isLoginPath(pathname) || isAlwaysBypassPath(pathname)) {
    return NextResponse.next();
  }

  const authConfig = getAuthConfigStatus();
  if (!authConfig.isConfigured) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        {
          error:
            'Authentication is not configured. Set AUTH_SECRET, USERNAME, and PASSWORD in environment variables, then redeploy the app.',
          missingEnvVars: authConfig.missingEnvVars,
          exampleEnvFile: authConfig.exampleEnvFile,
        },
        { status: 503 },
      );
    }

    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  const isBotRoute = /^\/api\/bot\/[^/]+(?:\/|$)/.test(pathname);
  if (isBotRoute) {
    return NextResponse.next();
  }

  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  const session = await verifyAuthToken(token);

  if (session) {
    if (pathname === '/login') {
      return NextResponse.redirect(new URL('/', request.url));
    }

    return NextResponse.next();
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
