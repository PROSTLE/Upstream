import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // One .env for the repo. Only VITE_-prefixed variables ever reach the browser bundle.
  envDir: "..",
  server: {
    port: 5173,
    proxy: { "/api": { target: `http://localhost:${process.env.PORT ?? 8787}`, changeOrigin: false } },
  },
  // AG Studio is one large chunk, fetched only on /insights.
  build: { outDir: "dist", chunkSizeWarningLimit: 4200 },
});
