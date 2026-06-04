import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { getAuthConfigStatus } from '@/lib/auth/config';
import { AUTH_COOKIE_NAME } from '@/lib/auth/constants';
import { verifyAuthToken } from '@/lib/auth/session';
import { getAppBaseUrl } from '@/lib/bot/webhook';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { LoginForm } from './login-form';

const APP_NAME = 'AgentBoster';
const LOGIN_DESCRIPTION =
  'Sign in to AgentBoster to manage chats, files, memory, skills, channels, and workflows.';

const APP_BASE_URL = getAppBaseUrl();
const APP_ICON_URL = `${APP_BASE_URL}/icon.png`;

export const metadata: Metadata = {
  title: 'Sign in',
  description: LOGIN_DESCRIPTION,
  alternates: {
    canonical: '/login',
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: '/login',
    siteName: APP_NAME,
    title: `Sign in | ${APP_NAME}`,
    description: LOGIN_DESCRIPTION,
    images: [
      {
        url: APP_ICON_URL,
        width: 512,
        height: 512,
        alt: 'AgentBoster logo',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: `Sign in | ${APP_NAME}`,
    description: LOGIN_DESCRIPTION,
    images: [APP_ICON_URL],
  },
};

function normalizeRedirectTo(input: string | undefined): string {
  if (!input) {
    return '/';
  }

  if (!input.startsWith('/') || input.startsWith('//')) {
    return '/';
  }

  if (input.startsWith('/login')) {
    return '/';
  }

  return input;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirectTo?: string }>;
}) {
  const resolvedParams = await searchParams;
  const nextPath = normalizeRedirectTo(resolvedParams.redirectTo);
  const authConfig = getAuthConfigStatus();

  if (!authConfig.isConfigured) {
    return (
      <main className="min-h-dvh bg-gradient-to-b from-background to-muted/20 px-4 py-8 md:px-6 md:py-12">
        <div className="mx-auto flex min-h-[70dvh] max-w-5xl items-center justify-center">
          <Card className="w-full max-w-2xl border-border/60 shadow-sm">
            <CardHeader>
              <CardTitle>Authentication setup required</CardTitle>
              <CardDescription>
                Sign in is disabled until the server is configured with
                the <code>AUTH_SECRET</code> environment variable.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className='rounded-md border border-amber-500/30 bg-amber-500/10 p-4 text-amber-950 text-sm dark:text-amber-100'>
                <p>
                  Add the missing variables to <code>.env.local</code> or{' '}
                  <code>.env</code>, then restart the app.
                </p>
                <p className="mt-2">
                  Missing now: {authConfig.missingEnvVars.join(', ')}
                </p>
              </div>
              <div className="space-y-2">
                <p className='font-medium text-sm'>Example env file</p>
                <pre className="overflow-x-auto rounded-md bg-zinc-950 p-4 text-sm text-zinc-50">
                  <code>{authConfig.exampleEnvFile}</code>
                </pre>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    );
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  const session = await verifyAuthToken(token);

  if (session) {
    redirect(nextPath);
  }

  return (
    <main className="min-h-dvh bg-gradient-to-b from-background to-muted/20 px-4 py-8 md:px-6 md:py-12">
      <div className="mx-auto flex min-h-[70dvh] max-w-5xl items-center justify-center">
        <LoginForm redirectTo={nextPath} />
      </div>
    </main>
  );
}
