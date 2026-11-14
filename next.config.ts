import "dotenv/config";
import type {NextConfig} from 'next';

// HomeHub build id (SL-2 "HomeHub updated"): a fixed-width UTC timestamp, so a
// later build sorts after an earlier one. It is computed once per `next build`
// and kept in process.env so build workers that load this config again reuse
// it. `env` inlines it into both the client bundle and the service worker route
// (src/app/api/sw/route.ts) at build time; see src/lib/shell/update-check.ts.
process.env.HOMEHUB_BUILD_STAMP ??= new Date().toISOString().replace(/-|:|\./g, '');
const HOMEHUB_BUILD_ID = process.env.HOMEHUB_BUILD_STAMP;

// Next.js 16 no longer runs ESLint during `next build` (the `eslint` option was
// removed); linting runs separately through `npm run lint` in CI.
const nextConfig: NextConfig = {
  // Next.js 16 blocks dev-server resources requested from a non-localhost origin.
  // The Playwright suite drives the dev server at 127.0.0.1. Development only;
  // production builds do not use this setting.
  allowedDevOrigins: ['127.0.0.1'],
  // No Next.js dev-tools indicator: in `next dev` its round button sits at the bottom-left
  // over the wall tablet's rail (the Add button at 1263x818) and intercepts the e2e
  // suite's taps. Development only; production builds never show it.
  devIndicators: false,
  env: {
    NEXT_PUBLIC_HOMEHUB_BUILD_ID: HOMEHUB_BUILD_ID,
  },
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
