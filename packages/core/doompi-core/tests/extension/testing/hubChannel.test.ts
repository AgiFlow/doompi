import { describe, expect, it } from 'vitest';

import type { DoomHubChannel, DoomHubChannelHost } from '../../../src/schemas/hubChannel';
import { doomHubChannelHarness } from '../../../src/services/hubChannelHarness';

function runsChannel(): DoomHubChannel {
  return {
    frameType: 'demo_runs',
    start(host: DoomHubChannelHost) {
      const known = new Map(host.sessions().map((scope) => [scope.sessionId, scope.cwd]));
      return {
        payloadFor: (scope) => (known.has(scope.sessionId) ? { items: [known.get(scope.sessionId)] } : undefined),
        sessionAdded: (scope) => {
          known.set(scope.sessionId, scope.cwd);
          host.publish(scope.sessionId, { items: [scope.cwd] });
        },
        sessionRemoved: (sessionId) => {
          known.delete(sessionId);
          host.onNotice(`forgot ${sessionId}`);
        },
        threadJournal: (scope, threadId) => `${scope.cwd}/${threadId}.jsonl`,
        close: () => host.onNotice('closed'),
      };
    },
  };
}

describe('doomHubChannelHarness', () => {
  it('covers snapshots, pushes, removal, journals, and cleanup', () => {
    const harness = doomHubChannelHarness(runsChannel(), { sessions: [{ sessionId: 's1', cwd: '/repo' }] });
    expect(harness.snapshot('s1')).toEqual({ items: ['/repo'] });

    harness.addSession({ sessionId: 's2', cwd: '/other' });
    expect(harness.published).toEqual([{ type: 'demo_runs', sessionId: 's2', payload: { items: ['/other'] } }]);
    expect(harness.source.threadJournal?.({ sessionId: 's2', cwd: '/other' }, 'run-3')).toBe('/other/run-3.jsonl');

    harness.removeSession('s2');
    harness.removeSession('s1');
    expect(harness.snapshot('s1')).toBeUndefined();
    expect(harness.notices).toEqual(['forgot s2', 'forgot s1']);

    harness.close();
    expect(harness.notices).toEqual(['forgot s2', 'forgot s1', 'closed']);
  });
});
