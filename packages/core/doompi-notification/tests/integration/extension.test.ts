import {
  DOOM_ASK_USER_BLOCKED_EVENT,
  DOOM_ASK_USER_PROMPT_EVENT,
} from '@agimon-ai/doompi-extension-contracts/ask-user';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notificationExtension } from '../../src/adapters/pi/extension.ts';
import { createMainThreadTitleController } from '../../src/adapters/shellTitleController.ts';
import { createPiHarness, type PiHarness } from '../helpers/piHarness.ts';

const COMMAND_TIMEOUT_MS = 3_000;
const TITLE_FRAME_INTERVAL_MS = 80;

async function startExtension(harness: PiHarness): Promise<Context> {
  await notificationExtension(harness.pi, {
    titleController: createMainThreadTitleController(),
    environment: {},
  });
  const connection = await connectDoomCordisHost(harness.pi, '@test/notification-events');
  const cordis = connection.root;
  await connection.dispose();
  return cordis;
}

async function shutdown(harness: PiHarness, context?: ExtensionContext): Promise<void> {
  await harness.handlers.get('session_shutdown')?.({ type: 'session_shutdown' }, context ?? harness.context);
}

describe('notification extension', () => {
  let harness: PiHarness;
  let cordis: Context;

  beforeEach(async () => {
    vi.useFakeTimers();
    harness = createPiHarness();
    cordis = await startExtension(harness);
  });

  afterEach(async () => {
    await shutdown(harness);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('animates the shell-tab title while the agent is working', () => {
    harness.handlers.get('agent_start')?.({ type: 'agent_start' }, harness.context);

    expect(harness.setTitle).toHaveBeenLastCalledWith('⠋ π - example');
    vi.advanceTimersByTime(TITLE_FRAME_INTERVAL_MS);
    expect(harness.setTitle).toHaveBeenLastCalledWith('⠙ π - example');
  });

  it('keeps terminal title escapes out of RPC output', async () => {
    const rpcContext = { ...harness.context, mode: 'rpc' } as ExtensionContext;

    harness.handlers.get('input')?.({ type: 'input', text: 'Run remotely', source: 'rpc' }, rpcContext);
    harness.handlers.get('agent_start')?.({ type: 'agent_start' }, rpcContext);
    await harness.handlers.get('agent_settled')?.({ type: 'agent_settled' }, rpcContext);
    await shutdown(harness, rpcContext);

    expect(harness.setTitle).not.toHaveBeenCalled();
  });

  it('uses the first user prompt to distinguish an unnamed shell tab', () => {
    harness.handlers.get('input')?.(
      { type: 'input', text: 'Fix the shell title', source: 'interactive' },
      harness.context,
    );
    harness.handlers.get('input')?.(
      { type: 'input', text: 'Ignore this later prompt', source: 'interactive' },
      harness.context,
    );

    expect(harness.setTitle).toHaveBeenLastCalledWith('π - Fix the shell title - example');

    harness.handlers.get('agent_start')?.({ type: 'agent_start' }, harness.context);

    expect(harness.setTitle).toHaveBeenLastCalledWith('⠋ π - Fix the shell title - example');
  });

  it('ignores prompts this extension layer injected itself', () => {
    harness.handlers.get('input')?.({ type: 'input', text: 'Injected prompt', source: 'extension' }, harness.context);
    harness.handlers.get('agent_start')?.({ type: 'agent_start' }, harness.context);

    expect(harness.setTitle).toHaveBeenLastCalledWith('⠋ π - example');
  });

  it('leaves the tab untitled when the first prompt is blank', () => {
    harness.handlers.get('input')?.({ type: 'input', text: '   ', source: 'interactive' }, harness.context);

    expect(harness.setTitle).not.toHaveBeenCalled();
  });

  it('includes the session name in the animated shell-tab title', () => {
    harness.getSessionName.mockReturnValue('loader-work');

    harness.handlers.get('agent_start')?.({ type: 'agent_start' }, harness.context);

    expect(harness.setTitle).toHaveBeenLastCalledWith('⠋ π - loader-work - example');
  });

  it('restores the idle shell-tab title when the agent settles', async () => {
    harness.handlers.get('agent_start')?.({ type: 'agent_start' }, harness.context);

    await harness.handlers.get('agent_settled')?.({ type: 'agent_settled' }, harness.context);

    expect(harness.setTitle).toHaveBeenLastCalledWith('π - example');
    const callCount = harness.setTitle.mock.calls.length;
    vi.advanceTimersByTime(TITLE_FRAME_INTERVAL_MS);
    expect(harness.setTitle).toHaveBeenCalledTimes(callCount);
  });

  it('stops the shell-tab animation when the session shuts down', async () => {
    harness.handlers.get('agent_start')?.({ type: 'agent_start' }, harness.context);

    await shutdown(harness);

    expect(harness.setTitle).toHaveBeenLastCalledWith('π - example');
    const callCount = harness.setTitle.mock.calls.length;
    vi.advanceTimersByTime(TITLE_FRAME_INTERVAL_MS);
    expect(harness.setTitle).toHaveBeenCalledTimes(callCount);
  });

  it('notifies when the agent has fully settled', async () => {
    await harness.handlers.get('agent_settled')?.({ type: 'agent_settled' }, harness.context);

    expect(harness.exec).toHaveBeenCalledWith(
      'cmux',
      [
        'notify',
        '--title',
        'Pi finished',
        '--subtitle',
        'example',
        '--body',
        'The agent finished its work and is waiting for you.',
      ],
      { timeout: COMMAND_TIMEOUT_MS },
    );
  });

  it('does not report completion while follow-up messages are pending', async () => {
    const busyContext = { ...harness.context, hasPendingMessages: () => true } as ExtensionContext;

    await harness.handlers.get('agent_settled')?.({ type: 'agent_settled' }, busyContext);

    expect(harness.exec).not.toHaveBeenCalled();
  });

  it('notifies immediately when an agent-time approval dialog opens', async () => {
    harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.context);
    harness.handlers.get('agent_start')?.({ type: 'agent_start' }, harness.context);

    await harness.ui.confirm('Protected repository file', 'Allow this operation once?');

    expect(harness.exec).toHaveBeenCalledWith(
      'cmux',
      expect.arrayContaining(['--title', 'Pi needs your input', '--subtitle', 'Approval or feedback required']),
      { timeout: COMMAND_TIMEOUT_MS },
    );
  });

  it('announces select, input, and editor dialogs the agent opened', async () => {
    harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.context);
    harness.handlers.get('agent_start')?.({ type: 'agent_start' }, harness.context);

    await harness.ui.select('Pick a branch', ['main']);
    await harness.ui.input('Name the release', 'v1');
    await harness.ui.editor('Write the commit message', '');

    expect(harness.exec).toHaveBeenCalledTimes(3);
    expect(harness.exec.mock.calls.map((call) => call[1]?.at(-1))).toEqual([
      'Pick a branch',
      'Name the release',
      'Write the commit message',
    ]);
  });

  it('stays quiet for a dialog the user opened outside a run', async () => {
    harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.context);

    await harness.ui.confirm('Protected repository file', 'Allow this operation once?');

    expect(harness.exec).not.toHaveBeenCalled();
  });

  it('wraps each session UI exactly once across a reload', async () => {
    harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.context);
    harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.context);
    harness.handlers.get('agent_start')?.({ type: 'agent_start' }, harness.context);

    await harness.ui.confirm('Protected repository file', 'Allow this operation once?');

    expect(harness.exec).toHaveBeenCalledOnce();
  });

  it('restores wrapped dialog methods when the plugin fiber is disposed', async () => {
    const originalConfirm = harness.ui.confirm;
    const originalSelect = harness.ui.select;
    const originalInput = harness.ui.input;
    const originalEditor = harness.ui.editor;

    harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.context);

    expect(harness.ui.confirm).not.toBe(originalConfirm);
    expect(harness.ui.select).not.toBe(originalSelect);
    expect(harness.ui.input).not.toBe(originalInput);
    expect(harness.ui.editor).not.toBe(originalEditor);

    await shutdown(harness);

    expect(harness.ui.confirm).toBe(originalConfirm);
    expect(harness.ui.select).toBe(originalSelect);
    expect(harness.ui.input).toBe(originalInput);
    expect(harness.ui.editor).toBe(originalEditor);
  });

  it('uses the ask-user event without duplicating its wrapped dialog notification', async () => {
    harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.context);
    harness.handlers.get('agent_start')?.({ type: 'agent_start' }, harness.context);

    cordis.emit(DOOM_ASK_USER_PROMPT_EVENT, {
      questions: [
        {
          question: 'Which implementation?',
          header: 'Choice',
          multiSelect: false,
          options: [
            { label: 'A', description: 'First implementation.', hasPreview: false },
            { label: 'B', description: 'Second implementation.', hasPreview: false },
          ],
        },
      ],
    });
    cordis.emit(DOOM_ASK_USER_BLOCKED_EVENT, { active: true });
    await harness.ui.select('Which implementation?', ['A', 'B']);

    expect(harness.exec).toHaveBeenCalledOnce();
    expect(harness.exec.mock.calls[0]?.[1]).toContain('Which implementation?');
  });

  it('drops its event subscriptions and goes quiet once the fiber is disposed', async () => {
    harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.context);
    harness.handlers.get('agent_start')?.({ type: 'agent_start' }, harness.context);

    // Pi can fire session_shutdown more than once across a reload.
    await shutdown(harness);
    await shutdown(harness);

    for (const disposer of harness.busDisposers) expect(disposer).toHaveBeenCalledOnce();

    harness.setTitle.mockClear();
    cordis.emit(DOOM_ASK_USER_PROMPT_EVENT, {
      questions: [
        {
          question: 'Ignored after shutdown',
          header: 'Ignored',
          multiSelect: false,
          options: [],
        },
      ],
    });
    harness.handlers.get('agent_start')?.({ type: 'agent_start' }, harness.context);
    harness.handlers.get('input')?.({ type: 'input', text: 'After shutdown', source: 'interactive' }, harness.context);
    harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.context);
    await harness.handlers.get('agent_settled')?.({ type: 'agent_settled' }, harness.context);

    expect(harness.setTitle).not.toHaveBeenCalled();
    expect(harness.exec).not.toHaveBeenCalled();
  });
});

describe('notification extension in a detached subagent', () => {
  it('registers nothing, because the parent session already reports the run', async () => {
    const harness = createPiHarness();

    await notificationExtension(harness.pi, {
      titleController: createMainThreadTitleController(),
      environment: { PI_SUBAGENT_CHILD: '1' },
    });

    expect(harness.pi.on).not.toHaveBeenCalled();
    expect(harness.handlers.size).toBe(0);
  });
});

describe('notification extension when registration fails', () => {
  it('disposes the fiber and reports the failure rather than half-registering', async () => {
    const harness = createPiHarness();
    vi.mocked(harness.pi.on).mockImplementation(() => {
      throw new Error('registration boom');
    });

    await expect(
      notificationExtension(harness.pi, {
        titleController: createMainThreadTitleController(),
        environment: {},
      }),
    ).rejects.toThrow('registration boom');
    for (const disposer of harness.busDisposers) expect(disposer).toHaveBeenCalledOnce();
  });
});
