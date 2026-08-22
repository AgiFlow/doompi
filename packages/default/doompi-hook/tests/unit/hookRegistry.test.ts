import { describe, expect, it } from 'vitest';
import { registryCacheKey, registryEntries, selectRegistryHooks } from '../../src/services/hookRegistry.ts';
import type { ParsedRegistrySource, RegistryEntry } from '../../src/types/hooks.ts';

function source(baseDirectory: string, document: ParsedRegistrySource['document']): ParsedRegistrySource {
  return { baseDirectory, document };
}

const repositorySource = source('/repo', {
  groups: {
    safety: {
      core: true,
      hooks: [
        { event: 'PreToolUse', pi: { command: 'guard', matcher: 'Bash' } },
        // No `pi` frontend: declared for another frontend and skipped here.
        { event: 'PreToolUse' },
        { event: 'Stop', pi: { command: 'close-step', skipInSubagent: true } },
      ],
    },
    workflow: {
      hooks: [{ event: 'PreToolUse', pi: { command: 'workflow', order: -1 } }],
    },
  },
});

describe('registry entries', () => {
  it('keeps only rows with a pi frontend and tags them with their group and root', () => {
    const entries = registryEntries([repositorySource]);

    expect(entries.map((entry) => entry.command)).toEqual(['workflow', 'guard', 'close-step']);
    expect(entries.map((entry) => entry.baseDirectory)).toEqual(['/repo', '/repo', '/repo']);
    expect(entries.find((entry) => entry.command === 'guard')?.core).toBe(true);
    expect(entries.find((entry) => entry.command === 'workflow')?.core).toBe(false);
  });

  it('breaks an order tie with declaration position, counting rows it drops', () => {
    const entries = registryEntries([
      source('/repo', {
        groups: {
          first: {
            hooks: [{ event: 'PreToolUse' }, { event: 'PreToolUse', pi: { command: 'second-declared' } }],
          },
          second: { hooks: [{ event: 'PreToolUse', pi: { command: 'third-declared' } }] },
        },
      }),
    ]);

    expect(entries.map((entry) => entry.position)).toEqual([2, 3]);
    expect(entries.map((entry) => entry.command)).toEqual(['second-declared', 'third-declared']);
  });

  it('lets a repository group replace the global group of the same id outright', () => {
    const entries = registryEntries([
      source('/home/.doom', { groups: { safety: { hooks: [{ event: 'Stop', pi: { command: 'global-only' } }] } } }),
      source('/repo', { groups: { safety: { hooks: [{ event: 'Stop', pi: { command: 'repository' } }] } } }),
    ]);

    expect(entries.map((entry) => entry.command)).toEqual(['repository']);
    expect(entries[0]?.baseDirectory).toBe('/repo');
  });

  it('treats a document with no groups as no hooks', () => {
    expect(registryEntries([source('/repo', {})])).toEqual([]);
  });

  it('keys the cache on contents so an in-place rewrite is a different key', () => {
    const first = registryCacheKey([{ baseDirectory: '/repo', text: 'groups: {}' }]);

    expect(registryCacheKey([{ baseDirectory: '/repo', text: 'groups: {}' }])).toBe(first);
    expect(registryCacheKey([{ baseDirectory: '/repo', text: 'groups: {a: {}}' }])).not.toBe(first);
    expect(registryCacheKey([{ baseDirectory: '/other', text: 'groups: {}' }])).not.toBe(first);
  });
});

describe('registry selection', () => {
  const entries: RegistryEntry[] = registryEntries([repositorySource]);

  it('runs every group when the harness selected none', () => {
    const selected = selectRegistryHooks(entries, { event: 'PreToolUse', toolName: 'bash', inSubagent: false });

    expect(selected.map((resolved) => resolved.hook.command)).toEqual(['workflow', 'guard']);
    expect(selected[0]?.root).toBe('/repo');
  });

  it('keeps core groups and drops unselected ones', () => {
    const selected = selectRegistryHooks(entries, {
      event: 'PreToolUse',
      toolName: 'bash',
      allowedGroups: [],
      inSubagent: false,
    });

    expect(selected.map((resolved) => resolved.hook.command)).toEqual(['guard']);
  });

  it('includes a non-core group once the harness selects it', () => {
    const selected = selectRegistryHooks(entries, {
      event: 'PreToolUse',
      toolName: 'bash',
      allowedGroups: ['workflow'],
      inSubagent: false,
    });

    expect(selected.map((resolved) => resolved.hook.command)).toEqual(['workflow', 'guard']);
  });

  it('drops rows whose matcher rejects the tool that fired', () => {
    const selected = selectRegistryHooks(entries, { event: 'PreToolUse', toolName: 'write', inSubagent: false });

    expect(selected.map((resolved) => resolved.hook.command)).toEqual(['workflow']);
  });

  it('drops skipInSubagent rows in a child session and keeps them in the parent', () => {
    const child = selectRegistryHooks(entries, { event: 'Stop', inSubagent: true });
    const parent = selectRegistryHooks(entries, { event: 'Stop', inSubagent: false });

    expect(child).toEqual([]);
    expect(parent.map((resolved) => resolved.hook.command)).toEqual(['close-step']);
  });

  it('carries the declared timeout onto the resolved command', () => {
    const timed = registryEntries([
      source('/repo', { groups: { slow: { hooks: [{ event: 'Stop', pi: { command: 'slow', timeout: 45 } }] } } }),
    ]);

    expect(selectRegistryHooks(timed, { event: 'Stop', inSubagent: false })[0]?.hook).toEqual({
      command: 'slow',
      timeout: 45,
    });
  });
});
