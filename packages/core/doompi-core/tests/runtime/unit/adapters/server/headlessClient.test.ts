import { spawn } from 'node:child_process';

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

  it('delivers a notification live instead of rejecting when the journal refuses it', async () => {
    const bridge = setup();
    bridge.appendCustomEntry.mockRejectedValueOnce(new Error('Direct harness writes are quarantined'));
    await expect(bridge.client.notify({ body: 'turn failed', level: 'error' })).resolves.toBeUndefined();
    expect(bridge.frames).toEqual([
      {
        type: 'error',
        code: 'notification_undelivered',
        error: 'turn failed (not saved to history: Direct harness writes are quarantined)',
      },
    ]);
  });
  it('ignores notifications after disposal without writing or emitting', async () => {
    const bridge = setup();
    bridge.dispose();
    bridge.dispose();
    await expect(bridge.client.notify({ body: 'late failure', level: 'error' })).resolves.toBeUndefined();
    expect(bridge.appendCustomEntry).not.toHaveBeenCalled();
    expect(bridge.frames).toEqual([]);
  });

  it.each(['resolve', 'reject'] as const)('does not redeliver an append that %s after disposal', async (outcome) => {
    const bridge = setup();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    bridge.appendCustomEntry.mockReturnValueOnce(
      new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      }),
    );
    const notification = bridge.client.notify({ body: 'pending failure', level: 'error' });
    bridge.dispose();
    if (outcome === 'resolve') resolve();
    else reject(new Error('journal closed'));
    await expect(notification).resolves.toBeUndefined();
    expect(bridge.appendCustomEntry).toHaveBeenCalledOnce();
    expect(bridge.frames).toEqual([]);
  });

  it('still rejects invalid notifications while live', async () => {
    const bridge = setup();
    await expect(bridge.client.notify({ body: '', level: 'error' })).rejects.toThrow('Invalid notification request');
    expect(bridge.appendCustomEntry).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it('keeps strict Node alive for discarded late notification promises', async () => {
    const entry = new URL('../../../../../dist/src/services/headlessClient/index.mjs', import.meta.url).href;
    const script = `
import assert from 'node:assert/strict';
import { createHeadlessClient } from ${JSON.stringify(entry)};
const tick = () => new Promise(resolve => setImmediate(resolve));
const closed = createHeadlessClient({ appendCustomEntry: async () => { throw Error('unexpected append'); }, emitFrame: () => { throw Error('stale frame'); } });
closed.dispose();
void closed.client.notify({ body: 'late failure', level: 'error' });
await tick();
const append = Promise.withResolvers();
let appends = 0;
const pending = createHeadlessClient({ appendCustomEntry: () => { appends++; return append.promise; }, emitFrame: () => { throw Error('stale fallback'); } });
void pending.client.notify({ body: 'pending failure', level: 'error' });
pending.dispose();
append.reject(Error('journal closed'));
await tick();
assert.equal(appends, 1);
let saved = 0;
const sibling = createHeadlessClient({ appendCustomEntry: async () => { saved++; }, emitFrame: () => {} });
await sibling.client.notify({ body: 'sibling survives', level: 'info' });
assert.equal(saved, 1);
sibling.dispose();
console.log('LATE_NOTIFICATIONS_CONTAINED');`;
    const child = spawn(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      expect(code, stderr + stdout).toBe(0);
      expect(stdout).toContain('LATE_NOTIFICATIONS_CONTAINED');
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 15_000);
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
