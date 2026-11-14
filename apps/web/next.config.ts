import type { NextConfig } from "next";

/** The browser only talks to this origin; /api is proxied to the Hono API so cookies stay first-party. */
const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:8787";

const config: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_ORIGIN}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default config;
