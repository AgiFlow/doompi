import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import type { WSContext } from 'hono/ws';
import { describe, expect, it, vi } from 'vitest';
import { createHubProtocol } from '../../src/adapters/hubProtocol.ts';

describe('hub events on the shared protocol', () => {
  it('retains synchronous startup events, orders replay and bounds the ring', () => {
    let socket!: WSContext;
    const hub = createHubProtocol(
      {
        onOpen(_event, ws) {
          socket = ws;
          ws.send(JSON.stringify({ type: 'sessions_snapshot', sessions: [] }));
        },
      },
      vi.fn(),
    );
    expect(hub.service.state.value?.events[0]).toMatchObject({ sequence: 1, frame: { type: 'sessions_snapshot' } });
    for (let index = 0; index < 1030; index++) socket.send(JSON.stringify({ type: 'session_upsert', index }));
    const events = hub.service.state.value!.events;
    expect(events).toHaveLength(1024);
    expect(events[0].sequence).toBe(8);
    expect(events.at(-1)?.sequence).toBe(1031);
    hub.close();
  });

  it('forwards commands, rejects cancellation and releases subscriptions once', async () => {
    const onMessage = vi.fn();
    const onClose = vi.fn();
    const hub = createHubProtocol({ onMessage, onClose }, vi.fn());
    await hub.service.send({ type: 'subscribe', sessionId: 's1' }, BACKGROUND_CONTEXT);
    const event = onMessage.mock.calls[0][0] as MessageEvent<string>;
    expect(JSON.parse(event.data)).toEqual({ type: 'subscribe', sessionId: 's1' });
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      hub.service.send({ type: 'subscribe' }, withAbortSignal(controller.signal, BACKGROUND_CONTEXT)),
    ).rejects.toThrow('cancelled');
    expect(onMessage).toHaveBeenCalledOnce();
    hub.close();
    hub.close();
    expect(onClose).toHaveBeenCalledOnce();
    await expect(hub.service.send({ type: 'subscribe' }, BACKGROUND_CONTEXT)).rejects.toThrow('closed');
  });

  it('cleans up a partially opened hub handler before propagating startup failure', () => {
    const onClose = vi.fn();
    const disconnect = vi.fn();
    expect(() =>
      createHubProtocol(
        {
          onOpen() {
            throw new Error('startup failed');
          },
          onClose,
        },
        disconnect,
      ),
    ).toThrow('startup failed');
    expect(onClose).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
