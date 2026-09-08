const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // npm-workspace monorepo: dependencies are hoisted to the repo root, so the
  // standalone output tracer must use the repo root as its filesystem root —
  // otherwise it emits ZERO node_modules and the Netlify function crashes with
  // "Cannot find module 'next/dist/server/lib/start-server.js'".
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
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
