import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    '*': 'src/exports/**/*.ts',
    // Executables keep their own entries: a facade would re-export the module
    // instead of running it, and the shebang has to survive to dist.
    'bin/cli': 'src/bin/cli.ts',
    'bin/logSink': 'src/bin/logSink.ts',
    'bin/runnerHost': 'src/bin/runnerHost.ts',
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
