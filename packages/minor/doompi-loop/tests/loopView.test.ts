import { describe, expect, it } from 'vitest';
import { formatLoopStatusView, parseLoopStatusView } from '../src/types/loopView.ts';

const instances = [
  {
    instanceId: 'one',
    launcherLabel: 'Default loop',
    detail: 'every 60s · Check "status".\nThen report.',
    state: 'running' as const,
  },
  {
    instanceId: 'two',
    launcherLabel: 'External launcher',
    label: 'Release watcher',
    state: 'starting' as const,
  },
  {
    instanceId: 'three',
    launcherLabel: 'Deploy monitor',
    detail: 'every 300s · Watch deployment.',
    state: 'stopping' as const,
  },
];

describe('the loop activity status', () => {
  it('projects and round-trips every lifecycle state with the TUI fallbacks', () => {
    const encoded = formatLoopStatusView(instances);

    expect(parseLoopStatusView(encoded)).toEqual([
      {
        instanceId: 'one',
        label: 'Default loop',
        detail: 'every 60s · Check "status".\nThen report.',
        state: 'running',
      },
      { instanceId: 'two', label: 'Release watcher', detail: 'two', state: 'starting' },
      { instanceId: 'three', label: 'Deploy monitor', detail: 'every 300s · Watch deployment.', state: 'stopping' },
    ]);
  });

  it('reads an ANSI-wrapped payload and tolerates additive fields', () => {
    const payload = JSON.stringify([
      { instanceId: 'one', label: 'Loop', detail: 'detail', state: 'running', future: true },
    ]);

    expect(parseLoopStatusView(`\u001b[33m${payload}\u001b[0m`)).toEqual([
      { instanceId: 'one', label: 'Loop', detail: 'detail', state: 'running' },
    ]);
  });

  it('returns no status for empty, malformed, or shape-invalid data', () => {
    expect(formatLoopStatusView([])).toBeUndefined();
    expect(parseLoopStatusView(undefined)).toBeUndefined();
    expect(parseLoopStatusView('')).toBeUndefined();
    expect(parseLoopStatusView('not json')).toBeUndefined();
    expect(parseLoopStatusView('{}')).toBeUndefined();
    expect(parseLoopStatusView('[]')).toBeUndefined();
    expect(
      parseLoopStatusView('[{"instanceId":"one","label":"Loop","detail":"detail","state":"paused"}]'),
    ).toBeUndefined();
    expect(
      parseLoopStatusView('[{"instanceId":"","label":"Loop","detail":"detail","state":"running"}]'),
    ).toBeUndefined();
  });
});
