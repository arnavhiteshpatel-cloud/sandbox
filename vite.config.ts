import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  worker: { format: "es" },
  build: { target: "safari16", chunkSizeWarningLimit: 4000, sourcemap: false, modulePreload: false,
    rollupOptions: {
      output: {
        // Keep Vite's preload helper out of the entry chunk: cubing.js web workers import it,
        // and they must never execute the UI bootstrap.
        manualChunks(id: string) {
          if (id.includes("preload-helper") || id.includes("vite/preload")) return "preload-helper";
          return undefined;
        },
      },
    },
  },
  optimizeDeps: { exclude: ["cubing"] },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
} as any);
