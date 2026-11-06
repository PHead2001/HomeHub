import "dotenv/config";
import type {NextConfig} from 'next';

// Next.js 16 no longer runs ESLint during `next build` (the `eslint` option was
// removed); linting runs separately through `npm run lint` in CI.
const nextConfig: NextConfig = {
  // Next.js 16 blocks dev-server resources requested from a non-localhost origin.
  // The Playwright suite drives the dev server at 127.0.0.1. Development only;
  // production builds do not use this setting.
  allowedDevOrigins: ['127.0.0.1'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin-allow-popups',
          },
        ],
      },
    ];
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'placehold.co',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'firebasestorage.googleapis.com',
        port: '',
        pathname: '/**',
      }
    ],
  },
};

export default nextConfig;
