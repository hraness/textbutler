import type { NextConfig } from 'next';

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "form-action 'none'",
  "img-src 'self' data: https://raw.githubusercontent.com https://skills.sh https://www.skills.sh",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
].join('; ');

const commonSecurityHeaders = [
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
] as const;

export const frameSafePreviewHeaders = [
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'none'",
      "base-uri 'none'",
      "font-src 'self' data:",
      "form-action 'none'",
      'frame-ancestors https://hraness.com https://www.hraness.com',
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'none'",
      "style-src 'self'",
    ].join('; '),
  },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
] as const;

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  async redirects() {
    return [
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'www.messagelikeme.com' }],
        destination: 'https://textbutler.app/:path*',
        permanent: true,
      },
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'messagelikeme.com' }],
        destination: 'https://textbutler.app/:path*',
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      { source: '/(.*)', headers: [...commonSecurityHeaders] },
      {
        source: '/((?!preview$).*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: `${contentSecurityPolicy}; frame-ancestors 'none'`,
          },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
      { source: '/preview', headers: [...frameSafePreviewHeaders] },
    ];
  },
};

export default nextConfig;
