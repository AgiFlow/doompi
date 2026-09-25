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
  it.each([
    '(backend)/tool/example.mcp.ts',
    'workspaces/(backend)/skill/example.mcp.ts',
    'workspaces/sessions/(frontend)/tool/example.mcp.ts',
    'workspaces/sessions/(backend)/root.mcp.ts',
    'workspaces/sessions/(backend)/command/example.mcp.ts',
    'workspaces/(backend)/resource/example.mcp.ts',
    'workspaces/sessions/(backend)/mode/plan/mode.mcp.ts',
  ])('rejects invalid MCP placement: %s', (relative) => {
    const file = `src/extensions/${relative}`;
    const graph = scanExtensions({ packageDir: packageWith({ [file]: EMPTY }) });
    expect(graph.entries).toEqual([]);
    expect(graph.notices).toEqual([
      {
        path: file,
        message:
          'MCP declarations belong in a session backend tool/, skill/, resource/, or frontend tool/*.mcp.tsx surface',
      },
    ]);
  });

  it('accepts session backend MCP tools, skills, and UI resources, including gated declarations', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/workspaces/sessions/(backend)/tool/example.mcp.ts': EMPTY,
        'src/extensions/workspaces/sessions/(backend)/mode/plan/skill/guide.mcp.ts': EMPTY,
        'src/extensions/workspaces/sessions/(backend)/resource/session-view.mcp.ts': EMPTY,
      }),
    });
    expect(graph.notices).toEqual([]);
    expect(graph.entries).toHaveLength(3);
    expect(graph.entries.every((entry) => entry.platform === 'mcp' && entry.scope === 'session')).toBe(true);
  });

  it('accepts session frontend MCP widgets, including gated declarations', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/workspaces/sessions/(frontend)/tool/read.mcp.tsx': EMPTY,
        'src/extensions/workspaces/sessions/(frontend)/mode/plan/tool/write_plan.mcp.tsx': EMPTY,
      }),
    });
    expect(graph.notices).toEqual([]);
    expect(graph.entries).toHaveLength(2);
    expect(
      graph.entries.every(
        (entry) =>
          entry.platform === 'mcp' &&
          entry.scope === 'session' &&
          entry.side === 'frontend' &&
          entry.surface === 'tool',
      ),
    ).toBe(true);
  });

  it('returns an empty graph when the package has no routing root', () => {
    const graph = scanExtensions({ packageDir: packageWith({ 'src/services/thing/index.ts': EMPTY }) });
    expect(graph.entries).toEqual([]);
    expect(graph.notices).toEqual([]);
  });

  it('reports an unexpected directory before a side group is selected', () => {
    const graph = scanExtensions({
      packageDir: packageWith({ 'src/extensions/misc/tool/example.ts': EMPTY }),
    });
    expect(graph.entries).toEqual([]);
    expect(graph.notices).toEqual([
      {
        path: 'src/extensions/misc',
        message: 'expected a scope segment or a side group, such as (backend)',
      },
    ]);
  });

  it('reads scope from folder nesting and side from the group folder', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/(backend)/api/providers/route.server.ts': EMPTY,
        'src/extensions/workspaces/(backend)/api/repos/route.server.ts': EMPTY,
        'src/extensions/workspaces/sessions/(backend)/tool/write-plan.server.ts': EMPTY,
        'src/extensions/workspaces/sessions/(frontend)/tab/PlanPanel.web.tsx': EMPTY,
      }),
    });

    expect(graph.notices).toEqual([]);
    expect(find(graph.entries, 'providers/route.server.ts')).toMatchObject({ scope: 'global', side: 'backend' });
    expect(find(graph.entries, 'repos/route.server.ts')).toMatchObject({ scope: 'workspace', side: 'backend' });
    expect(find(graph.entries, 'write-plan.server.ts')).toMatchObject({
      scope: 'session',
      side: 'backend',
      surface: 'tool',
    });
    expect(find(graph.entries, 'PlanPanel.web.tsx')).toMatchObject({
      scope: 'session',
      side: 'frontend',
      surface: 'tab',
    });
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
        'src/extensions/(frontend)/tab/PlanPanel.web.tsx': EMPTY,
        'src/extensions/(frontend)/tab/_components/PlanRow.tsx': EMPTY,
        'src/extensions/(frontend)/_lib/helper.ts': EMPTY,
      }),
    });
    expect(graph.entries.map((entry) => entry.name)).toEqual(['PlanPanel']);
    expect(graph.notices).toEqual([]);
  });

  it('treats a non-side group as transparent', () => {
    const graph = scanExtensions({
      packageDir: packageWith({ 'src/extensions/(backend)/(admin)/tool/purge.server.ts': EMPTY }),
    });
    expect(graph.notices).toEqual([]);
    expect(graph.entries[0]).toMatchObject({ side: 'backend', surface: 'tool', name: 'purge' });
  });

  it('collects gates from container folders, outermost first', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/(backend)/mode/plan/tool/write-plan.server.ts': EMPTY,
        'src/extensions/(backend)/domain/billing/tool/invoice.server.ts': EMPTY,
      }),
    });
    expect(graph.notices).toEqual([]);
    expect(find(graph.entries, 'write-plan.server.ts')?.gates).toEqual([{ kind: 'mode', id: 'plan' }]);
    expect(find(graph.entries, 'invoice.server.ts')?.gates).toEqual([{ kind: 'domain', id: 'billing' }]);
  });

  it('builds a route path from folders below api, including dynamic segments', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/(backend)/api/runners/[runId]/log/stream/route.server.ts': EMPTY,
        'src/extensions/(backend)/api/runners/[...rest]/route.server.ts': EMPTY,
      }),
    });
    expect(graph.notices).toEqual([]);
    expect(find(graph.entries, 'stream/route.server.ts')?.route).toEqual([
      { literal: 'runners' },
      { param: { name: 'runId', catchAll: false } },
      { literal: 'log' },
      { literal: 'stream' },
    ]);
    expect(find(graph.entries, '[...rest]/route.server.ts')?.route).toEqual([
      { literal: 'runners' },
      { param: { name: 'rest', catchAll: true } },
    ]);
  });

  it('ignores a file beside route.ts, because only the leaf is a route', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/(backend)/api/current/route.server.ts': EMPTY,
        'src/extensions/(backend)/api/current/validate.ts': EMPTY,
      }),
    });
    expect(graph.notices).toEqual([]);
    expect(graph.entries.map((entry) => entry.name)).toEqual(['route']);
  });

  it('reads the filename grammar into name, target and platform', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/(frontend)/fill/PlanRef.task.detail.web.tsx': EMPTY,
        'src/extensions/(backend)/tool/grep.cli.ts': EMPTY,
      }),
    });
    expect(find(graph.entries, 'PlanRef.task.detail.web.tsx')).toMatchObject({
      name: 'PlanRef',
      target: 'task.detail',
      platform: 'web',
    });
    expect(find(graph.entries, 'grep.cli.ts')).toMatchObject({ name: 'grep', platform: 'cli' });
  });

  it('reads cardinality only from defineRoutedContribution options', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/(backend)/provider/broker.cli.ts':
          "export default defineRoutedContribution(defineProvider(createProviders), { cardinality: 'many' });\n",
        'src/extensions/(backend)/resource/comment.server.ts':
          "// cardinality: 'optional'\nexport default defineResource(resource);\n",
        'src/extensions/(backend)/tool/property.cli.ts':
          'export default defineTool({ description: "cardinality: \'collection\'" });\n',
      }),
    });
    expect(find(graph.entries, 'broker.cli.ts')?.cardinality).toBe('many');
    expect(find(graph.entries, 'comment.server.ts')?.cardinality).toBeUndefined();
    expect(find(graph.entries, 'property.cli.ts')?.cardinality).toBeUndefined();
  });

  it('rejects extra.* at a side root', () => {
    const graph = scanExtensions({
      packageDir: packageWith({ 'src/extensions/(backend)/extra.cli.ts': EMPTY }),
    });
    expect(graph.entries).toEqual([]);
    expect(graph.notices[0]?.message).toContain('named surface folder');
  });

  it('excludes tests and stories wherever they sit', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/(frontend)/tab/PlanPanel.web.tsx': EMPTY,
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

  it('colocates implementation in a _private folder at any depth, silently', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/(backend)/tool/write-plan.server.ts': EMPTY,
        'src/extensions/(backend)/tool/_lib/parse.ts': EMPTY,
        'src/extensions/(backend)/tool/_lib/nested/deep.ts': EMPTY,
        'src/extensions/(backend)/_services/telemetry.ts': EMPTY,
        'src/extensions/(backend)/api/plan/route.server.ts': EMPTY,
        // Inside api/ only route.* is a route, so this needs no underscore.
        'src/extensions/(backend)/api/plan/validate.ts': EMPTY,
        'src/extensions/(frontend)/tab/PlanPanel.web.tsx': EMPTY,
        'src/extensions/(frontend)/tab/_components/PlanRow.tsx': EMPTY,
        'src/extensions/_shared/format.ts': EMPTY,
      }),
    });
    expect(graph.notices).toEqual([]);
    expect(
      graph.entries.map((entry) => entry.surface).sort((left, right) => (left ?? '').localeCompare(right ?? '')),
    ).toEqual(['api', 'tab', 'tool']);
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

  it('notices a stray file at a side root', () => {
    const graph = scanExtensions({
      packageDir: packageWith({ 'src/extensions/(backend)/stray.ts': EMPTY }),
    });
    expect(graph.notices[0]?.message).toContain('named surface folder');
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
      packageDir: packageWith({ 'src/extension/(backend)/tool/thing.server.ts': EMPTY }),
    });
    expect(graph.root).toBe('src/extension');
    expect(graph.entries).toHaveLength(1);
  });

  it('keeps one bad folder from costing the package its other contributions', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/(backend)/tabs/Broken.ts': EMPTY,
        'src/extensions/(backend)/tool/good.server.ts': EMPTY,
      }),
    });
    expect(graph.notices).toHaveLength(1);
    expect(graph.entries.map((entry) => entry.name)).toEqual(['good']);
  });
});

