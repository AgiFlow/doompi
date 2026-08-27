import { defineConfig } from 'vitest/config';

const threshold = process.env.THRESHOLD ? Number.parseInt(process.env.THRESHOLD, 10) : 80;

export const vitestConfig = defineConfig({
  test: {
    globals: true,
    environment: 'node',
    bail: 10,
    exclude: ['node_modules/**/*', 'dist/**/*', 'coverage/**/*'],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        'src/exports/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/coverage/**',
        // CodeMirror mounts onto a real element and measures it, so neither
        // the editor nor the boundary that lazily loads it can be reached by
        // server rendering. The two modules under them that do hold logic, the
        // grammar lookup and the palette, are plain data and stay counted.
        'src/components/CodeEditor.tsx',
        'src/components/CodeEditorView.tsx',
        // Radix mounts an overlay's content through a portal, which server
        // rendering never runs, and these modules hold no logic of their own:
        // they forward props and name token classes. Their behaviour is the
        // primitive's, and the cockpit's Playwright suite drives every one of
        // them in a real browser.
        'src/components/Command.tsx',
        'src/components/Dialog.tsx',
        'src/components/DropdownMenu.tsx',
        'src/components/Popover.tsx',
        'src/components/Select.tsx',
        'src/components/Toast.tsx',
        'src/components/Tooltip.tsx',
      ],
      reportOnFailure: false,
      enabled: true,
      skipFull: true,
      cleanOnRerun: true,
      thresholds: { branches: threshold, functions: threshold, lines: threshold, statements: threshold },
    },
  },
});

export { vitestConfig as default };
