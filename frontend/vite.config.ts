/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  build: {
    target: "es2022",
    outDir: "dist",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8087",
    },
  },
  test: {
    environment: "node",
  },
});
