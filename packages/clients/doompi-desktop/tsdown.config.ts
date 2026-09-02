import { defineConfig } from 'tsdown';

/**
 * Electron loads the main process and the preload as CommonJS.
 *
 * A sandboxed preload has no module loader of its own, so it must be a single
 * self-contained CJS file; the main process is emitted the same way rather than
 * split across two module systems for one app. `electron` itself stays external
 * because it is supplied by the runtime, not bundled.
 */
export default defineConfig({
  entry: {
    'bin/main': 'src/bin/main.ts',
    'bin/preload': 'src/bin/preload.ts',
  },
  clean: true,
  dts: false,
  exports: false,
  format: ['cjs'],
  outExtensions: () => ({ js: '.cjs' }),
  platform: 'node',
  external: ['electron'],
  sourcemap: true,
  unbundle: false,
});
