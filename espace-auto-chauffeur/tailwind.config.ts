import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      boxShadow: {
        card: "0 8px 30px rgba(24, 33, 58, 0.08)",
        float: "0 14px 40px rgba(91, 70, 255, 0.25)",
      },
    },
  },
  plugins: [],
};

export default config;
