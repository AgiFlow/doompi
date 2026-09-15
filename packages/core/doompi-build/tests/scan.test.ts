import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scanExtensions } from '../src/services/scan';
import type { ExtensionEntry } from '../src/types/extensionGraph';

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes a package tree from a path-to-contents map and returns its directory. */
function packageWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-build-'));
  created.push(dir);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(dir, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents);
  }
  return dir;
}

const EMPTY = 'export default {};\n';

function find(entries: readonly ExtensionEntry[], file: string): ExtensionEntry | undefined {
  return entries.find((entry) => entry.file.endsWith(file));
}

describe('scanExtensions', () => {
  it('returns an empty graph when the package has no routing root', () => {
    const graph = scanExtensions({ packageDir: packageWith({ 'src/services/thing/index.ts': EMPTY }) });
    expect(graph.entries).toEqual([]);
    expect(graph.notices).toEqual([]);
  });

  it('reads scope from folder nesting and side from the group folder', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/(backend)/api/providers/route.ts': EMPTY,
        'src/extensions/workspaces/(backend)/api/repos/route.ts': EMPTY,
        'src/extensions/workspaces/sessions/(backend)/tool/write-plan.ts': EMPTY,
        'src/extensions/workspaces/sessions/(frontend)/tab/PlanPanel.tsx': EMPTY,
      }),
    });

    expect(graph.notices).toEqual([]);
    expect(find(graph.entries, 'providers/route.ts')).toMatchObject({ scope: 'global', side: 'backend' });
    expect(find(graph.entries, 'repos/route.ts')).toMatchObject({ scope: 'workspace', side: 'backend' });
    expect(find(graph.entries, 'write-plan.ts')).toMatchObject({ scope: 'session', side: 'backend', surface: 'tool' });
    expect(find(graph.entries, 'PlanPanel.tsx')).toMatchObject({ scope: 'session', side: 'frontend', surface: 'tab' });
  });

  it('skips the generated entries at the root without a notice', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/pi.ts': EMPTY,
        'src/extensions/server.ts': EMPTY,
        'src/extensions/web.ts': EMPTY,
      }),
    });
    expect(graph.entries).toEqual([]);
    expect(graph.notices).toEqual([]);
  });

  it('never scans a private folder', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/(frontend)/tab/PlanPanel.tsx': EMPTY,
        'src/extensions/(frontend)/tab/_components/PlanRow.tsx': EMPTY,
        'src/extensions/(frontend)/_lib/helper.ts': EMPTY,
      }),
    });
    expect(graph.entries.map((entry) => entry.name)).toEqual(['PlanPanel']);
    expect(graph.notices).toEqual([]);
  });

  it('treats a non-side group as transparent', () => {
    const graph = scanExtensions({
      packageDir: packageWith({ 'src/extensions/(backend)/(admin)/tool/purge.ts': EMPTY }),
    });
    expect(graph.notices).toEqual([]);
    expect(graph.entries[0]).toMatchObject({ side: 'backend', surface: 'tool', name: 'purge' });
  });

  it('collects gates from container folders, outermost first', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/(backend)/mode/plan/tool/write-plan.ts': EMPTY,
        'src/extensions/(backend)/domain/billing/tool/invoice.ts': EMPTY,
      }),
    });
    expect(graph.notices).toEqual([]);
    expect(find(graph.entries, 'write-plan.ts')?.gates).toEqual([{ kind: 'mode', id: 'plan' }]);
    expect(find(graph.entries, 'invoice.ts')?.gates).toEqual([{ kind: 'domain', id: 'billing' }]);
  });

  it('builds a route path from folders below api, including dynamic segments', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/(backend)/api/runners/[runId]/log/stream/route.ts': EMPTY,
        'src/extensions/(backend)/api/runners/[...rest]/route.ts': EMPTY,
      }),
    });
    expect(graph.notices).toEqual([]);
    expect(find(graph.entries, 'stream/route.ts')?.route).toEqual([
      { literal: 'runners' },
      { param: { name: 'runId', catchAll: false } },
      { literal: 'log' },
      { literal: 'stream' },
    ]);
    expect(find(graph.entries, '[...rest]/route.ts')?.route).toEqual([
      { literal: 'runners' },
      { param: { name: 'rest', catchAll: true } },
    ]);
  });

  it('ignores a file beside route.ts, because only the leaf is a route', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/(backend)/api/current/route.ts': EMPTY,
        'src/extensions/(backend)/api/current/validate.ts': EMPTY,
      }),
    });
    expect(graph.notices).toEqual([]);
    expect(graph.entries.map((entry) => entry.name)).toEqual(['route']);
  });

  it('reads the filename grammar into name, target and platform', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/(frontend)/fill/PlanRef.task.detail.tsx': EMPTY,
        'src/extensions/(backend)/tool/grep.cli.ts': EMPTY,
      }),
    });
    expect(find(graph.entries, 'PlanRef.task.detail.tsx')).toMatchObject({
      name: 'PlanRef',
      target: 'task.detail',
      platform: undefined,
    });
    expect(find(graph.entries, 'grep.cli.ts')).toMatchObject({ name: 'grep', platform: 'cli' });
  });

  it('accepts extra.* at a side root and marks it as the escape hatch', () => {
    const graph = scanExtensions({
      packageDir: packageWith({ 'src/extensions/(backend)/extra.cli.ts': EMPTY }),
    });
    expect(graph.notices).toEqual([]);
    expect(graph.entries[0]).toMatchObject({ escapeHatch: true, surface: undefined, platform: 'cli' });
  });

  it('excludes tests and stories wherever they sit', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/(frontend)/tab/PlanPanel.tsx': EMPTY,
        'src/extensions/(frontend)/tab/PlanPanel.stories.tsx': EMPTY,
        'src/extensions/(backend)/tool/grep.test.ts': EMPTY,
      }),
    });
    expect(graph.entries.map((entry) => entry.name)).toEqual(['PlanPanel']);
    expect(graph.notices).toEqual([]);
  });

  it('notices a misspelled surface and suggests the singular', () => {
    const graph = scanExtensions({
      packageDir: packageWith({ 'src/extensions/(frontend)/tabs/PlanPanel.tsx': EMPTY }),
    });
    expect(graph.entries).toEqual([]);
    expect(graph.notices[0]?.message).toContain("did you mean 'tab'");
  });

  it('notices a surface that does not exist on this side', () => {
    const graph = scanExtensions({
      packageDir: packageWith({ 'src/extensions/(backend)/tab/PlanPanel.tsx': EMPTY }),
    });
    expect(graph.notices[0]?.message).toContain('is not a backend surface');
  });

  it('notices a dynamic segment outside a routed surface', () => {
    const graph = scanExtensions({
      packageDir: packageWith({ 'src/extensions/(backend)/tool/[runId]/thing.ts': EMPTY }),
    });
    expect(graph.notices[0]?.message).toContain('routed surface');
  });

  it('notices a nested folder under a surface that takes files directly', () => {
    const graph = scanExtensions({
      packageDir: packageWith({ 'src/extensions/(frontend)/tab/nested/PlanPanel.tsx': EMPTY }),
    });
    expect(graph.notices[0]?.message).toContain('_private folder');
  });

  it('notices a contribution placed before any side group', () => {
    const graph = scanExtensions({
      packageDir: packageWith({ 'src/extensions/workspaces/stray.ts': EMPTY }),
    });
    expect(graph.notices[0]?.message).toContain('side group');
  });

  it('notices a stray file at a side root that is not the escape hatch', () => {
    const graph = scanExtensions({
      packageDir: packageWith({ 'src/extensions/(backend)/stray.ts': EMPTY }),
    });
    expect(graph.notices[0]?.message).toContain('needs a surface');
  });

  it('honours a configured root, side names and platform set', () => {
    const graph = scanExtensions({
      packageDir: packageWith({ 'src/extension/(api)/tool/thing.node.ts': EMPTY }),
      root: 'src/extension',
      sides: { backend: 'api' },
      platforms: { backend: ['node'] },
    });
    expect(graph.notices).toEqual([]);
    expect(graph.entries[0]).toMatchObject({ side: 'backend', surface: 'tool', platform: 'node' });
  });

  it('falls back to the singular root alias when only that one exists', () => {
    const graph = scanExtensions({
      packageDir: packageWith({ 'src/extension/(backend)/tool/thing.ts': EMPTY }),
    });
    expect(graph.root).toBe('src/extension');
    expect(graph.entries).toHaveLength(1);
  });

  it('keeps one bad folder from costing the package its other contributions', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/(backend)/tabs/Broken.ts': EMPTY,
        'src/extensions/(backend)/tool/good.ts': EMPTY,
      }),
    });
    expect(graph.notices).toHaveLength(1);
    expect(graph.entries.map((entry) => entry.name)).toEqual(['good']);
  });
});

describe('gate declarations', () => {
  it('reads mode.* inside a gate folder as the gate declaration itself', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/(backend)/mode/plan/mode.ts': EMPTY,
        'src/extensions/(backend)/mode/plan/tool/write-plan.ts': EMPTY,
      }),
    });
    expect(graph.notices).toEqual([]);

    const declaration = find(graph.entries, 'mode/plan/mode.ts');
    expect(declaration).toMatchObject({ surface: 'mode', name: 'plan', gates: [] });

    const gated = find(graph.entries, 'write-plan.ts');
    expect(gated).toMatchObject({ surface: 'tool', gates: [{ kind: 'mode', id: 'plan' }] });
  });

  it('tells an author inside a gate folder what their options are', () => {
    const graph = scanExtensions({
      packageDir: packageWith({ 'src/extensions/(backend)/mode/plan/stray.ts': EMPTY }),
    });
    expect(graph.notices[0]?.message).toContain('name the file mode.* to declare the gate');
  });
});
