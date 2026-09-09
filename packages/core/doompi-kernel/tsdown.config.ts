import { defineConfig } from 'tsdown';

export const tsdownConfig = defineConfig({
  entry: { '*': 'src/exports/**/*.ts' },
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

export { tsdownConfig as default };
