import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#101318",
        muted: "#64716d",
        line: "#dfe7e2",
        canvas: "#f7faf8",
        primary: "#0f766e",
        coral: "#c2413d",
        brass: "#b7791f"
      },
      boxShadow: {
        panel: "0 20px 70px rgba(16, 19, 24, 0.08)"
      }
    }
  },
  plugins: []
};

export default config;
