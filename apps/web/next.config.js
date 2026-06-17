/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: [
    "4ad2-105-157-90-150.ngrok-free.app",
    "48d8-105-157-90-150.ngrok-free.app",
    "f162-196-70-224-191.ngrok-free.app",
    "9c89-160-179-112-228.ngrok-free.app",
    "0b78-196-74-188-39.ngrok-free.app",
  ],
  turbopack: {
    root: __dirname,
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
