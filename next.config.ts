import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

const nextConfig: NextConfig = {
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  outputFileTracingRoot: process.cwd(),
  compiler: {
    removeConsole:
      process.env.NODE_ENV === 'production'
        ? { exclude: ['error', 'warn'] }
        : false,
  },
  // Use SWC minifier (7x faster than Terser)
  swcMinify: true,
  experimental: {
    optimizePackageImports: [
      'lucide-react',
      '@radix-ui/react-alert-dialog',
      '@radix-ui/react-checkbox',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-label',
      '@radix-ui/react-radio-group',
      '@radix-ui/react-select',
      '@radix-ui/react-separator',
      '@radix-ui/react-slot',
      '@radix-ui/react-tabs',
      '@radix-ui/react-tooltip',
      // Add more heavy packages
      'react-markdown',
      'framer-motion',
      'date-fns',
      '@tanstack/react-query',
    ],
    // Turbopack for dev (production still uses webpack)
    turbo: {},
  },
  turbopack: {},
  serverExternalPackages: [
    '@chat-adapter/discord',
    '@discordjs/ws',
    '@vercel/queue',
    'discord-interactions',
    'discord.js',
    'playwright',
    'playwright-core',
    'chromium-bidi',
    'zlib-sync',
  ],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-Robots-Tag',
            value:
              'noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate',
          },
        ],
      },
    ];
  },
  images: {
    remotePatterns: [
      {
        hostname: 'avatar.vercel.sh',
      },
    ],
  },
};

export default withWorkflow(nextConfig);
