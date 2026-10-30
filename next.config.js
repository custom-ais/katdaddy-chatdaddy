/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        // BOB's chat can be shown inside dryerventsquadaz.com (and this site), nowhere else.
        source: '/embed',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'self' https://dryerventsquadaz.com https://*.dryerventsquadaz.com",
          },
        ],
      },
      {
        source: '/admin/:path*',
        headers: [{ key: 'X-Frame-Options', value: 'DENY' }],
      },
      {
        source: '/widget.js',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=300' }],
      },
    ];
  },
};

module.exports = nextConfig;
