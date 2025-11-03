// vite.config.js
import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import legacy from "@vitejs/plugin-legacy";

const useHttps = (process.env.DEV_HTTPS ?? '1') !== '0' && (process.env.DEV_HTTPS ?? '1') !== 'false';

export default defineConfig({
  plugins: [
    ...(useHttps ? [basicSsl()] : []),
    legacy({
      targets: ["defaults", "not IE 11", "iOS >= 12", "Safari >= 12"],
      renderLegacyChunks: true,
      modernPolyfills: true,
    }),
  ],
  css: {
    // Force a minimal PostCSS config so Vite doesn't search for JSON configs
    postcss: { plugins: [] }
  },
  server: {
    https: useHttps,        // enable HTTPS only when DEV_HTTPS != 0
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
