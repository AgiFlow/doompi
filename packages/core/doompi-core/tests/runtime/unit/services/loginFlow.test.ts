import { describe, expect, it } from 'vitest';
import { createLoginFlow } from '../../../../src/services/loginFlow';

const input = { id: 'flow-1', providerId: 'provider', providerName: 'Provider', type: 'oauth' as const };

describe('login flow', () => {
  it('publishes prompts and events, accepts only the current prompt, and settles successfully', async () => {
    const flow = createLoginFlow(input);
    flow.interaction.notify({ type: 'info', message: 'Open the provider' });
    const answer = flow.interaction.prompt({ type: 'text', message: 'Code?', placeholder: 'paste code' });
    expect(flow.snapshot()).toEqual({
      ...input,
      status: 'running',
      events: [{ type: 'info', message: 'Open the provider' }],
      prompt: { id: '1', type: 'text', message: 'Code?', placeholder: 'paste code' },
    });
    expect(flow.answer('wrong', 'ignored')).toBe(false);
    expect(flow.answer('1', 'secret')).toBe(true);
    expect(await answer).toBe('secret');
    expect(flow.answer('1', 'late')).toBe(false);
    flow.settle({ ok: true });
    flow.cancel();
    expect(flow.snapshot()).toMatchObject({ status: 'succeeded', events: [{ type: 'info' }] });
    expect(flow.interaction.signal.aborted).toBe(false);
  });

  it('supersedes an outstanding prompt and rejects it when its signal aborts', async () => {
    const flow = createLoginFlow(input);
    const first = flow.interaction.prompt({ type: 'secret', message: 'First' });
    const firstRejection = expect(first).rejects.toThrow('Superseded by a newer prompt');
    const promptController = new AbortController();
    const second = flow.interaction.prompt({ type: 'manual_code', message: 'Second', signal: promptController.signal });
    await firstRejection;
    expect(flow.snapshot().prompt).toEqual({ id: '2', type: 'manual_code', message: 'Second' });
    const secondRejection = expect(second).rejects.toThrow('Login cancelled');
    promptController.abort();
    await secondRejection;
    expect(flow.snapshot().prompt).toBeUndefined();
    expect(flow.answer('2', 'late')).toBe(false);
  });

  it('cancels pending and future prompts, and preserves cancellation over settlement', async () => {
    const flow = createLoginFlow(input);
    const answer = flow.interaction.prompt({ type: 'secret', message: 'Key' });
    const rejection = expect(answer).rejects.toThrow('Login cancelled');
    flow.cancel();
    await rejection;
    flow.cancel();
    flow.settle({ ok: false, error: 'late failure' });
    expect(flow.snapshot()).toMatchObject({ status: 'cancelled', events: [] });
    expect(flow.snapshot().error).toBeUndefined();
    expect(flow.interaction.signal.aborted).toBe(true);
    await expect(flow.interaction.prompt({ type: 'text', message: 'Too late' })).rejects.toThrow('Login cancelled');
  });

  it('records failure and rejects an outstanding prompt', async () => {
    const flow = createLoginFlow(input);
    const answer = flow.interaction.prompt({ type: 'text', message: 'Code?' });
    const rejection = expect(answer).rejects.toThrow('Login cancelled');
    flow.settle({ ok: false, error: 'provider refused' });
    await rejection;
    expect(flow.snapshot()).toMatchObject({ status: 'failed', error: 'provider refused' });
  });

  it.each(['device_code', 'device-code'])('automatically selects remote %s', async (id) => {
    const flow = createLoginFlow({ ...input, remote: true });
    expect(
      await flow.interaction.prompt({
        type: 'select',
        message: 'How?',
        options: [
          { id: 'browser', label: 'Browser' },
          { id, label: 'Device code' },
        ],
      }),
    ).toBe(id);
    expect(flow.snapshot()).toMatchObject({ remote: true, status: 'running' });
    expect(flow.snapshot().prompt).toBeUndefined();
  });

  it('shows a remote select when no device-code method is offered', async () => {
    const flow = createLoginFlow({ ...input, remote: true });
    const answer = flow.interaction.prompt({
      type: 'select',
      message: 'How?',
      options: [{ id: 'browser', label: 'Browser' }],
    });
    expect(flow.snapshot().prompt).toEqual({
      id: '1',
      type: 'select',
      message: 'How?',
      options: [{ id: 'browser', label: 'Browser' }],
    });
    expect(flow.answer('1', 'browser')).toBe(true);
    expect(await answer).toBe('browser');
  });

  it('rejects a prompt whose own signal was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const flow = createLoginFlow(input);
    await expect(
      flow.interaction.prompt({ type: 'text', message: 'Code?', signal: controller.signal }),
    ).rejects.toThrow('Login cancelled');
    expect(flow.snapshot().prompt).toBeUndefined();
  });
});
