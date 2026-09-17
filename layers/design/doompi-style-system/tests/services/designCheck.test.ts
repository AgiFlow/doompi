import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkDesignTarget, verifyDesignReport, type DesignTargetManifest } from '../../src/services/designCheck';
import { extractStoryExports } from '../../src/services/storyPreview';

describe('bounded design checks', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-design-check-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('discovers exact named exports without evaluating comments or string literals', () => {
    expect(
      extractStoryExports(
        "const note = 'export const Fake = {}'; // export const Comment = {};\n/* export const Block = {}; */\nexport default {}; export const Primary = { name: 'Primary label' }; export { Primary as Alias };",
      ),
    ).toEqual([{ exportName: 'Primary', label: 'Primary label' }, { exportName: 'Alias' }]);
    expect(extractStoryExports('/* unterminated comment\nexport const Hidden = {};')).toEqual([]);
  });

  it('reports raw classes, dynamic expressions, remote imports, and executable style directives', async () => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src/Button.stories.tsx'),
      "export default {}; export const Playground = {}; export function View(){return <><div className={ready ? 'bg-red-500' : 'flex'} /><span className=\"bg-red-500\" /></>} import './missing.css';",
    );
    fs.writeFileSync(path.join(root, 'styles.css'), '@import "https://example.test/theme.css";\n@plugin "bad";');
    const target: DesignTargetManifest = {
      version: 1,
      appPath: '.',
      storyPath: 'src/Button.stories.tsx',
      storyExport: 'Playground',
      sourceRoots: ['src'],
      styleFiles: ['styles.css'],
    };

    const report = await checkDesignTarget(target, root);

    expect(report.status).toBe('not-ready');
    expect(report.violations.map(({ code }) => code)).toEqual([
      'executable-style-directive',
      'remote-import',
      'raw-theme-color',
    ]);
    expect(report.unresolved.map(({ code }) => code)).toEqual(['missing-import', 'dynamic-class-expression']);
  });

  it('keeps readiness incomplete when style or component coverage is absent', async () => {
    fs.writeFileSync(path.join(root, 'Button.stories.tsx'), 'export default {}; export const Playground = {};');

    const report = await checkDesignTarget(
      { version: 1, appPath: '.', storyPath: 'Button.stories.tsx', storyExport: 'Playground' },
      root,
    );

    expect(report.status).toBe('incomplete');
    expect(report.unresolved.map(({ code }) => code)).toEqual([
      'style-context-not-declared',
      'source-roots-not-declared',
    ]);
  });

  it('marks evidence stale after an admitted source changes', async () => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/Button.stories.tsx'), 'export default {}; export const Playground = {};');
    fs.writeFileSync(path.join(root, 'styles.css'), ':root { --doom-bg: #fff; } .x { color: var(--doom-bg); }');
    const target: DesignTargetManifest = {
      version: 1,
      appPath: '.',
      storyPath: 'src/Button.stories.tsx',
      storyExport: 'Playground',
      sourceRoots: ['src'],
      styleFiles: ['styles.css'],
      managedTokens: ['--doom-bg'],
    };
    const report = await checkDesignTarget(target, root);
    const reportPath = path.join(root, 'design-check.json');
    fs.writeFileSync(reportPath, JSON.stringify(report));

    await expect(verifyDesignReport(reportPath, root)).resolves.toMatchObject({ current: true, stalePaths: [] });
    fs.appendFileSync(path.join(root, 'styles.css'), '\n/* changed */');
    const verification = await verifyDesignReport(reportPath, root);
    expect(verification.current).toBe(false);
    expect(verification.stalePaths).toContain('styles.css');
  });
});
