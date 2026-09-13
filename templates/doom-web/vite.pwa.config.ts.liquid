import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const pwaRoot = path.join(packageRoot, 'src', 'pwa');
const outDir = path.join(packageRoot, 'dist', 'pwa');

export default defineConfig(({ mode }) => {
  if (mode === 'worker') {
    return {
      configFile: false,
      publicDir: false,
      build: {
        outDir,
        emptyOutDir: false,
        sourcemap: false,
        lib: {
          entry: path.join(pwaRoot, 'serviceWorker.ts'),
          formats: ['iife'],
          name: 'DoomPiServiceWorker',
          fileName: () => 'sw.js',
        },
      },
    };
  }

  return {
    root: pwaRoot,
    base: '/pwa/',
    publicDir: path.join(pwaRoot, 'public'),
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: {
        output: {
          entryFileNames: 'pwa.js',
          chunkFileNames: 'pwa-[name].js',
          assetFileNames: 'pwa.[ext]',
        },
      },
    },
  };
});
