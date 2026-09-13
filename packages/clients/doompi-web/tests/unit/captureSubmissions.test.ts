import type { ComposerCapture } from '@agimon-ai/doompi-core/web';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { onComposerSubmitted } from '../../src/web/lib/composerSubmissions';
import { sendSessionProtocolFrame } from '../../src/web/lib/sessionProtocolCommands';
import {
  applyCaptureFrame,
  disconnectCaptures,
  onCaptureStatus,
  submitCapture,
} from '../../src/web/stores/captureStore';

vi.mock('../../src/web/lib/sessionProtocolCommands', () => ({ sendSessionProtocolFrame: vi.fn() }));

vi.mock('../../src/web/stores/sessionsStore', () => ({
  sessionsStore: { state: { byId: { s1: { attach: 'attached' } } } },
}));
vi.mock('../../src/web/stores/sessionStore', () => ({ sessionStoreFor: () => ({ state: { streaming: false } }) }));

const bytes = new Uint8Array(33);
bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
new DataView(bytes.buffer).setUint32(16, 1);
new DataView(bytes.buffer).setUint32(20, 1);
const capture: ComposerCapture = {
  data: Buffer.from(bytes).toString('base64'),
  mimeType: 'image/png',
  context: { id: 'c1', kind: 'capture', source: 'test', label: 'Capture', content: 'Review this' },
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  disconnectCaptures();
  vi.mocked(sendSessionProtocolFrame).mockReset();
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
});

function setup() {
  const frames: Record<string, unknown>[] = [];
  vi.mocked(sendSessionProtocolFrame).mockImplementation((_sessionId, frame) => frames.push(frame));
  const events: string[] = [];
  cleanups.push(
    onComposerSubmitted(() => events.push('submitted')),
    onCaptureStatus((event) => events.push(event.status)),
  );
  return { frames, events };
}

describe('direct capture delivery', () => {
  it('does not publish or resolve on socket send; completes only after matched consumption', async () => {
    const { frames, events } = setup();
    const delivery = submitCapture('s1', capture);
    const command = frames[0];
    expect(events).toEqual([]);
    // Pi's internal request id is not the browser command id, so it cannot
    // claim this capture as accepted.
    applyCaptureFrame('s1', { type: 'response', id: 'pi-internal-id', success: true });
    expect(events).toEqual([]);
    applyCaptureFrame('s1', { type: 'response', id: command.id, success: true });
    await delivery;
    expect(events).toEqual(['submitted', 'queued']);
    applyCaptureFrame('s1', { type: 'agent_settled' });
    expect(events).toEqual(['submitted', 'queued']);
    applyCaptureFrame('s1', { type: 'message_start', message: { role: 'user', content: 'unrelated' } });
    applyCaptureFrame('s1', { type: 'agent_settled' });
    expect(events).toEqual(['submitted', 'queued']);
    applyCaptureFrame('s1', {
      type: 'entry_appended',
      entry: {
        id: 'user1',
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: `prefix\n${String(command.message)}\nsuffix` }] },
      },
    });
    applyCaptureFrame('s1', { type: 'agent_settled' });
    expect(events).toEqual(['submitted', 'queued', 'working', 'completed']);
  });

  it('queues concurrent captures and never completes the next capture with the first run', async () => {
    const { frames, events } = setup();
    const first = submitCapture('s1', capture);
    const second = submitCapture('s1', { ...capture, context: { ...capture.context, id: 'c2' } });
    expect(frames.map((frame) => frame.type)).toEqual(['prompt', 'follow_up']);
    frames.forEach((frame) => applyCaptureFrame('s1', { type: 'response', id: frame.id, success: true }));
    await Promise.all([first, second]);
    applyCaptureFrame('s1', { type: 'message_start', message: { role: 'user', content: frames[0].message } });
    applyCaptureFrame('s1', { type: 'agent_settled' });
    expect(events.filter((event) => event === 'completed')).toHaveLength(1);
    disconnectCaptures();
    expect(events.at(-1)).toBe('error');
  });

  it('rejects RPC refusal, unconfirmed delivery, and disconnected protocol without publishing submissions', async () => {
    vi.useFakeTimers();
    const { frames, events } = setup();
    const delivery = submitCapture('s1', capture);
    const rejected = expect(delivery).rejects.toThrow('refused');
    applyCaptureFrame('s1', { type: 'response', id: frames[0].id, success: false, error: 'refused' });
    await rejected;
    const offline = expect(submitCapture('s1', capture)).rejects.toThrow('not confirmed');
    await vi.advanceTimersByTimeAsync(30_000);
    await offline;
    vi.mocked(sendSessionProtocolFrame).mockImplementation(() => {
      throw new Error('The session protocol is not connected.');
    });
    await expect(submitCapture('s1', capture)).rejects.toThrow('The session protocol is not connected.');
    expect(events).toEqual([]);
  });

  it('publishes accepted consumption before working and marks aborted execution as error', async () => {
    const { frames, events } = setup();
    const delivery = submitCapture('s1', capture);
    applyCaptureFrame('s1', { type: 'message_start', message: { role: 'user', content: frames[0].message } });
    await delivery;
    applyCaptureFrame('s1', { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'aborted' }] });
    expect(events).toEqual(['submitted', 'working', 'error']);
  });

  it('retains an assistant message failure through a later settlement frame', async () => {
    const { frames, events } = setup();
    const delivery = submitCapture('s1', capture);
    applyCaptureFrame('s1', { type: 'message_start', message: { role: 'user', content: frames[0].message } });
    await delivery;
    applyCaptureFrame('s1', { type: 'message_end', message: { role: 'assistant', stopReason: 'error' } });
    applyCaptureFrame('s1', { type: 'agent_settled' });
    expect(events).toEqual(['submitted', 'working', 'error']);
  });
  it('rejects disconnect before acceptance and reports queue cancellation after acceptance', async () => {
    const { frames, events } = setup();
    const disconnected = expect(submitCapture('s1', capture)).rejects.toThrow('lost its connection');
    disconnectCaptures();
    await disconnected;
    expect(events).toEqual([]);
    const delivery = submitCapture('s1', capture);
    applyCaptureFrame('s1', { type: 'response', id: frames[1].id, success: true });
    await delivery;
    applyCaptureFrame('s1', { type: 'response', command: 'clear_queue', success: true });
    applyCaptureFrame('s1', { type: 'agent_end' });
    expect(events).toEqual(['submitted', 'queued', 'error']);
  });

  it('rejects invalid images without transport', async () => {
    const { frames } = setup();
    await expect(submitCapture('s1', { ...capture, data: 'invalid' })).rejects.toThrow();
    expect(frames).toEqual([]);
  });
});