describe('the mandatory platform suffix', () => {
  it('reports a public routed file that names no platform, and still keeps it', () => {
    const graph = scanExtensions({
      packageDir: packageWith({ 'src/extensions/(backend)/tool/write-plan.ts': EMPTY }),
    });
    expect(graph.notices).toEqual([
      {
        path: 'src/extensions/(backend)/tool/write-plan.ts',
        message:
          'names no platform; add one of cli, server, mcp before .ts (without one the host is inferred from the side rather than declared)',
      },
    ]);
    expect(graph.entries).toHaveLength(1);
  });

  it('quotes the vocabulary of the side the file sits on', () => {
    const graph = scanExtensions({
      packageDir: packageWith({ 'src/extensions/(frontend)/tab/PlanPanel.tsx': EMPTY }),
    });
    expect(graph.notices[0]?.message).toContain('add one of cli, web, ios, android, desktop before .tsx');
  });

  it('quotes a configured platform set rather than the default one', () => {
    const graph = scanExtensions({
      packageDir: packageWith({ 'src/extensions/(backend)/tool/thing.ts': EMPTY }),
      platforms: { backend: ['node'] },
    });
    expect(graph.notices[0]?.message).toContain('add one of node before .ts');
  });

  it('reports a scope root and a gate declaration too', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/(backend)/root.ts': EMPTY,
        'src/extensions/(backend)/mode/plan/mode.ts': EMPTY,
      }),
    });
    expect(graph.notices.map((notice) => notice.path)).toEqual([
      'src/extensions/(backend)/mode/plan/mode.ts',
      'src/extensions/(backend)/root.ts',
    ]);
  });

  it('says nothing about a private helper or a file beside a route', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/(backend)/tool/_lib/helper.ts': EMPTY,
        'src/extensions/(backend)/api/plan/route.server.ts': EMPTY,
        'src/extensions/(backend)/api/plan/validate.ts': EMPTY,
      }),
    });
    expect(graph.notices).toEqual([]);
  });

  it('says nothing about a file whose position is the real problem', () => {
    const graph = scanExtensions({
      packageDir: packageWith({ 'src/extensions/(backend)/stray.ts': EMPTY }),
    });
    expect(graph.notices).toHaveLength(1);
    expect(graph.notices[0]?.message).toContain('named surface folder');
  });
});

describe('gate declarations', () => {
  it('reads mode.* inside a gate folder as the gate declaration itself', () => {
    const graph = scanExtensions({
      packageDir: packageWith({
        'src/extensions/(backend)/mode/plan/mode.server.ts': EMPTY,
        'src/extensions/(backend)/mode/plan/tool/write-plan.server.ts': EMPTY,
      }),
    });
    expect(graph.notices).toEqual([]);

    const declaration = find(graph.entries, 'mode/plan/mode.server.ts');
    expect(declaration).toMatchObject({ surface: 'mode', name: 'plan', gates: [] });

    const gated = find(graph.entries, 'write-plan.server.ts');
    expect(gated).toMatchObject({ surface: 'tool', gates: [{ kind: 'mode', id: 'plan' }] });
  });

  it('tells an author inside a gate folder what their options are', () => {
    const graph = scanExtensions({
      packageDir: packageWith({ 'src/extensions/(backend)/mode/plan/stray.ts': EMPTY }),
    });
    expect(graph.notices[0]?.message).toContain('name the file mode.* to declare the gate');
  });
});
