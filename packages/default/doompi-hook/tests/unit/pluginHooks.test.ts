import { describe, expect, it } from 'vitest';
import { selectPluginHooks } from '../../src/services/pluginHooks.ts';
import type { PluginHookDocument } from '../../src/types/hooks.ts';

const documents: PluginHookDocument[] = [
  {
    pluginRoot: '/plugins/review',
    config: {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ command: 'audit-command' }] },
          { matcher: 'Write', hooks: [{ command: 'audit-write' }] },
          { hooks: [{ command: 'audit-everything' }] },
          // A group that declares no commands still parses; it just adds none.
          { matcher: 'Bash' },
        ],
      },
    },
  },
  { pluginRoot: '/plugins/empty', config: {} },
];

describe('plugin hook selection', () => {
  it('keeps the groups whose matcher accepts the tool, tagged with their plugin root', () => {
    expect(selectPluginHooks(documents, 'PreToolUse', 'bash')).toEqual([
      { hook: { command: 'audit-command' }, root: '/plugins/review' },
      { hook: { command: 'audit-everything' }, root: '/plugins/review' },
    ]);
  });

  it('runs every group when no tool is in play, as at session end', () => {
    expect(selectPluginHooks(documents, 'PreToolUse').map((resolved) => resolved.hook.command)).toEqual([
      'audit-command',
      'audit-write',
      'audit-everything',
    ]);
  });

  it('returns nothing for an event no plugin declares', () => {
    expect(selectPluginHooks(documents, 'SessionEnd')).toEqual([]);
  });
});
