import { describe, expect, it } from 'vitest';

import { stepUpActionFor } from '../../../../src/services/webauthnPolicy';

describe('stepUpActionFor', () => {
  it('gates reviving a session exactly as it gates creating one', () => {
    // Reviving starts an agent in a directory. A paired remote device reaching
    // it without step-up would be creating a session by another name.
    expect(stepUpActionFor('POST', '/api/workspaces/w/sessions')).toBe('session.create');
    expect(stepUpActionFor('POST', '/api/workspaces/w/resume')).toBe('session.create');
    expect(stepUpActionFor('POST', '/api/workspaces/w/sessions/one/revive')).toBe('session.create');
    expect(stepUpActionFor('POST', '/api/workspaces/w/sessions/one/resume')).toBe('session.create');
  });

  it('gates a git worktree session from the new-session dialog, but not its branch listing', () => {
    expect(stepUpActionFor('POST', '/api/workspaces/w/plugins/git/sessions')).toBe('session.create');
    expect(stepUpActionFor('GET', '/api/workspaces/w/plugins/git/branches')).toBeUndefined();
    expect(stepUpActionFor('POST', '/api/workspaces/w/plugins/git/sessions/extra')).toBeUndefined();
  });

  it("gates writing a workspace's git remote credentials, but not reading them", () => {
    expect(stepUpActionFor('PUT', '/api/workspaces/w/plugins/git/auth')).toBe('settings.write');
    expect(stepUpActionFor('GET', '/api/workspaces/w/plugins/git/auth')).toBeUndefined();
    expect(stepUpActionFor('PUT', '/api/workspaces/w/plugins/git/auth/extra')).toBeUndefined();
  });
  it('leaves reading and stopping a session ungated', () => {
    expect(stepUpActionFor('GET', '/api/workspaces/w/sessions')).toBeUndefined();
    expect(stepUpActionFor('DELETE', '/api/workspaces/w/sessions/one')).toBeUndefined();
    expect(stepUpActionFor('POST', '/api/workspaces/w/sessions/one/restart')).toBeUndefined();
  });
});
