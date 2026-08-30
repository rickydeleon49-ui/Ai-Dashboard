import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; it must not be bundled by Turbopack/webpack.
  serverExternalPackages: ["better-sqlite3"],

  // The desktop build needs a self-contained server to bundle into the app.
  // It stays off for the web build because `next start` rejects standalone output,
  // so one codebase still ships to both Railway and the desktop.
  output: process.env.DESKTOP_BUILD === "1" ? "standalone" : undefined,
};

export default nextConfig;
