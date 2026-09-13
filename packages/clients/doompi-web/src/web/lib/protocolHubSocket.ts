import { DoomPluginService, type DoomPluginCall } from '@agimon-ai/doompi-core/plugin-protocol';
import { DOOM_COCKPIT_SERVER_ID, DoomHubService, type HubService } from '@agimon-ai/doompi-core/session-protocol';
import { createRemoteServiceBinding, type RemoteServiceBinding } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context';
import { createClientServiceTransport, type Client } from '@earendil-works/pi-client';
type Frame = Record<string, unknown>;

export interface SessionSocket {
  send(frame: object): void;
  invokePlugin(call: DoomPluginCall): Promise<unknown>;
  close(): void;
}

export interface SessionSocketHandlers {
  onFrame(frame: Frame): void;
  onOpen(): void;
  onClose(): void;
}

/** Hub administration and plugin events share the session's authenticated Pi byte connection. */
export function createProtocolHubSocket(client: Client, handlers: SessionSocketHandlers): SessionSocket {
  let binding: RemoteServiceBinding | undefined;
  let service: HubService | undefined;
  let pluginService: DoomPluginService | undefined;
  let unsubscribe: (() => void) | undefined;
  let cancelOpening: ((reason?: unknown) => void) | undefined;
  let stopped = false;
  let generation = 0;
  const release = () => {
    generation += 1;
    cancelOpening?.(new Error('The hub binding was replaced.'));
    cancelOpening = undefined;
    service = undefined;
    pluginService = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    const previous = binding;
    binding = undefined;
    if (previous) void previous.dispose(BACKGROUND_CONTEXT).catch(() => undefined);
  };
  const open = async () => {
    release();
    const mine = generation;
    const next = createRemoteServiceBinding({
      services: [DoomHubService, DoomPluginService],
      transport: createClientServiceTransport(client, () => ({ serverId: DOOM_COCKPIT_SERVER_ID })),
    });
    binding = next;
    const opening = withCancel(BACKGROUND_CONTEXT);
    cancelOpening = opening.cancel;
    try {
      const hub = next.use(DoomHubService);
      await next.ready(opening.context);
      if (stopped || mine !== generation) return;
      service = hub;
      pluginService = next.use(DoomPluginService);
      let sequence = 0;
      const publish = (state: NonNullable<typeof hub.state.value>) => {
        for (const event of state.events) {
          if (event.sequence <= sequence) continue;
          if (event.sequence !== sequence + 1) throw new Error('Hub replay gap; reconnect required.');
          sequence = event.sequence;
          handlers.onFrame(event.frame);
        }
      };
      handlers.onOpen();
      if (hub.state.value) publish(hub.state.value);
      unsubscribe = hub.state.subscribe(publish);
    } catch {
      if (!stopped && mine === generation) {
        release();
        handlers.onClose();
        client.disconnect();
      }
    } finally {
      if (cancelOpening === opening.cancel) cancelOpening = undefined;
      // A stale opening may have been replaced before ready completed. If release
      // did not already own disposal, close this binding here.
      if (binding === next && (stopped || mine !== generation)) {
        binding = undefined;
        await next.dispose(BACKGROUND_CONTEXT).catch(() => undefined);
      }
    }
  };
  const stopWatch = client.onConnectionStateChange((change) => {
    if (stopped) return;
    if (change.state === 'connected') void open();
    else if (change.state === 'disconnected') {
      release();
      handlers.onClose();
    }
  });
  if (client.connected) void open();
  return {
    async invokePlugin(call) {
      const current = pluginService;
      if (!current) throw new Error('The hub protocol is not connected.');
      return current.invoke(call as Parameters<DoomPluginService['invoke']>[0], BACKGROUND_CONTEXT);
    },
    send(frame) {
      const current = service;
      if (!current) throw new Error('The hub protocol is not connected.');
      const mine = generation;
      void current.send(frame as Parameters<HubService['send']>[0], BACKGROUND_CONTEXT).catch(() => {
        if (!stopped && mine === generation && service === current) {
          handlers.onClose();
          client.disconnect();
        }
      });
    },
    close() {
      stopped = true;
      stopWatch();
      release();
    },
  };
}
