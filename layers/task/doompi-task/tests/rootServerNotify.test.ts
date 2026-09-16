/**
 * The headless adapter behind `DelegationNotifier`.
 *
 * `DelegationManager` asks for `{ triggerTurn: true, deliverAs: 'steer' }` when
 * a delegated subagent settles (`services/delegation`), and the Pi facet
 * forwards that to `pi.sendMessage` verbatim. The headless facet has to do the
 * same work by hand, and for a long time it did not: it dropped the options and
 * called `client.notify`, which writes an operator-only custom entry the model
 * never sees. A finished subagent left the cockpit agent sitting idle.
 *
 * `delegation.test.ts` covers the producer against an injected stub, so it
 * cannot see any of this. These tests cover the adapter itself.
 */

import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';
import { describe, expect, it, vi } from 'vitest';

import rootSession from '../src/extensions/workspaces/sessions/(backend)/_lib/root.server';
import * as delegationModule from '../src/services/delegation';

type Notify = (
  message: { customType: string; content: string; display: boolean },
  options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' },
) => void;

const CONTENT = 'Subagent doompi-reviewer completed task #2: Trace the facet\n\nAll tasks are completed.';

async function fixture() {
  const session = {
    entries: () => [],
    appendCustomEntry: vi.fn(async () => undefined),
    prompt: vi.fn(async () => undefined),
    admitPrompt: vi.fn(async () => undefined),
    activity: vi.fn(async () => ({ hasPendingMessages: false, isIdle: true })),
    abort: vi.fn(),
    compact: vi.fn(),
  };
  const client = { notify: vi.fn(async () => undefined), request: vi.fn(), setStatus: vi.fn() };
  const execution = {
    cwd: process.cwd(),
    repoRoot: process.cwd(),
    sessionId: 'task-notify-session',
    environment: {},
    client,
    session,
    selection: { majorMode: 'test', activeLayers: ['task'], domains: [], minorModes: [] },
    shutdown: vi.fn(),
  };
  const context = {
    host: {
      scope: 'session' as const,
      context: {
        environment: {},
        directEvents: { publish: vi.fn(), subscribe: vi.fn(() => () => undefined), close: vi.fn() },
      },
    },
    agent: { context: execution },
  } as unknown as DoomServerPluginContext;

  const constructed = vi.spyOn(delegationModule, 'DelegationManager');
  try {
    await rootSession(context);
    const options = constructed.mock.calls.at(-1)?.[0] as { notify?: Notify } | undefined;
    if (!options?.notify) throw new Error('The task server root did not supply a delegation notifier');
    return { notify: options.notify, session, client };
  } finally {
    constructed.mockRestore();
  }
}

describe('task headless delegation notifier', () => {
  it('wakes the model, records the full content, and keeps the toast to one line', async () => {
    const test = await fixture();

    test.notify({ customType: 'doom-task-notify', content: CONTENT, display: true }, { triggerTurn: true, deliverAs: 'steer' });

    // `admitPrompt` is the only call that reaches the model. `prompt(_, 'steer')`
    // would not: it is enqueue-only and parks the message on an idle lane.
    await vi.waitFor(() => expect(test.session.admitPrompt).toHaveBeenCalled());
    expect(test.session.admitPrompt).toHaveBeenCalledWith(CONTENT, 'steer');
    expect(test.session.prompt).not.toHaveBeenCalled();

    // The toast is operator-facing and gets flattened to one line and capped at
    // 4096 characters upstream, so it carries the headline rather than the
    // whole result.
    expect(test.client.notify).toHaveBeenCalledWith({
      body: 'Subagent doompi-reviewer completed task #2: Trace the facet',
      level: 'info',
    });

    // The durable record keeps every line, under the type the TUI renderer uses.
    expect(test.session.appendCustomEntry).toHaveBeenCalledWith('doom-task-notify', { content: CONTENT });
  });

  it('leaves the model asleep when the producer asks for no turn', async () => {
    const test = await fixture();

    test.notify({ customType: 'doom-task-notify', content: CONTENT, display: true }, { triggerTurn: false });

    await vi.waitFor(() => expect(test.session.appendCustomEntry).toHaveBeenCalled());
    expect(test.session.admitPrompt).not.toHaveBeenCalled();
  });

  it('reports a failed wake to the operator instead of stalling later notifications', async () => {
    const test = await fixture();
    test.session.admitPrompt.mockRejectedValueOnce(new Error('lane closed'));

    test.notify({ customType: 'doom-task-notify', content: 'first', display: true }, { triggerTurn: true });
    test.notify({ customType: 'doom-task-notify', content: 'second', display: true }, { triggerTurn: true });

    await vi.waitFor(() => expect(test.session.admitPrompt).toHaveBeenCalledTimes(2));
    expect(test.client.notify).toHaveBeenCalledWith({ body: 'Error: lane closed', level: 'warning' });
    // A rejected delivery must not poison the tail the next one is chained on.
    expect(test.session.admitPrompt).toHaveBeenNthCalledWith(2, 'second', 'steer');
  });
});
