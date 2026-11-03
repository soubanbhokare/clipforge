import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// CLIPFORGE Vite config.
// Phase 2: the dev server proxies "/api" to the CLIPFORGE backend
// (Express, port 3001 — see server/) so the frontend is same-origin
// and the HttpOnly session cookie works without CORS. No secrets are
// read or embedded here.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
  },
});
