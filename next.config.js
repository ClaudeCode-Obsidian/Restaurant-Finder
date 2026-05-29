/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable instrumentation.ts (required in Next 14.2; default in 15+).
  // We use it to force server-side fetch onto IPv4 — see instrumentation.ts.
  experimental: {
    instrumentationHook: true,
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'maps.googleapis.com' },
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
      { protocol: 'https', hostname: 'places.googleapis.com' },
    ],
  },
};
module.exports = nextConfig;
