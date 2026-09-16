import { describe, expect, it } from 'vitest';

import teamContextResource from '../../src/extensions/workspaces/sessions/(backend)/resource/_lib/team.server';

/**
 * The context resource is pasted verbatim into the system prompt, sent to the
 * provider and persisted to disk. `TeamMemberContext.token` is a session
 * capability documented as never leaving the direct context, so serializing the
 * raw member struct here is a credential leak. These tests fail if anyone
 * reintroduces `channel.current()` in place of the public snapshot.
 */
const SECRET = 'TOKEN-THAT-MUST-NOT-REACH-THE-MODEL';

function resourceFor(snapshot: unknown) {
  const channel = {
    // Present, and deliberately never the source the resource reads.
    current: () => ({ memberId: 'main', role: 'main', token: SECRET }),
    snapshot: () => snapshot,
  };
  return teamContextResource({
    root: { channel, execution: { sessionId: 'session-1' } },
  } as never);
}

describe('the server team context resource', () => {
  it('never renders a member token', () => {
    const text = resourceFor({ members: [{ name: 'lead', role: 'main', agent: 'doompi-developer' }] }).read();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('token');
    expect(text).toBe('- lead | role: main | agent: doompi-developer');
  });

  it('contributes nothing when no team member is active', () => {
    expect(resourceFor({ members: [] }).read()).toBe('');
    expect(resourceFor(undefined).read()).toBe('');
  });
});
