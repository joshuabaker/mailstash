import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const workerPort = process.env.WORKER_PORT || "4555";
const vitePort = parseInt(process.env.VITE_PORT || "4554", 10);

export default defineConfig({
  plugins: [react()],
  root: ".",
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    port: vitePort,
    strictPort: false,
    proxy: {
      "/api": `http://localhost:${workerPort}`,
    },
  },
});
