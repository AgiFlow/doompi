import { describe, expect, it } from 'vitest';
import { createLoginFlow } from '../../src/services/loginFlow.ts';

const input = { id: 'f1', providerId: 'anthropic', providerName: 'Anthropic', type: 'api_key' as const };

describe('createLoginFlow', () => {
  it('starts running with nothing asked and nothing announced', () => {
    const flow = createLoginFlow(input);
    expect(flow.snapshot()).toEqual({ ...input, status: 'running', events: [] });
    expect(flow.interaction.signal.aborted).toBe(false);
  });

  it('exposes the pending prompt and resolves it with the answer', async () => {
    const flow = createLoginFlow(input);
    const answer = flow.interaction.prompt({ type: 'secret', message: 'Enter Anthropic API key' });

    expect(flow.snapshot().prompt).toEqual({ id: '1', type: 'secret', message: 'Enter Anthropic API key' });
    expect(flow.answer('1', 'sk-test')).toBe(true);
    await expect(answer).resolves.toBe('sk-test');
    expect(flow.snapshot().prompt).toBeUndefined();
  });

  it('refuses an answer to a prompt it is not waiting on', () => {
    const flow = createLoginFlow(input);
    expect(flow.answer('1', 'x')).toBe(false);
    void flow.interaction.prompt({ type: 'text', message: 'name?', placeholder: 'you' });
    expect(flow.answer('9', 'x')).toBe(false);
    expect(flow.snapshot().prompt).toEqual({ id: '1', type: 'text', message: 'name?', placeholder: 'you' });
  });

  it('carries select options into the view', () => {
    const flow = createLoginFlow(input);
    void flow.interaction.prompt({
      type: 'select',
      message: 'Which account?',
      options: [
        { id: 'a', label: 'Team', description: 'shared' },
        { id: 'b', label: 'Personal' },
      ],
    });
    expect(flow.snapshot().prompt).toEqual({
      id: '1',
      type: 'select',
      message: 'Which account?',
      options: [
        { id: 'a', label: 'Team', description: 'shared' },
        { id: 'b', label: 'Personal' },
      ],
    });
  });

  it('records events in order and copies them out', () => {
    const flow = createLoginFlow(input);
    flow.interaction.notify({ type: 'auth_url', url: 'https://x/auth' });
    flow.interaction.notify({ type: 'progress', message: 'waiting' });
    const events = flow.snapshot().events;
    expect(events).toEqual([
      { type: 'auth_url', url: 'https://x/auth' },
      { type: 'progress', message: 'waiting' },
    ]);
    events.length = 0;
    expect(flow.snapshot().events).toHaveLength(2);
  });

  it('cancel aborts the flow signal and rejects the pending prompt', async () => {
    const flow = createLoginFlow(input);
    const answer = flow.interaction.prompt({ type: 'secret', message: 'key?' });
    flow.cancel();
    expect(flow.interaction.signal.aborted).toBe(true);
    await expect(answer).rejects.toThrow('Login cancelled');
    expect(flow.snapshot().status).toBe('cancelled');
    expect(flow.snapshot().prompt).toBeUndefined();
    await expect(flow.interaction.prompt({ type: 'text', message: 'again?' })).rejects.toThrow('Login cancelled');
    expect(flow.answer('1', 'late')).toBe(false);
  });

  it('a prompt withdrawn by its own signal clears without ending the flow', async () => {
    const flow = createLoginFlow(input);
    const controller = new AbortController();
    const answer = flow.interaction.prompt({ type: 'manual_code', message: 'code?', signal: controller.signal });
    controller.abort();
    await expect(answer).rejects.toThrow('Login cancelled');
    expect(flow.snapshot().status).toBe('running');
    expect(flow.snapshot().prompt).toBeUndefined();
    await expect(flow.interaction.prompt({ type: 'text', message: 'x', signal: AbortSignal.abort() })).rejects.toThrow(
      'Login cancelled',
    );
  });

  it('a newer prompt supersedes the pending one', async () => {
    const flow = createLoginFlow(input);
    const first = flow.interaction.prompt({ type: 'text', message: 'first' });
    const second = flow.interaction.prompt({ type: 'text', message: 'second' });
    await expect(first).rejects.toThrow('Superseded');
    expect(flow.snapshot().prompt).toMatchObject({ id: '2', message: 'second' });
    expect(flow.answer('2', 'ok')).toBe(true);
    await expect(second).resolves.toBe('ok');
  });

  it('settles once, and never overrides a cancel', () => {
    const succeeded = createLoginFlow(input);
    succeeded.settle({ ok: true });
    succeeded.settle({ ok: false, error: 'later' });
    expect(succeeded.snapshot()).toMatchObject({ status: 'succeeded' });
    expect(succeeded.snapshot().error).toBeUndefined();

    const failed = createLoginFlow(input);
    failed.settle({ ok: false, error: 'The key was refused.' });
    expect(failed.snapshot()).toMatchObject({ status: 'failed', error: 'The key was refused.' });

    const cancelled = createLoginFlow(input);
    cancelled.cancel();
    cancelled.settle({ ok: false, error: 'Login cancelled' });
    expect(cancelled.snapshot().status).toBe('cancelled');
    cancelled.cancel();
    expect(cancelled.snapshot().status).toBe('cancelled');
  });
});
