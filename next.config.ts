import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: process.env.NEXT_STANDALONE ? 'standalone' : undefined,
  async rewrites() {
    // Read at runtime (per-request), not at build time.
    // BACKEND_API_URL may be just a hostname (from Render's hostHeaderValue)
    // or a full URL. Normalise to always have https://.
    const raw = process.env.BACKEND_API_URL || process.env.NEXT_PUBLIC_BACKEND_URL;
    if (!raw) return [];

    const backendUrl = raw.startsWith('http') ? raw : `https://${raw}`;

    return [
      {
        source: '/api/:path*',
        destination: `${backendUrl.replace(/\/$/, '')}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
