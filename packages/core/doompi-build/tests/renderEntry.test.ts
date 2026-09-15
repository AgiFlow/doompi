import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { renderCliEntry, renderServerEntry, renderWebEntry } from '../src/services/renderEntry';
import { resolveTarget } from '../src/services/resolveTarget';
import { scanExtensions } from '../src/services/scan';

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const EMPTY = 'export default {};\n';

const OPTIONS = { packageName: '@agimon-ai/doompi-plan', pluginId: 'plan', root: 'src/extensions' };

function packageWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-render-'));
  created.push(dir);
  for (const relative of Object.keys(files)) {
    const absolute = path.join(dir, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, files[relative] as string);
  }
  return dir;
}

function render(files: Record<string, string>): { cli: string; server: string; web: string } {
  const graph = scanExtensions({ packageDir: packageWith(files) });
  expect(graph.notices).toEqual([]);
  return {
    cli: renderCliEntry(resolveTarget(graph, 'cli'), OPTIONS),
    server: renderServerEntry(resolveTarget(graph, 'server'), OPTIONS),
    web: renderWebEntry(resolveTarget(graph, 'web'), OPTIONS),
  };
}

/**
 * Every delimiter the generator opens is closed again.
 *
 * Not a parser: TypeScript 7 exposes its own only under `unstable/`, which is
 * not worth depending on here. Full syntax validation happens where it counts,
 * when tsdown compiles a migrated package's generated entries.
 */
function parses(source: string): boolean {
  const pairs: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };
  const stack: string[] = [];
  // Strings in the emitted source never contain a delimiter, so a raw scan is enough.
  for (const character of source.replaceAll(/'[^']*'/gu, "''")) {
    if (character === '(' || character === '[' || character === '{') stack.push(character);
    else if (pairs[character] !== undefined && stack.pop() !== pairs[character]) return false;
  }
  return stack.length === 0;
}

describe('renderCliEntry', () => {
  it('emits one mount holding every backend contribution, whatever scope declared it', () => {
    const { cli } = render({
      'src/extensions/(backend)/service/registry.ts': EMPTY,
      'src/extensions/workspaces/sessions/(backend)/tool/write-plan.ts': EMPTY,
    });
    expect(cli).toContain("definePiExtension('@agimon-ai/doompi-plan'");
    expect(cli).toContain('services: [');
    expect(cli).toContain('...piToolContributions(');
    expect(parses(cli)).toBe(true);
  });

  it('renders Pi events as a record keyed by the event name', () => {
    const { cli } = render({ 'src/extensions/(backend)/hook/session-start.ts': EMPTY });
    expect(cli).toContain('events: {');
    expect(cli).toContain('session_start: at(');
    expect(parses(cli)).toBe(true);
  });

  it('keeps import specifiers relative, extensionless, and paren-safe', () => {
    const { cli } = render({ 'src/extensions/workspaces/sessions/(backend)/tool/write-plan.ts': EMPTY });
    expect(cli).toContain("from './workspaces/sessions/(backend)/tool/write-plan'");
    expect(cli).not.toContain(".ts'");
  });

  it('spreads an escape hatch into the contributions object', () => {
    const { cli } = render({ 'src/extensions/(backend)/extra.cli.ts': EMPTY });
    expect(cli).toMatch(/\.\.\.at\(\w+, context\),/u);
    expect(parses(cli)).toBe(true);
  });

  it('emits a valid empty extension when nothing is declared', () => {
    const { cli } = render({ 'src/extensions/(frontend)/tab/Panel.tsx': EMPTY });
    expect(cli).toContain('definePiExtension');
    expect(parses(cli)).toBe(true);
  });
});

