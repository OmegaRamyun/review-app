import { defineConfig } from "vite";

// Tauri expects a fixed dev port and a relative build output.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { outDir: "dist", target: "es2022" },
});
