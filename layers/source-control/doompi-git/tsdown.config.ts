// @scaffold-generated
import { defineConfig } from 'tsdown';

export default defineConfig({
  // extensions/web.ts re-exports the browser half; the cockpit bundles it from
  // source, so node-building it here would pull React into dist for nothing.
  entry: {
    'api-contracts': 'src/exports/apiContracts.ts',
    index: 'src/exports/index.ts',
    'extensions/pi': 'src/extensions/pi.ts',
    'extensions/server': 'src/extensions/server.ts',
  },
  clean: true,
  dts: { incremental: true, parallel: false, eager: true },
  exports: false,
  format: ['esm', 'cjs'],
  minify: {
    compress: true,
    mangle: { toplevel: true },
    codegen: { removeWhitespace: true },
  },
  platform: 'node',
  sourcemap: true,
  unbundle: true,
});
