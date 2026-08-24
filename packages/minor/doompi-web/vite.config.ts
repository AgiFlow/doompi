import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { ensureWebPluginModules } from './scripts/webPlugins/generate.mjs';

// Config-load time keeps the generated plugin registry fresh for both build
// and dev without touching the pinned build script; CI only checks.
ensureWebPluginModules({ check: Boolean(process.env.CI) });

const clientRoot = fileURLToPath(new URL('./src/web', import.meta.url));
const outDir = fileURLToPath(new URL('./dist/web', import.meta.url));

export default defineConfig({
  root: clientRoot,
  plugins: [react(), tailwindcss()],
  resolve: {
    // One instance of each shared runtime even when a plugin package declares
    // its own copies for typechecking.
    dedupe: ['react', 'react-dom', '@tanstack/store', '@tanstack/react-store'],
  },
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 7434,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7433', ws: true },
    },
  },
});
