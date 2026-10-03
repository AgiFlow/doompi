import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_HTTPS_HOST,
  formFromView,
  formProblem,
  saveRequestOf,
} from '../../../src/extensions/workspaces/(frontend)/repository-settings-panel/_lib/gitAuthForm';
import {
  gitChanges,
  gitChangesChannel,
  type GitChangesSession,
} from '../../../src/extensions/workspaces/sessions/(frontend)/_lib/gitChangesStore';
import {
  conflictPrompt,
  deliverToAgent,
  reviewHeading,
} from '../../../src/extensions/workspaces/sessions/(frontend)/_lib/gitReviewView';

describe('git changes channel parse', () => {
  it('keeps well-formed fields and drops malformed ones', () => {
    const parsed = gitChangesChannel.parse({
      changes: {
        added: 3,
        removed: 1,
        files: 2,
        branch: 'feat/x',
        base: 'origin/main',
        upstream: { ref: 'origin/feat/x', ahead: 2, behind: 0 },
        rebase: { conflicts: ['a.ts', 7, 'b.ts'] },
      },
      pending: 'pushing…',
      errorTarget: { action: 'push', forceRequired: true },
    });
    expect(parsed).toEqual({
      changes: {
        added: 3,
        removed: 1,
        files: 2,
        branch: 'feat/x',
        base: 'origin/main',
        upstream: { ref: 'origin/feat/x', ahead: 2, behind: 0 },
        rebase: { conflicts: ['a.ts', 'b.ts'] },
      },
      pending: 'pushing…',
      error: undefined,
      errorTarget: { action: 'push', forceRequired: true },
    });
    expect(
      (gitChangesChannel.parse({ changes: { added: -1, removed: 0, files: 0 } }) as GitChangesSession | null)?.changes,
    ).toBeUndefined();
    expect(
      (gitChangesChannel.parse({ errorTarget: { action: 'create' } }) as GitChangesSession | null)?.errorTarget,
    ).toBeUndefined();
    expect(gitChangesChannel.parse('nope')).toBeNull();
    expect(gitChanges.select(gitChanges.store.state, 'unknown').changes).toBeUndefined();
  });
});

describe('review messages', () => {
  it('names what was reviewed against what', () => {
    expect(reviewHeading(1, 'feat/x', 'origin/main')).toBe(
      'I reviewed branch feat/x (its changes against origin/main) and left one review comment. Please address it.',
    );
    expect(reviewHeading(3, undefined, undefined)).toBe(
      'I reviewed this checkout (its uncommitted changes) and left 3 review comments. Please address them all.',
    );
  });

  it('lists the conflicted files and the steps to finish without pushing', () => {
    const prompt = conflictPrompt('feat/x', ['a.ts', 'b.ts']);
    expect(prompt).toContain('- a.ts\n- b.ts');
    expect(prompt).toContain('GIT_EDITOR=true git rebase --continue');
    expect(prompt).toContain('Do not push.');
  });

  it('sends a nonqueue follow-up, and reports a send the host refused', () => {
    const send = vi.fn();
    expect(deliverToAgent(send, 's1', 'hello')).toBeUndefined();
    expect(send).toHaveBeenCalledWith('s1', { type: 'follow_up', message: 'hello' });
    const refuse = vi.fn(() => {
      throw new Error('The session protocol is not connected.');
    });
    expect(deliverToAgent(refuse, 's1', 'hello')).toBe('The session protocol is not connected.');
  });
});

describe('git auth form', () => {
  const saved = { method: 'https' as const, https: { host: 'github.com', username: 'vngo', hasToken: true } };

  it('starts from the saved view with an empty token', () => {
    expect(formFromView(saved)).toEqual({
      method: 'https',
      keyPath: '',
      host: 'github.com',
      username: 'vngo',
      token: '',
    });
    expect(formFromView({ method: 'none' }).host).toBe(DEFAULT_HTTPS_HOST);
  });

  it('keeps a saved token for the same host and asks again when the host changes', () => {
    const form = formFromView(saved);
    expect(formProblem(form, saved)).toBeUndefined();
    expect(saveRequestOf(form)).toEqual({ method: 'https', host: 'github.com', username: 'vngo' });
    expect(formProblem({ ...form, host: 'gitlab.com' }, saved)).toBe(
      'The host changed, so enter the token for the new host.',
    );
    expect(formProblem({ ...form, token: 'a\nb' }, saved)).toMatch(/control character/u);
  });

  it('checks ssh key paths and allows a blank one', () => {
    const ssh = { ...formFromView({ method: 'none' }), method: 'ssh' as const };
    expect(formProblem(ssh, { method: 'none' })).toBeUndefined();
    expect(saveRequestOf(ssh)).toEqual({ method: 'ssh' });
    expect(formProblem({ ...ssh, keyPath: 'id_rsa' }, { method: 'none' })).toMatch(/absolute/u);
    expect(saveRequestOf({ ...ssh, keyPath: ' ~/.ssh/id ' })).toEqual({ method: 'ssh', keyPath: '~/.ssh/id' });
  });
});
