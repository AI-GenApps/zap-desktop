import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { sourcemap: true },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { sourcemap: true },
  },
  renderer: {
    resolve: { alias: { "@renderer": resolve("src/renderer") } },
    plugins: [react()],
    build: { sourcemap: true },
  },
});
