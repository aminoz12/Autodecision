const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // npm-workspace monorepo: dependencies are hoisted to the repo root, so the
  // standalone output tracer must use the repo root as its filesystem root —
  // otherwise the serverless functions ship without node_modules and crash with
  // "Cannot find module 'next/dist/server/lib/start-server.js'".
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
  // The deployed commit, attached to each line of the error journal
  // (Vercel sets VERCEL_GIT_COMMIT_SHA at build).
  env: {
    NEXT_PUBLIC_APP_VERSION: (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7) || "dev",
  },
  // Extra dev origins (ngrok tunnels…): ALLOWED_DEV_ORIGINS="a.ngrok-free.app,b.ngrok-free.app"
  allowedDevOrigins: (process.env.ALLOWED_DEV_ORIGINS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean),
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
  webpack: (config, { dev }) => {
    if (dev) {
      // Avoid large on-disk webpack pack allocations on low-memory machines.
      config.cache = false;
    }
    return config;
  },
};

module.exports = nextConfig;