describe('renderServerEntry', () => {
  it('cascades a global contribution into every narrower scope', () => {
    const { server } = render({ 'src/extensions/(backend)/channel/tasks.ts': EMPTY });
    for (const scope of ['global', 'workspace', 'session']) expect(server).toContain(`${scope}: () => ({`);
    expect(server.match(/channels: \[/gu)).toHaveLength(3);
    expect(parses(server)).toBe(true);
  });

  it('keeps a session contribution out of the broader scopes', () => {
    const { server } = render({ 'src/extensions/workspaces/sessions/(backend)/tool/grep.ts': EMPTY });
    expect(server).toContain('session: (context) => ({');
    expect(server).not.toContain('global:');
    expect(server).not.toContain('workspace:');
    expect(parses(server)).toBe(true);
  });

  it('omits a scope that has nothing in it', () => {
    const { server } = render({ 'src/extensions/workspaces/(backend)/api/repos/route.ts': EMPTY });
    expect(server).not.toContain('global:');
    expect(server).toContain('workspace: (context) => ({');
    expect(server).toContain('session: (context) => ({');
  });

  it('takes no context parameter and emits no resolver when nothing needs them', () => {
    const { server } = render({ 'src/extensions/(backend)/channel/tasks.ts': EMPTY });
    expect(server).not.toContain('context');
    expect(server).not.toContain('const at =');
  });

  it('names the facet after the package', () => {
    const { server } = render({ 'src/extensions/(backend)/tool/grep.ts': EMPTY });
    expect(server).toContain("name: '@agimon-ai/doompi-plan',");
  });
});

describe('renderWebEntry', () => {
  it('places each contribution at its declared scope and does not cascade', () => {
    const { web } = render({
      'src/extensions/(frontend)/setting/account.tsx': EMPTY,
      'src/extensions/workspaces/sessions/(frontend)/tab/PlanPanel.tsx': EMPTY,
    });
    expect(web.match(/settingsSections: \[/gu)).toHaveLength(1);
    expect(web.match(/tabs: \[/gu)).toHaveLength(1);
    expect(web).toContain('global: {');
    expect(web).toContain('session: {');
    expect(parses(web)).toBe(true);
  });

  it('exports webPlugin under the plugin id', () => {
    const { web } = render({ 'src/extensions/(frontend)/tab/PlanPanel.tsx': EMPTY });
    expect(web).toContain('export const webPlugin = defineWebPlugin({');
    expect(web).toContain("id: 'plan',");
  });

  it('threads no mount context, because the browser half has none', () => {
    const { web } = render({ 'src/extensions/(frontend)/tab/PlanPanel.tsx': EMPTY });
    expect(web).toContain('at(');
    expect(web).not.toContain(', context)');
    expect(parses(web)).toBe(true);
  });

  it('sends a fill into a host region by naming that region as its slot', () => {
    const { web } = render({ 'src/extensions/workspaces/sessions/(frontend)/fill/PlanRail.rail.tsx': EMPTY });
    expect(web).toContain("fills: [via({ slot: 'rail', id: 'plan-rail' }, ");
    expect(parses(web)).toBe(true);
  });
});

describe('identity derived from the path', () => {
  it('binds a tool renderer to the tool its filename names', () => {
    const { web } = render({ 'src/extensions/(frontend)/tool/write-plan.tsx': EMPTY });
    expect(web).toContain("toolRenderers: [via({ tools: ['write_plan'] }, ");
  });

  it('names a backend tool and command from the filename, in snake case', () => {
    const { cli } = render({ 'src/extensions/(backend)/tool/write-plan.ts': EMPTY });
    expect(cli).toContain("[via({ name: 'write_plan' }, ");
  });

  it('names a server hook event from the filename', () => {
    const { server } = render({ 'src/extensions/(backend)/hook/session-start.ts': EMPTY });
    expect(server).toContain("hooks: [via({ event: 'session_start' }, ");
  });

  it('merges a channel frame type inside the factory the array expects', () => {
    const { server } = render({ 'src/extensions/(backend)/channel/tasks.ts': EMPTY });
    expect(server).toContain("channels: [() => via({ frameType: 'tasks' }, channelTasks())]");
  });

  it('namespaces a declared slot under the plugin id', () => {
    const { web } = render({ 'src/extensions/(frontend)/slot/actions.ts': EMPTY });
    expect(web).toContain("slots: [via({ slot: 'plan.actions' }, ");
  });

  it('gives a fill into another plugin slot both the slot and an id', () => {
    const { web } = render({ 'src/extensions/(frontend)/fill/PlanRef.task.detail.tsx': EMPTY });
    expect(web).toContain("fills: [via({ slot: 'task.detail', id: 'plan-ref' }, ");
  });

  it('names an activity group slot exactly as the cockpit spells it', () => {
    const { web } = render({ 'src/extensions/(frontend)/fill/PlanSection.activity.plan.tsx': EMPTY });
    expect(web).toContain("fills: [via({ slot: 'activity.plan', id: 'plan-section' }, ");
  });

  it('kebab-cases a PascalCase component filename into an id', () => {
    const { web } = render({ 'src/extensions/(frontend)/tab/PlanPanel.tsx': EMPTY });
    expect(web).toContain("tabs: [via({ id: 'plan-panel' }, ");
  });

  it('splits CLI tools at runtime, because only the value knows if it claims a name', () => {
    // A tool that replaces one Pi ships is an override claim the host
    // arbitrates, not a second registration, and both are authored in tool/.
    const { cli, server } = render({ 'src/extensions/(backend)/tool/grep.cli.ts': EMPTY });
    expect(cli).toContain("...piToolContributions('@agimon-ai/doompi-plan', [");
    expect(cli).toContain('import { definePiExtension, piToolContributions }');
    // The server has no override mechanism, so its array stays plain.
    expect(server).not.toContain('piToolContributions');
  });

  it('leaves the splitter out of an entry that contributes no tools', () => {
    const { cli } = render({ 'src/extensions/(backend)/command/plan.ts': EMPTY });
    expect(cli).not.toContain('piToolContributions');
  });

  it('passes a service through untouched, because a Cordis plugin is itself a function', () => {
    // Resolving one would call the plugin with the mount context and register
    // its return value. There is no runtime difference between a Cordis plugin
    // and a `(context) => declaration` factory, so the surface decides.
    const { cli, server } = render({ 'src/extensions/(backend)/service/telemetry.ts': EMPTY });
    expect(cli).toContain('services: [serviceTelemetry]');
    expect(server).toContain('services: [serviceTelemetry]');
    expect(cli).not.toContain('at(serviceTelemetry');
    expect(server).not.toContain('at(serviceTelemetry');
  });

  it('declares the helpers without a generic trailing comma, which oxfmt strips from a .ts file', () => {
    // The generated entries are always .ts, so `<T,>` is the .tsx-only spelling
    // and oxfmt rewrites it to `<T>`. Emitting it would make every build dirty
    // the tree and fail `oxfmt --check` in the same package's lint target.
    const { cli, server, web } = render({
      'src/extensions/(backend)/tool/write-plan.ts': EMPTY,
      'src/extensions/(frontend)/tab/PlanPanel.tsx': EMPTY,
    });
    for (const entry of [cli, server, web]) expect(entry).not.toContain('<T,>');
  });

  it('applies the authored file over the derived identity, so a file naming itself wins', () => {
    const { cli } = render({ 'src/extensions/(backend)/tool/write-plan.ts': EMPTY });
    expect(cli).toMatch(/via\(\{ name: 'write_plan' \}, at\(\w+, context\)\)/u);
  });
});

describe('every generated entry', () => {
  it('gives colliding filenames distinct identifiers', () => {
    const { server } = render({
      'src/extensions/(backend)/tool/grep.ts': EMPTY,
      'src/extensions/workspaces/(backend)/tool/grep.ts': EMPTY,
    });
    const identifiers = [...server.matchAll(/^import (\w+) from/gmu)].map((match) => match[1]);
    expect(new Set(identifiers).size).toBe(identifiers.length);
    expect(parses(server)).toBe(true);
  });

  it('carries the do-not-edit header', () => {
    const rendered = render({ 'src/extensions/(backend)/tool/grep.ts': EMPTY });
    for (const source of Object.values(rendered)) expect(source.startsWith('// Generated by')).toBe(true);
  });

  it('is byte-identical across repeated renders of the same tree', () => {
    const files = {
      'src/extensions/(backend)/tool/a.ts': EMPTY,
      'src/extensions/(backend)/tool/b.ts': EMPTY,
      'src/extensions/workspaces/sessions/(frontend)/tab/P.tsx': EMPTY,
    };
    expect(render(files)).toEqual(render(files));
  });
});
