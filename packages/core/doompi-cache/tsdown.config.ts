// @scaffold-generated
import { defineConfig } from 'tsdown';

const output = {
  exports: false,
  format: ['esm', 'cjs'] as ('esm' | 'cjs')[],
  minify: {
    compress: true,
    mangle: { toplevel: true },
    codegen: { removeWhitespace: true },
  },
  platform: 'node' as const,
  sourcemap: true,
};

export default defineConfig([
  {
    ...output,
    name: 'package',
    entry: {
      index: 'src/exports/index.ts',
      env: 'src/exports/env.ts',
    },
    clean: true,
    dts: { incremental: true, parallel: false, eager: true },
    unbundle: true,
  },
  {
    ...output,
    name: 'pi-extension',
    entry: { 'extensions/pi': 'src/exports/extensions/pi.ts' },
    clean: false,
    dts: { incremental: true, parallel: false, eager: true },
    alias: {
      '#doompi-cache-optimizer-source': 'pi-cache-optimizer/index.ts',
    },
    deps: {
      // The optimizer publishes TypeScript only, so the Pi entry must inline it.
      alwaysBundle: [/^pi-cache-optimizer(?:\/|$)/u],
    },
    unbundle: false,
  },
]);
