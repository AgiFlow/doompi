import path from 'node:path';
import {
  createDoomNotificationEntryData,
  DOOM_NOTIFICATION_ENTRY_TYPE,
  type DoomNotificationRequest,
  type DoomNotificationService,
  normalizeDoomNotificationRequest,
} from '@agimon-ai/doompi-extension-contracts/notification';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { sendSystemNotification } from './systemNotification.ts';

const DEFAULT_TITLE = 'Pi';

export interface DoomNotificationRouterOptions {
  readonly generation: string;
  readonly pi: ExtensionAPI;
  readonly context: () => ExtensionContext | undefined;
}

/**
 * Creates the shared notification router for one extension runtime.
 *
 * A missing session, invalid request, or delivery failure is an intentional
 * silent outcome because notification delivery must never fail the active turn.
 * RPC delivery never falls back to a host notifier after an append failure.
 */
export function createDoomNotificationRouter({
  generation,
  pi,
  context: readContext,
}: DoomNotificationRouterOptions): DoomNotificationService {
  return Object.freeze({
    generation,
    async request(request: DoomNotificationRequest): Promise<void> {
      const context = readContext();
      if (!context) return;

      try {
        const normalized = normalizeDoomNotificationRequest(request);
        if (!normalized) return;
        const data = createDoomNotificationEntryData({
          title: normalized.title ?? DEFAULT_TITLE,
          subtitle: normalized.subtitle ?? pi.getSessionName() ?? path.basename(context.cwd),
          body: normalized.body,
          level: normalized.level ?? 'info',
        });
        if (!data) return;

        if (context.mode === 'rpc') {
          pi.appendEntry(DOOM_NOTIFICATION_ENTRY_TYPE, data);
          return;
        }
        await sendSystemNotification(pi, data);
      } catch (error) {
        // Best-effort delivery deliberately ends here. In particular, an RPC
        // append failure must not leak the notification through the host OS.
        void error;
      }
    },
  });
}
