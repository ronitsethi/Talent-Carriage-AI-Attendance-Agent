import type { NextConfig } from 'next';

/**
 * In development Next.js blocks its own client assets when the browser is on a
 * different origin - which is exactly what happens when the app is reached
 * through an ngrok tunnel. The page renders but no JavaScript runs, so nothing
 * on it is clickable. Any host we are reached on has to be listed here.
 */
const tunnelHost = (() => {
  try {
    return new URL(process.env.APP_BASE_URL ?? '').hostname;
  } catch {
    return '';
  }
})();

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    'localhost',
    '127.0.0.1',
    ...(tunnelHost && tunnelHost !== 'localhost' ? [tunnelHost] : []),
    ...(process.env.EXTRA_DEV_ORIGINS ?? '').split(',').map((host) => host.trim()).filter(Boolean),
  ],
  output: 'standalone',
  serverExternalPackages: ['pg'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
