import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';
import type { Metadata } from 'next';
import { Toaster } from 'sonner';

import { MobileNavWrapper } from '@/components/mobile-nav-wrapper';
import { ThemeProvider } from '@/components/theme-provider';
import { getAppBaseUrl } from '@/lib/bot/webhook';

import './globals.css';

const APP_NAME = 'AgentBoster';
const APP_DESCRIPTION =
  'AgentBoster is a serverless AI agent platform for chat, skills, memory, channels, files, and workflows.';

const APP_BASE_URL = getAppBaseUrl();
const APP_ICON_URL = `${APP_BASE_URL}/icon.png`;

export const metadata: Metadata = {
  metadataBase: new URL(APP_BASE_URL),
  applicationName: APP_NAME,
  title: {
    default: APP_NAME,
    template: `%s | ${APP_NAME}`,
  },
  description: APP_DESCRIPTION,
  keywords: [
    'AgentBoster',
    'AI agent',
    'Next.js',
    'Vercel',
    'chat',
    'memory',
    'skills',
    'channels',
    'workflow',
  ],
  authors: [{ name: 'AgentBoster Team' }],
  creator: 'AgentBoster Team',
  publisher: 'AgentBoster Team',
  category: 'technology',
  icons: {
    icon: APP_ICON_URL,
    shortcut: APP_ICON_URL,
    apple: APP_ICON_URL,
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: '/',
    siteName: APP_NAME,
    title: APP_NAME,
    description: APP_DESCRIPTION,
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
    title: APP_NAME,
    description: APP_DESCRIPTION,
    images: [APP_ICON_URL],
  },
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
      'max-image-preview': 'none',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
};

export const viewport = {
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: 'hsl(0 0% 100%)' },
    { media: '(prefers-color-scheme: dark)', color: 'hsl(240deg 10% 3.92%)' },
  ],
};

const LIGHT_THEME_COLOR = 'hsl(0 0% 100%)';
const DARK_THEME_COLOR = 'hsl(240deg 10% 3.92%)';
const THEME_COLOR_SCRIPT = `\
(function() {
  var html = document.documentElement;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
  function updateThemeColor() {
    var isDark = html.classList.contains('dark');
    meta.setAttribute('content', isDark ? '${DARK_THEME_COLOR}' : '${LIGHT_THEME_COLOR}');
  }
  var observer = new MutationObserver(updateThemeColor);
  observer.observe(html, { attributes: true, attributeFilter: ['class'] });
  updateThemeColor();
})();`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // `next-themes` injects an extra classname to the body element to avoid
      // visual flicker before hydration. Hence the `suppressHydrationWarning`
      // prop is necessary to avoid the React hydration mismatch warning.
      // https://github.com/pacocoursey/next-themes?tab=readme-ov-file#with-app
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: THEME_COLOR_SCRIPT,
          }}
        />
      </head>
      <body className="antialiased overscroll-none">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <Toaster position="top-center" />
          {children}
          <MobileNavWrapper />
        </ThemeProvider>

        {/* For Vercel */}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
