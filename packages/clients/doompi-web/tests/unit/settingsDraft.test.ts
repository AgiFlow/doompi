import type { SettingsFieldContribution } from '@agimon-ai/doompi-web-contracts';
import { describe, expect, it } from 'vitest';
import {
  canSaveSettings,
  plannedSettingsWrites,
  settingsKeyOf,
  settingsLockedReason,
} from '../../src/web/lib/settingsDraft.ts';

/**
 * The rules a settings page runs on.
 *
 * These were inline in the component and therefore unchecked, which is how the
 * page shipped unable to show or save anything when no repository was open.
 */

const MODEL: SettingsFieldContribution = {
  id: 'main.model',
  label: 'main model',
  kind: 'select',
  keyPath: ['modes', 'planning', 'main', 'model'],
};
const THINKING: SettingsFieldContribution = {
  id: 'main.thinking',
  label: 'main thinking',
  kind: 'select',
  keyPath: ['modes', 'planning', 'main', 'thinking'],
};

describe('whether a save can be attempted', () => {
  it('allows a global save with no repository, because the global file stands alone', () => {
    // The regression this pins: the page required a repository for everything,
    // so with no session open it could neither show nor save a global setting.
    expect(canSaveSettings({ dirty: 1, scope: 'global', repoRoot: '' })).toBe(true);
  });

  it('needs a repository before it can write one', () => {
    expect(canSaveSettings({ dirty: 1, scope: 'repository', repoRoot: '' })).toBe(false);
    expect(canSaveSettings({ dirty: 1, scope: 'repository', repoRoot: '/repo' })).toBe(true);
  });

  it('has nothing to do when nothing changed', () => {
    expect(canSaveSettings({ dirty: 0, scope: 'global', repoRoot: '/repo' })).toBe(false);
  });
});

describe('which fields a save writes', () => {
  it('writes only the fields that were edited, in the order they are declared', () => {
    const planned = plannedSettingsWrites({
      fields: [MODEL, THINKING],
      drafts: { 'modes.planning.main.thinking': 'high' },
      scope: 'global',
      repoRoot: '',
      startingHash: 'h0',
    });

    expect(planned).toEqual([
      {
        repoRoot: '',
        scope: 'global',
        keyPath: ['modes', 'planning', 'main', 'thinking'],
        value: 'high',
        expectedHash: 'h0',
      },
    ]);
  });

  it('turns a cleared field into a removal rather than an empty value', () => {
    // The parser rejects a blank value, so clearing the key is the only way to
    // spell "inherit" in the file.
    const planned = plannedSettingsWrites({
      fields: [MODEL],
      drafts: { 'modes.planning.main.model': null },
      scope: 'repository',
      repoRoot: '/repo',
      startingHash: 'h0',
    });

    expect(planned[0]).toMatchObject({ value: null, scope: 'repository', repoRoot: '/repo' });
  });

  it('plans nothing when no field was touched', () => {
    expect(
      plannedSettingsWrites({ fields: [MODEL, THINKING], drafts: {}, scope: 'global', repoRoot: '', startingHash: '' }),
    ).toEqual([]);
  });
});

describe('which fields a scope may edit', () => {
  it('locks a key the chosen file is never read from', () => {
    expect(settingsLockedReason({ origin: 'default', scope: 'global' }, 'repository')).toBe('global only');
    expect(settingsLockedReason({ origin: 'default', scope: 'repository' }, 'global')).toBe('repository only');
  });

  it('leaves an overridable key editable at either scope', () => {
    expect(settingsLockedReason({ origin: 'default', scope: 'both' }, 'global')).toBeUndefined();
    expect(settingsLockedReason({ origin: 'default', scope: 'both' }, 'repository')).toBeUndefined();
  });

  it('says nothing about a key the page has not read yet', () => {
    expect(settingsLockedReason(undefined, 'global')).toBeUndefined();
  });
});

describe('the key a field writes', () => {
  it('is the dotted form the routes answer by', () => {
    expect(settingsKeyOf(MODEL)).toBe('modes.planning.main.model');
  });
});
