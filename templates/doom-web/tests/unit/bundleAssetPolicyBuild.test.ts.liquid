import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { bundleAssetPolicyPlugin } from '@agimon-ai/doompi/builders/web';
import { parseBundleAssetPolicy } from '@agimon-ai/doompi-core/web';

const requireFromComponents = createRequire(
  new URL('../../../../core/doompi-web-components/package.json', import.meta.url),
);

describe('bundle asset policy production graph', () => {
  it('defers real Mermaid and PDF output graphs while application output stays eager', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-bundle-policy-'));
    const outDir = path.join(root, 'dist');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'index.html'), '<script type="module" src="/src/application.js"></script>');
    fs.writeFileSync(
      path.join(root, 'src/application.js'),
      [
        "import './core.js';",
        "globalThis.loadMermaid = () => import('mermaid');",
        "globalThis.loadPdf = () => import('pdfjs-dist/webpack.mjs');",
      ].join('\n'),
    );
    fs.writeFileSync(path.join(root, 'src/core.js'), "import './shared.js';\nglobalThis.coreLoaded = true;\n");
    fs.writeFileSync(path.join(root, 'src/shared.js'), 'globalThis.sharedLoaded = true;\n');

    try {
      const result = await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [bundleAssetPolicyPlugin()],
        resolve: {
          alias: {
            mermaid: requireFromComponents.resolve('mermaid'),
            'pdfjs-dist/webpack.mjs': requireFromComponents.resolve('pdfjs-dist/webpack.mjs'),
          },
        },
        build: { outDir, emptyOutDir: true, sourcemap: true },
      });
      const builds = Array.isArray(result) ? result : [result];
      const outputs = builds.flatMap((output) => {
        if (!('output' in output)) throw new Error('Vite returned a watcher for a production build');
        return output.output;
      });
      const chunks = outputs.filter((output) => output.type === 'chunk');
      const chunkWithModule = (fragment: string) =>
        chunks.find((chunk) => Object.keys(chunk.modules).some((id) => id.replaceAll('\\', '/').includes(fragment)));
      const mermaid = chunkWithModule('/node_modules/mermaid/');
      const pdf = chunkWithModule('/node_modules/pdfjs-dist/');
      expect(mermaid).toBeDefined();
      expect(pdf).toBeDefined();

      const policy = parseBundleAssetPolicy(
        JSON.parse(fs.readFileSync(path.join(outDir, 'bundle-asset-policy.json'), 'utf8')),
      );
      expect(policy).toBeDefined();
      const optional = new Set(policy?.optional.map((fileName) => fileName.slice(1)));
      const emitted = new Set(outputs.map((output) => output.fileName));

      expect([...optional].every((fileName) => emitted.has(fileName))).toBe(true);
      expect(optional.has(mermaid?.fileName ?? '')).toBe(true);
      expect(optional.has(pdf?.fileName ?? '')).toBe(true);

      // Vite 8 emits the worker as an asset referenced by the generated PDF module URL.
      // Its hashed filename is read from the output graph, not used to infer ownership.
      const pdfResources = outputs.filter(
        (output) => output.type === 'asset' && !output.fileName.endsWith('.map') && pdf?.code.includes(output.fileName),
      );
      expect(pdfResources.length).toBeGreaterThan(0);
      expect(pdfResources.every((output) => optional.has(output.fileName))).toBe(true);
      expect(pdf?.code).toContain('new Worker');

      for (const source of ['/src/application.js', '/src/core.js', '/src/shared.js']) {
        const applicationChunk = chunkWithModule(source);
        expect(applicationChunk, source).toBeDefined();
        expect(optional.has(applicationChunk?.fileName ?? ''), source).toBe(false);
      }

      const maps = outputs.filter((output) => output.fileName.endsWith('.map'));
      expect(maps.length).toBeGreaterThan(0);
      expect(maps.every((output) => !optional.has(output.fileName))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
