/** @type {import('next').NextConfig} */
const securityHeaders = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload'
  },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: https:",
      "connect-src 'self' ws: wss: http://localhost:8000 https://api.prayaas.app",
      "font-src 'self' https://fonts.gstatic.com",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests"
    ].join('; ')
  },
  { key: 'X-Content-Type-Options',   value: 'nosniff' },
  { key: 'X-Frame-Options',          value: 'DENY' },
  { key: 'Referrer-Policy',          value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'microphone=(self), camera=(), geolocation=()'
  }
];

const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ];
  },
  // Standalone output for Docker — disabled on Vercel (it uses its own infra)
  output: process.env.NODE_ENV === 'production' && !process.env.VERCEL ? 'standalone' : undefined,
  async rewrites() {
    const backendUrl = process.env.BACKEND_URL || 'http://127.0.0.1:8000';
    return [
      {
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
