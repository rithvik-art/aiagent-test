// vite.config.js
import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig({
  plugins: [basicSsl()],
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
