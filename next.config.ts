import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: true },
  outputFileTracingRoot: process.cwd(),
  compiler: {
    removeConsole:
      process.env.NODE_ENV === 'production'
        ? { exclude: ['error', 'warn'] }
        : false,
  },
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
      '@radix-ui/react-tooltip',
      // Add more heavy packages
      'react-markdown',
      'framer-motion',
      '@tanstack/react-query',
    ],
  },
  turbopack: {},
  serverExternalPackages: [
    '@chat-adapter/discord',
    '@discordjs/ws',
    '@vercel/queue',
    'discord-interactions',
    'discord.js',
    'zlib-sync',
    // Self-hosted backends: keep their Node-only transitive deps (pg → pgpass
    // → readline/fs/net; aws-sdk → node:*) out of the webpack bundle. Next
    // leaves them as runtime requires, resolved on the Node host only. Loaded
    // via `await import()` from host-only code (pg-driver.ts, s3-backend.ts),
    // so they never enter the workflow steps bundle either.
    'pg',
    '@aws-sdk/client-s3',
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
