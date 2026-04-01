import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  // In dev mode (next dev), proxy API/WS to the Express backend.
  // In production, Express serves both API and static frontend on one port.
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:8400/api/:path*",
      },
    ];
  },
};

export default nextConfig;
