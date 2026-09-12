import { describe, expect, it, vi } from 'vitest';
import type { WebPluginRuntime } from '@agimon-ai/doompi-core/web';
import {
  requestWorktreeClose,
  requestWorktreeCreate,
  startWorktreeRuntime,
  worktreeActivity,
  worktreeActivitySource,
  worktreesChannel,
} from '../../../../src/web/stores/worktreesActivityStore';
import type { WorktreeView } from '../../../../src/types/webWorktrees';

function runtime(): { host: WebPluginRuntime; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    host: {
      sendSessionFrame: vi.fn(),
      sendHubFrame: (frame: Record<string, unknown>) => {
        sent.push(frame);
      },
      onHubConnected: () => () => undefined,
    } as unknown as WebPluginRuntime,
  };
}

/**
 * The frame has to arrive at the channel, not at the agent. A session frame is
 * enveloped as a session command and forwarded to the conversation, where a
 * channel never sees it, so the top-level shape is the whole point of these.
 */
describe('the commands the panel sends', () => {
  it('sends a create as a top-level channel frame', () => {
    const { host, sent } = runtime();
    const stop = startWorktreeRuntime(host);

    requestWorktreeCreate('session-1', ' wt/two ', ' main ');

    expect(sent).toEqual([
      {
        type: 'git_worktrees',
        sessionId: 'session-1',
        payload: { action: 'create', branch: 'wt/two', baseRef: 'main' },
      },
    ]);
    stop();
  });

  it('omits an empty base ref rather than sending a blank one', () => {
    const { host, sent } = runtime();
    const stop = startWorktreeRuntime(host);

    requestWorktreeCreate('session-1', 'wt/two', '   ');

    expect(sent[0]?.payload).toEqual({ action: 'create', branch: 'wt/two' });
    stop();
  });

  it('sends a close', () => {
    const { host, sent } = runtime();
    const stop = startWorktreeRuntime(host);

    requestWorktreeClose('session-1', 'wt1');

    expect(sent[0]?.payload).toEqual({ action: 'close', id: 'wt1' });
    stop();
  });

  /** After the page drops the socket a queued command would replay against a different session. */
  it('drops a command sent after the runtime stops', () => {
    const { host, sent } = runtime();
    startWorktreeRuntime(host)();

    requestWorktreeCreate('session-1', 'wt/two', '');

    expect(sent).toEqual([]);
  });
});

describe('what the channel accepts from the hub', () => {
  it('reads worktrees, pending and error', () => {
    const parsed = worktreesChannel.parse({
      worktrees: [
        { id: 'wt1', branch: 'wt/one', path: '/tmp/wt1', sessionId: 'child', orphaned: false, unowned: false },
      ],
      pending: 'creating wt/one…',
      error: 'nope',
    });

    expect(parsed).toEqual({
      worktrees: [expect.objectContaining({ id: 'wt1' })],
      pending: 'creating wt/one…',
      error: 'nope',
    });
  });

  it('rejects a payload that is not a worktree list', () => {
    expect(worktreesChannel.parse({ worktrees: 'all of them' })).toBeNull();
    expect(worktreesChannel.parse(null)).toBeNull();
  });
});

/**
 * The dock reads this to decide whether the session is busy, and the timeline
 * turns any busy group into "background work is still running".
 */
describe('what counts as work in progress', () => {
  it('does not call a standing worktree work in progress', () => {
    worktreeActivity.update('s1', () => ({
      worktrees: [{ id: 'wt1' } as WorktreeView],
      pending: undefined,
      error: undefined,
    }));

    expect(worktreeActivitySource.isActive('s1')).toBe(false);
  });

  it('counts an operation that is actually running', () => {
    worktreeActivity.update('s1', () => ({
      worktrees: [],
      pending: 'creating wt/one\u2026',
      error: undefined,
    }));

    expect(worktreeActivitySource.isActive('s1')).toBe(true);
  });
});
