// @scaffold-generated
import { describe, expect, it } from 'vitest';

import { newSessionRequest } from '../../../src/services/newSessionRequest';

describe('newSessionRequest', () => {
  it('accepts both worktree modes, trimming text and dropping blank optionals', () => {
    expect(newSessionRequest({ mode: 'existing-branch', branch: ' feature/x ', name: '  ' })).toEqual({
      mode: 'existing-branch',
      branch: 'feature/x',
    });
    expect(
      newSessionRequest({ mode: 'existing-branch', branch: 'remote-only', remote: 'origin', name: 'Fix' }),
    ).toEqual({
      mode: 'existing-branch',
      branch: 'remote-only',
      remote: 'origin',
      name: 'Fix',
    });
    expect(newSessionRequest({ mode: 'new-branch', branch: 'wt/new', baseRef: 'origin/main' })).toEqual({
      mode: 'new-branch',
      branch: 'wt/new',
      baseRef: 'origin/main',
    });
  });

  it('refuses unsafe refs, bad names, unknown modes, and non-object bodies', () => {
    for (const body of [
      null,
      [],
      'text',
      { mode: 'new-branch' },
      { mode: 'new-branch', branch: '--upload-pack=x' },
      { mode: 'new-branch', branch: 'ok', baseRef: '-x' },
      { mode: 'existing-branch', branch: 'ok', remote: 'a b' },
      { mode: 'existing-branch', branch: 'ok', remote: 7 },
      { mode: 'new-branch', branch: 'ok', name: 5 },
      { mode: 'new-branch', branch: 'ok', name: 'x'.repeat(121) },
      { mode: 'plain', branch: 'ok' },
    ]) {
      expect(newSessionRequest(body), JSON.stringify(body)).toHaveProperty('error');
    }
  });
});
