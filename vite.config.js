// vite.config.js
import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import legacy from "@vitejs/plugin-legacy";

export default defineConfig({
  plugins: [
    basicSsl(),
    legacy({
      targets: ["defaults", "not IE 11", "iOS >= 12", "Safari >= 12"],
      renderLegacyChunks: true,
      modernPolyfills: true,
    }),
  ],
  server: {
    https: true,        // enable HTTPS
    host: true,         // 0.0.0.0 (LAN access)
    port: 5173,
    strictPort: true
  },
  preview: {
    https: true,
    host: true,
    port: 5173
  }
});
