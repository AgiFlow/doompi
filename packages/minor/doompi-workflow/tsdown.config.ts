import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    'api-contracts': 'src/exports/apiContracts.ts',
    '*': 'src/exports/*.ts',
    'extensions/*': ['src/extensions/*.ts', '!src/extensions/web.ts'],
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
