import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  worker: { format: "es" },
  build: { target: "safari16", chunkSizeWarningLimit: 4000, sourcemap: false },
  optimizeDeps: { exclude: ["cubing"] },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
} as any);
