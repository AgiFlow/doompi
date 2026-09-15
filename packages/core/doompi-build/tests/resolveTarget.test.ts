import { describe, expect, it } from 'vitest';

import { resolveTarget } from '../src/services/resolveTarget';
import type { BuildTarget } from '../src/services/resolveTarget/type';
import type { ExtensionEntry, ExtensionGraph, ExtensionSide } from '../src/types/extensionGraph';

function entry(partial: Partial<ExtensionEntry> & { file: string; side: ExtensionSide }): ExtensionEntry {
  return {
    scope: 'session',
    gates: [],
    surface: 'tool',
    route: [],
    name: 'thing',
    target: undefined,
    platform: undefined,
    escapeHatch: false,
    ...partial,
  };
}

function graphOf(entries: readonly ExtensionEntry[]): ExtensionGraph {
  return { root: 'src/extensions', entries, notices: [] };
}

function fieldsFor(graph: ExtensionGraph, target: BuildTarget): string[] {
  return resolveTarget(graph, target)
    .contributions.map((contribution) => contribution.field)
    .sort();
}

describe('resolveTarget', () => {
  it('sends backend files to the CLI and server, and frontend files to the web', () => {
    const graph = graphOf([
      entry({ file: 'a', side: 'backend', surface: 'tool', name: 'grep' }),
      entry({ file: 'b', side: 'frontend', surface: 'tab', name: 'Panel' }),
    ]);
    expect(resolveTarget(graph, 'cli').contributions.map((c) => c.entry.file)).toEqual(['a']);
    expect(resolveTarget(graph, 'server').contributions.map((c) => c.entry.file)).toEqual(['a']);
    expect(resolveTarget(graph, 'web').contributions.map((c) => c.entry.file)).toEqual(['b']);
  });

  it('maps one surface to a different field per host', () => {
    const tool = graphOf([entry({ file: 'a', side: 'backend', surface: 'tool' })]);
    expect(fieldsFor(tool, 'cli')).toEqual(['tools']);
    expect(fieldsFor(tool, 'server')).toEqual(['tools']);

    const hook = graphOf([entry({ file: 'a', side: 'backend', surface: 'hook', name: 'session-start' })]);
    expect(fieldsFor(hook, 'cli')).toEqual(['events']);
    expect(fieldsFor(hook, 'server')).toEqual(['hooks']);

    const renderer = graphOf([entry({ file: 'a', side: 'frontend', surface: 'tool' })]);
    expect(fieldsFor(renderer, 'web')).toEqual(['toolRenderers']);
  });

  it('skips a surface the host does not have, without complaining', () => {
    const graph = graphOf([entry({ file: 'a', side: 'backend', surface: 'api', name: 'route' })]);
    const cli = resolveTarget(graph, 'cli');
    expect(cli.contributions).toEqual([]);
    expect(cli.notices).toEqual([]);
    expect(fieldsFor(graph, 'server')).toEqual(['api']);
  });

  it('lets a platform file replace its neutral sibling, and only for that platform', () => {
    const graph = graphOf([
      entry({ file: 'neutral', side: 'backend', name: 'grep' }),
      entry({ file: 'cli-only', side: 'backend', name: 'grep', platform: 'cli' }),
    ]);
    expect(resolveTarget(graph, 'cli').contributions.map((c) => c.entry.file)).toEqual(['cli-only']);
    expect(resolveTarget(graph, 'server').contributions.map((c) => c.entry.file)).toEqual(['neutral']);
  });

  it('resolves the same way whichever order the files are scanned in', () => {
    const forward = graphOf([
      entry({ file: 'neutral', side: 'backend', name: 'grep' }),
      entry({ file: 'cli-only', side: 'backend', name: 'grep', platform: 'cli' }),
    ]);
    const reverse = graphOf([...forward.entries].reverse());
    expect(resolveTarget(reverse, 'cli').contributions.map((c) => c.entry.file)).toEqual(['cli-only']);
  });

  it('keeps two contributions apart when only their gate differs', () => {
    const graph = graphOf([
      entry({ file: 'ungated', side: 'backend', name: 'grep' }),
      entry({ file: 'gated', side: 'backend', name: 'grep', gates: [{ kind: 'mode', id: 'plan' }] }),
    ]);
    expect(resolveTarget(graph, 'cli').contributions).toHaveLength(2);
  });

  it('notices a genuine duplicate and keeps the first', () => {
    const graph = graphOf([
      entry({ file: 'first', side: 'backend', name: 'grep', platform: 'cli' }),
      entry({ file: 'second', side: 'backend', name: 'grep', platform: 'cli' }),
    ]);
    const resolved = resolveTarget(graph, 'cli');
    expect(resolved.contributions.map((c) => c.entry.file)).toEqual(['first']);
    expect(resolved.notices[0]?.message).toContain('the first one wins');
  });

  it('routes each host fill target to the array that region reads', () => {
    const fills: Array<[string, string]> = [
      ['context', 'contextSections'],
      ['rail', 'railSections'],
      ['overlay', 'overlays'],
      ['selection-bar', 'selectionBarItems'],
      ['composer-actions', 'composerActions'],
      ['composer-menu', 'composerMenuItems'],
    ];
    for (const [target, field] of fills) {
      const graph = graphOf([entry({ file: target, side: 'frontend', surface: 'fill', target })]);
      expect(fieldsFor(graph, 'web')).toEqual([field]);
    }
  });

  it('separates a bare activity fill from one naming a group', () => {
    const graph = graphOf([
      entry({ file: 'bare', side: 'frontend', surface: 'fill', name: 'A', target: 'activity' }),
      entry({ file: 'grouped', side: 'frontend', surface: 'fill', name: 'B', target: 'activity.plan' }),
    ]);
    const resolved = resolveTarget(graph, 'web').contributions;
    expect(resolved.every((c) => c.field === 'activitySections')).toBe(true);
    expect(resolved.find((c) => c.entry.file === 'bare')?.activityGroup).toBeUndefined();
    expect(resolved.find((c) => c.entry.file === 'grouped')?.activityGroup).toBe('plan');
  });

  it('treats any other dotted fill target as another plugin slot', () => {
    const graph = graphOf([entry({ file: 'a', side: 'frontend', surface: 'fill', target: 'task.detail' })]);
    expect(fieldsFor(graph, 'web')).toEqual(['fills']);
  });

  it('picks the settings shape from the filename target, defaulting to a section', () => {
    const section = graphOf([entry({ file: 'a', side: 'frontend', surface: 'setting' })]);
    const panel = graphOf([entry({ file: 'b', side: 'frontend', surface: 'setting', target: 'panel' })]);
    expect(fieldsFor(section, 'web')).toEqual(['settingsSections']);
    expect(fieldsFor(panel, 'web')).toEqual(['settingsPanels']);
  });

  it('picks the action shape from the filename target, defaulting to a context action', () => {
    const context = graphOf([entry({ file: 'a', side: 'frontend', surface: 'action' })]);
    const message = graphOf([entry({ file: 'b', side: 'frontend', surface: 'action', target: 'message' })]);
    expect(fieldsFor(context, 'web')).toEqual(['contextActions']);
    expect(fieldsFor(message, 'web')).toEqual(['userMessageActions']);
  });

  it('collects escape hatches separately from surfaces', () => {
    const graph = graphOf([
      entry({
        file: 'extra.cli.ts',
        side: 'backend',
        surface: undefined,
        name: 'extra',
        escapeHatch: true,
        platform: 'cli',
      }),
      entry({ file: 'tool.ts', side: 'backend' }),
    ]);
    const resolved = resolveTarget(graph, 'cli');
    expect(resolved.escapeHatches.map((e) => e.file)).toEqual(['extra.cli.ts']);
    expect(resolved.contributions.map((c) => c.entry.file)).toEqual(['tool.ts']);
  });

  it('drops a surface that is published but registers nothing', () => {
    const graph = graphOf([
      entry({ file: 'a', side: 'frontend', surface: 'store' }),
      entry({ file: 'b', side: 'frontend', surface: 'api', name: 'route' }),
    ]);
    expect(resolveTarget(graph, 'web').contributions).toEqual([]);
  });
});
