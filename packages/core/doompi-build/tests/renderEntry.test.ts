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

const OPTIONS = {
  packageName: '@agimon-ai/doompi-plan',
  pluginId: 'plan',
  root: 'src/extensions',
  entryDir: 'generated',
};

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

/**
 * Contributions are emitted as getters so the host builds them after services
 * mount. That is an ordering device, and every assertion below is about which
 * contribution landed where, so the getter is folded away here. One test
 * asserts the emitted form itself.
 */
function fields(source: string): string {
  return source.replaceAll(/get (\w+)\(\): [^{]+\{ return (.*?); \},/gu, '$1: $2,');
}

function raw(files: Record<string, string>): { cli: string; server: string; web: string } {
  const graph = scanExtensions({ packageDir: packageWith(files) });
  expect(graph.notices).toEqual([]);
  return {
    cli: renderCliEntry(resolveTarget(graph, 'cli'), OPTIONS),
    server: renderServerEntry(resolveTarget(graph, 'server'), OPTIONS),
    web: renderWebEntry(resolveTarget(graph, 'web'), OPTIONS),
  };
}

function render(files: Record<string, string>): { cli: string; server: string; web: string } {
  const entries = raw(files);
  return { cli: fields(entries.cli), server: fields(entries.server), web: fields(entries.web) };
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
  it('recognizes a session TUI overlay without registering it as a Pi contribution', () => {
    const files = {
      'src/extensions/workspaces/sessions/(frontend)/overlay/fleet.cli.ts': EMPTY,
    };
    const graph = scanExtensions({ packageDir: packageWith(files) });
    expect(graph.notices).toEqual([]);
    const { cli, web } = render(files);
    expect(cli).not.toContain('overlay/fleet.cli');
    expect(web).not.toContain('overlay/fleet.cli');
  });

  it('emits one mount holding every backend contribution, whatever scope declared it', () => {
    const { cli } = render({
      'src/extensions/(backend)/root.ts': EMPTY,
      'src/extensions/workspaces/sessions/(backend)/tool/write-plan.ts': EMPTY,
    });
    expect(cli).toContain("definePiExtension<ExtensionOptions>('@agimon-ai/doompi-plan'");
    expect(cli).toContain('services: [');
    expect(cli).toContain('...piToolContributions(');
    expect(parses(cli)).toBe(true);
  });

  it('renders Pi events as a record keyed by the event name', () => {
    const { cli } = render({ 'src/extensions/(backend)/hook/session-start.ts': EMPTY });
    expect(cli).toContain('events: {');
    expect(cli).toContain("session_start: at(");
    expect(cli).toContain("as NonNullable<PiPluginContributions['events']>['session_start']");
    expect(parses(cli)).toBe(true);
  });

  it('keeps import specifiers relative, extensionless, and paren-safe', () => {
    const { cli } = render({ 'src/extensions/workspaces/sessions/(backend)/tool/write-plan.ts': EMPTY });
    expect(cli).toContain("from '../src/extensions/workspaces/sessions/(backend)/tool/write-plan'");
    expect(cli).not.toContain(".ts'");
  });

  it('emits a valid empty extension when nothing is declared', () => {
    const { cli } = render({ 'src/extensions/(frontend)/tab/Panel.tsx': EMPTY });
    expect(cli).toContain('definePiExtension');
    expect(parses(cli)).toBe(true);
  });
});

