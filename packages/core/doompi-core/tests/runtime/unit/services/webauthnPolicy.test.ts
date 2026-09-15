import { describe, expect, it } from 'vitest';

import { stepUpActionFor } from '../../../../src/services/webauthnPolicy';

describe('stepUpActionFor', () => {
  it('gates reviving a session exactly as it gates creating one', () => {
    // Reviving starts an agent in a directory. A paired remote device reaching
    // it without step-up would be creating a session by another name.
    expect(stepUpActionFor('POST', '/api/workspaces/w/sessions')).toBe('session.create');
    expect(stepUpActionFor('POST', '/api/workspaces/w/sessions/one/revive')).toBe('session.create');
    expect(stepUpActionFor('POST', '/api/workspaces/w/sessions/one/resume')).toBe('session.create');
  });

  it('leaves reading and stopping a session ungated', () => {
    expect(stepUpActionFor('GET', '/api/workspaces/w/sessions')).toBeUndefined();
    expect(stepUpActionFor('DELETE', '/api/workspaces/w/sessions/one')).toBeUndefined();
    expect(stepUpActionFor('POST', '/api/workspaces/w/sessions/one/restart')).toBeUndefined();
  });
});
