import { describe, expect, it, vi } from 'vitest';

import { createHeadlessClient } from '../../../../../src/services/headlessClient';

function setup() {
  const frames: Record<string, unknown>[] = [];
  const appendCustomEntry = vi.fn(async () => {});
  const bridge = createHeadlessClient({ emitFrame: (frame) => frames.push(frame), appendCustomEntry });
  const requests = () => frames.filter((frame) => frame.type === 'extension_ui_request');
  return { ...bridge, frames, requests, appendCustomEntry };
}

describe('headless client bridge', () => {
  it('serializes dialogs and maps displayed labels to caller values', async () => {
    const bridge = setup();
    const first = bridge.client.request({ kind: 'select', title: 'Pick', options: [{ label: 'Yes', value: 'yes' }] });
    const second = bridge.client.request({ kind: 'confirm', title: 'Continue?' });
    expect(bridge.requests()).toHaveLength(1);
    const id = bridge.requests()[0]!.id;
    expect(bridge.receive({ type: 'extension_ui_response', id, value: 'Yes' })).toBe(true);
    await expect(first).resolves.toBe('yes');
    expect(bridge.requests()).toHaveLength(2);
    expect(bridge.frames[1]).toEqual({ type: 'extension_ui_answered', id });
    bridge.receive({ type: 'extension_ui_response', id: bridge.requests()[1]!.id, confirmed: false });
    await expect(second).resolves.toBe(false);
    bridge.dispose();
  });

  it('preserves whole-questionnaire envelopes and rejects malformed confirm responses', async () => {
    const bridge = setup();
    const envelope = '{"answers":[]}';
    const question = bridge.client.request({ kind: 'select', title: 'Pick', options: [{ label: 'A', value: 'a' }] });
    bridge.receive({ type: 'extension_ui_response', id: bridge.requests()[0]!.id, value: envelope });
    await expect(question).resolves.toBe(envelope);
    const confirm = bridge.client.request({ kind: 'confirm', title: 'Confirm' });
    const id = bridge.requests()[1]!.id;
    bridge.receive({ type: 'extension_ui_response', id, confirmed: 'yes' });
    expect(bridge.frames.filter((frame) => frame.type === 'extension_ui_answered')).toHaveLength(1);
    bridge.receive({ type: 'extension_ui_response', id, cancelled: true });
    await expect(confirm).resolves.toBeUndefined();
    bridge.dispose();
  });

  it('cancels queued and visible requests without opening a cancelled dialog', async () => {
    const bridge = setup();
    const visible = new AbortController();
    const queued = new AbortController();
    const first = bridge.client.request({ kind: 'input', title: 'First' }, visible.signal);
    const second = bridge.client.request({ kind: 'input', title: 'Second' }, queued.signal);
    queued.abort();
    await expect(second).resolves.toBeUndefined();
    expect(bridge.requests()).toHaveLength(1);
    visible.abort();
    await expect(first).resolves.toBeUndefined();
    expect(bridge.frames.at(-1)).toEqual({ type: 'extension_ui_answered', id: bridge.requests()[0]!.id });
    bridge.dispose();
  });

  it('persists normalized notifications, emits statuses and rejects work after disposal', async () => {
    const bridge = setup();
    await bridge.client.notify({ body: 'hello\nworld', level: 'warning' });
    expect(bridge.appendCustomEntry).toHaveBeenCalledWith('doom-notification', {
      version: 1,
      title: '',
      subtitle: '',
      body: 'hello world',
      level: 'warning',
    });
    bridge.client.setStatus('runner', 'Working');
    expect(bridge.frames[0]).toMatchObject({ method: 'setStatus', statusKey: 'runner', statusText: 'Working' });
    const first = bridge.client.request({ kind: 'input', title: 'First', multiline: true, initialValue: 'draft' });
    const second = bridge.client.request({ kind: 'input', title: 'Second' });
    const checks = [expect(first).rejects.toThrow('closed'), expect(second).rejects.toThrow('closed')];
    bridge.dispose();
    bridge.dispose();
    await Promise.all(checks);
    expect(bridge.requests().filter((frame) => frame.method === 'editor')).toEqual([
      expect.objectContaining({ title: 'First', prefill: 'draft' }),
    ]);
    await expect(bridge.client.request({ kind: 'input', title: 'After close' })).rejects.toThrow('closed');
  });
});

it('emits a distinct append request for native dictation and rejects it after disposal', () => {
  const bridge = setup();
  bridge.client.appendComposerText?.('dictated text');
  expect(bridge.requests()).toEqual([
    { type: 'extension_ui_request', method: 'append_composer_text', id: expect.any(String), text: 'dictated text' },
  ]);
  bridge.dispose();
  expect(() => bridge.client.appendComposerText?.('late text')).toThrow('closed');
});
