import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: process.env.NEXT_STANDALONE ? 'standalone' : undefined,
  async rewrites() {
    // Read at runtime (per-request), not at build time.
    // This means BACKEND_API_URL set on Vercel is always picked up
    // even if it wasn't available when `next build` ran.
    const backendUrl =
      process.env.BACKEND_API_URL || process.env.NEXT_PUBLIC_BACKEND_URL;

    if (!backendUrl) return [];

    return [
      {
        source: '/api/:path*',
        destination: `${backendUrl.replace(/\/$/, '')}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
