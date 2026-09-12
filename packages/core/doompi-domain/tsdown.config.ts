// @scaffold-generated
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/exports/index.ts',
    apply: 'src/exports/apply.ts',
    mcp: 'src/exports/mcp.ts',
    plugins: 'src/exports/plugins.ts',
    resources: 'src/exports/resources.ts',
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
