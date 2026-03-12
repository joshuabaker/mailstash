import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    port: 4554,
    strictPort: false,
    proxy: {
      "/api": "http://localhost:4555",
    },
  },
});