describe('renderServerEntry', () => {
  it('registers session root startup work in the server activities field', () => {
    const { server } = raw({
      'src/extensions/workspaces/sessions/(backend)/root.server.ts': EMPTY,
    });
    expect(server).toContain('session: async (context) => {');
    expect(server).toContain(
      "get activities(): DoomServerSessionPlugin['activities'] { return [...(scopeSession.activities ?? [])]; }",
    );
    expect(server).not.toContain('global:');
    expect(server).not.toContain('workspace:');
  });

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

  it('never resolves a frontend export, because a component is a function too', () => {
    // The cockpit builds its definition as data and starts it separately, so
    // there is no mount context. Resolving anyway would call any export that
    // happens to be a function, which every React component is.
    const { web } = render({ 'src/extensions/(frontend)/tab/PlanPanel.tsx': EMPTY });
    expect(web).not.toContain('at(');
    expect(web).not.toContain('const at =');
    expect(web).not.toContain('context');
    expect(web).toContain("tabs: [via({ id: 'plan-panel' }, tabPlanPanel)]");
    expect(parses(web)).toBe(true);
  });

  it('sends a fill into a host region by naming that region as its slot', () => {
    const { web } = render({ 'src/extensions/workspaces/sessions/(frontend)/fill/PlanRail.rail.tsx': EMPTY });
    expect(web).toContain("fills: [via({ slot: 'rail', id: 'plan-rail' }, ");
    expect(parses(web)).toBe(true);
  });
});

describe('routed cardinality', () => {
  it('omits optional array and record members without changing ordinary routes', () => {
    const OPTIONAL = "export default defineRoutedContribution({}, { cardinality: 'optional' });\n";
    const { cli, server } = render({
      'src/extensions/(backend)/hook/session-start.ts': OPTIONAL,
      'src/extensions/(backend)/resource/guidance.ts': OPTIONAL,
    });
    expect(cli).toContain("...keyed('session_start', at(");
    expect(cli).toContain('resources: defined([');
    expect(server).toContain('hooks: defined([');
    expect(cli).toContain('const defined =');
    expect(cli).toContain('const keyed =');
  });

  it('flattens a many route into its standard surface array', () => {
    const MANY = "export default defineRoutedContribution([], { cardinality: 'many' });\n";
    const { cli, server } = render({ 'src/extensions/(backend)/resource/discovered.ts': MANY });
    expect(cli).toContain('...many(resourceDiscovered, context)');
    expect(server).toContain('...many(resourceDiscovered, context)');
    expect(cli).toContain('const many =');
  });

  it('preserves a live Pi tool collection instead of snapshotting it into an array', () => {
    const COLLECTION = "export default defineRoutedContribution({}, { cardinality: 'collection' });\n";
    const { cli } = render({ 'src/extensions/(backend)/tool/dynamic.cli.ts': COLLECTION });
    expect(cli).toContain("...piToolContributions('@agimon-ai/doompi-plan', at(toolDynamic, context))");
    expect(cli).not.toContain("via({ name: 'dynamic' }");
    expect(cli).not.toContain("piToolContributions('@agimon-ai/doompi-plan', [");
  });
});

describe('ordering', () => {
  it('emits every contribution as a getter, so services mount first', () => {
    // Both host helpers register services before they read anything else. A
    // plain property is built when the factory returns, which is too early for
    // a routed file to inject a service the same mount publishes.
    const { server } = raw({
      'src/extensions/(backend)/root.ts': EMPTY,
      'src/extensions/(backend)/tool/write-plan.ts': EMPTY,
    });
    expect(server).toContain("get tools(): DoomServerSessionPlugin['tools'] { return [");
    // services is what the helper reads first, so a getter buys it nothing.
    expect(server).toContain('services: [...(scopeGlobal.services ?? [])]');
    expect(server).not.toContain('get services()');
  });
});

