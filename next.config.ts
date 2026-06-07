import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['@vercel/queue', 'playwright', 'zlib-sync'],
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
