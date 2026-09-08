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
        // Story files are render fixtures for the style-system screenshot
        // pipeline, not shipped logic. They are never imported by the package
        // entries and hold no behaviour a unit test could assert.
        '**/*.stories.tsx',
        '**/coverage/**',
        // CodeMirror and xterm mount onto a real element and measure it, so
        // neither editor can be reached by server rendering. The modules under
        // them that do hold presentation logic stay counted.
        'src/components/CodeEditor.tsx',
        'src/components/CodeEditorView.tsx',
        'src/components/TerminalView.tsx',
        // The clipboard and mermaid both need a browser: one asks the user's
        // permission, the other measures text in the document. Neither is
        // reachable from server rendering, which is all this suite can do, and
        // both keep their logic where a render test can see it: the block that
        // picks a grammar, and the source shown until a diagram arrives.
        'src/components/CopyButton.tsx',
        'src/components/MermaidDiagram.tsx',
        'src/lib/mermaidDiagram.ts',
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
