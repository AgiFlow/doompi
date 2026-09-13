// @scaffold-generated
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    'api-contracts': 'src/exports/apiContracts.ts',
    index: 'src/exports/index.ts',
    catalog: 'src/exports/catalog.ts',
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