describe('identity derived from the path', () => {
  it('binds a tool renderer to the tool its filename names', () => {
    const { web } = render({ 'src/extensions/(frontend)/tool/write-plan.tsx': EMPTY });
    expect(web).toContain("toolRenderers: [via({ tools: ['write_plan'] }, ");
  });

  it('names a backend tool from the filename, in snake case', () => {
    const { cli } = render({ 'src/extensions/(backend)/tool/write-plan.ts': EMPTY });
    expect(cli).toContain("[via({ name: 'write_plan' }, ");
  });

  it('names a command in kebab case, because that is what the user types', () => {
    // The name reaches registerCommand verbatim, so a snake-cased one would
    // publish /subagents_doctor and nobody would find it.
    const { cli } = render({ 'src/extensions/(backend)/command/subagents-doctor.ts': EMPTY });
    expect(cli).toContain("commands: [via({ name: 'subagents-doctor' }, ");
  });

  it('names a server hook event from the filename', () => {
    const { server } = render({ 'src/extensions/(backend)/hook/session-start.ts': EMPTY });
    expect(server).toContain("hooks: [via({ event: 'session_start' }, ");
  });

  it('does not wrap a cockpit channel in a factory, unlike the server one', () => {
    // `channels` means two different things: the server array holds
    // () => DoomHubChannel, the cockpit array holds the contribution itself.
    const { web } = render({ 'src/extensions/(frontend)/channel/tasks.ts': EMPTY });
    expect(web).toContain("channels: [via({ channel: 'tasks' }, channelTasks)]");
    expect(web).not.toContain('channelTasks()');
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
    expect(cli).toContain('import { definePiExtension, piToolContributions');
    // The server has no override mechanism, so its array stays plain.
    expect(server).not.toContain('piToolContributions');
  });

  it('leaves the splitter out of an entry that contributes no tools', () => {
    const { cli } = render({ 'src/extensions/(backend)/command/plan.ts': EMPTY });
    expect(cli).not.toContain('piToolContributions');
  });

  it('registers services from each enclosing root', () => {
    const { cli, server } = render({
      'src/extensions/(backend)/root.ts': EMPTY,
      'src/extensions/workspaces/sessions/(backend)/root.ts': EMPTY,
    });
    expect(cli).toContain('services: [...(scopeGlobal.services ?? []), ...(scopeSession.services ?? [])]');
    expect(server).toContain('services: [...(scopeGlobal.services ?? []), ...(scopeSession.services ?? [])]');
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

/**
 * The side axis is logic against presentation, not Node against browser. The
 * terminal has both halves: a tool's execute is backend, and the renderCall
 * that draws it is frontend, exactly as the cockpit's renderer is.
 */
describe('the terminal reads the frontend side too', () => {
  const PAIR = {
    'src/extensions/(backend)/tool/subagent.ts': EMPTY,
    'src/extensions/(frontend)/tool/subagent.cli.tsx': EMPTY,
    'src/extensions/(frontend)/tool/subagent.web.tsx': EMPTY,
  };

  it('folds a cli tool renderer into the tool it names, rather than beside it', () => {
    const { cli } = render(PAIR);
    expect(cli).toMatch(/via\(\{ name: 'subagent' \}, withPiRenderers\(at\(\w+, context\), at\(\w+, context\)\)\)/u);
    // One contribution, not two: the renderers are fields of the declaration,
    // so the pair registers once rather than the renderer landing beside it.
    expect(cli.match(/via\(/gu)).toHaveLength(1);
    expect(cli).toContain('import { definePiExtension, piToolContributions, withPiRenderers,');
  });

  it('keeps the two hosts’ renderers apart, because only one of them is React', () => {
    const { cli, web } = render(PAIR);
    expect(cli).toContain('subagent.cli');
    expect(cli).not.toContain('subagent.web');
    expect(web).toContain('subagent.web');
    expect(web).not.toContain('subagent.cli');
  });

  it('never gives the headless host a presentation file', () => {
    const { server } = render({ ...PAIR, 'src/extensions/(frontend)/message/done.cli.tsx': EMPTY });
    expect(server).not.toContain('(frontend)');
    expect(server).not.toContain('withPiRenderers');
  });

  it('routes a message renderer to the terminal registry alone', () => {
    const { cli, web } = render({ 'src/extensions/(frontend)/message/done.cli.tsx': EMPTY });
    expect(cli).toContain('messageRenderers: [');
    // The cockpit has no such registry: it draws a timeline entry with a tool
    // renderer or a fill, so the surface is terminal-only for now.
    expect(web).not.toContain('messageRenderers');
  });

  it('leaves a neutral frontend file to the cockpit, because a terminal cannot render it', () => {
    const { cli, web } = render({ 'src/extensions/(frontend)/tool/subagent.tsx': EMPTY });
    expect(cli).not.toContain('subagent');
    expect(web).toContain('subagent');
  });

  it('reports a renderer whose tool no backend file contributes', () => {
    const graph = scanExtensions({ packageDir: packageWith({ 'src/extensions/(frontend)/tool/gone.cli.tsx': EMPTY }) });
    const { notices } = resolveTarget(graph, 'cli');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toContain('no backend file contributes');
  });
});

/**
 * A root is the scope's constructor, as Next.js spells a layout. It exists so
 * a package whose surfaces all read one per-mount object graph can decompose
 * into a file per surface without rebuilding that graph per file.
 */
describe('scope roots', () => {
  const TREE = {
    'src/extensions/(backend)/root.ts': EMPTY,
    'src/extensions/(backend)/tool/subagent.ts': EMPTY,
    'src/extensions/workspaces/sessions/(backend)/root.ts': EMPTY,
    'src/extensions/workspaces/sessions/(backend)/tool/plan.ts': EMPTY,
  };

  it('constructs each scope before the contributions that read it', () => {
    const { cli } = raw(TREE);
    expect(cli).toContain('const scopeGlobal = await rootGlobal(context);');
    expect(cli).toContain('const contextGlobal = { ...context, root: scopeGlobal.value };');
    expect(cli.indexOf('const scopeGlobal')).toBeLessThan(cli.indexOf('const scopeSession'));
  });

  it('nests roots, so an inner scope builds on the context the outer one produced', () => {
    const { cli } = raw(TREE);
    expect(cli).toContain('const scopeSession = await rootSession(contextGlobal);');
    expect(cli).toContain('const contextSession = { ...contextGlobal, root: scopeSession.value };');
  });

  it('hands each contribution the nearest enclosing root, not merely the innermost', () => {
    const { cli } = render(TREE);
    expect(cli).toMatch(/via\(\{ name: 'subagent' \}, at\(\w+, contextGlobal\)\)/u);
    expect(cli).toMatch(/via\(\{ name: 'plan' \}, at\(\w+, contextSession\)\)/u);
  });

  it('folds every enclosing root’s lifecycle hooks into one set', () => {
    // onStart is the reason a root is not just a service: it runs after the
    // host has registered everything, which is the first point at which
    // starting work that calls back into a contribution is safe.
    const { cli } = raw(TREE);
    expect(cli).toContain('...composeRootHooks(scopeGlobal, scopeSession),');
    expect(cli).toContain("import { composeRootHooks } from '@agimon-ai/doompi-core/extension-file';");
  });

  it('rebuilds the enclosing roots per server scope, because each is its own mount', () => {
    const { server } = raw(TREE);
    // The global scope sees only its own root; the session scope constructs
    // both, since a server facet reads one plugin[scope] and nothing above it.
    expect(server).toContain('  global: async (context) => {');
    expect(server).toContain('...composeRootHooks(scopeGlobal),');
    expect(server).toContain('...composeRootHooks(scopeGlobal, scopeSession),');
  });

  it('leaves an entry with no root exactly as it was', () => {
    const { cli } = raw({ 'src/extensions/(backend)/tool/subagent.ts': EMPTY });
    expect(cli).not.toContain('composeRootHooks');
    expect(cli).toContain('(context) => ({');
  });

  it('does not declare a root context when nothing reads it', () => {
    const { cli } = raw({ 'src/extensions/workspaces/sessions/(backend)/root.ts': EMPTY });
    expect(cli).toContain('const scopeSession = await rootSession(context);');
    expect(cli).not.toContain('const contextSession');
  });

  it('reports a root on the frontend, which has no mount context to construct from', () => {
    const graph = scanExtensions({ packageDir: packageWith({ 'src/extensions/(frontend)/root.tsx': EMPTY }) });
    const { notices, roots } = resolveTarget(graph, 'web');
    expect(roots).toEqual([]);
    expect(notices[0]?.message).toContain('backend file');
  });
});

it('keeps native CLI command tuples intact', () => {
  const { cli } = raw({ 'src/extensions/(backend)/command/run.cli.ts': EMPTY });
  expect(cli).toContain('at(commandRun, context)');
  expect(cli).not.toContain("via({ name: 'run' }");
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
