import { randomUUID } from 'node:crypto';

import { createDoomNotificationEntryData, DOOM_NOTIFICATION_ENTRY_TYPE } from '../../exports/notification';
import type {
  HeadlessClientBridge,
  HeadlessClientOptions,
  PendingClientRequest,
} from '../../types/server/headlessClient';

/** Explicit client interactions over the existing browser dialog protocol. */
export function createHeadlessClient(options: HeadlessClientOptions): HeadlessClientBridge {
  const pending = new Map<string, PendingClientRequest>();
  let disposed = false;
  const advance = (): void => pending.values().next().value?.start();

  return {
    client: {
      async notify(request) {
        if (disposed) throw new Error('Headless client is closed');
        const data = createDoomNotificationEntryData(request);
        if (!data) throw new Error('Invalid notification request');
        await options.appendCustomEntry(DOOM_NOTIFICATION_ENTRY_TYPE, data);
      },
      setStatus(source, text) {
        if (disposed) throw new Error('Headless client is closed');
        options.emitFrame({ type: 'extension_ui_request', method: 'setStatus', statusKey: source, statusText: text });
      },
      appendComposerText(text) {
        if (disposed) throw new Error('Headless client is closed');
        options.emitFrame({ type: 'extension_ui_request', method: 'append_composer_text', id: randomUUID(), text });
      },
      request(request, signal) {
        if (disposed) return Promise.reject(new Error('Headless client is closed'));
        if (signal?.aborted) return Promise.resolve(undefined);
        if (!['confirm', 'select', 'input'].includes(request.kind)) {
          return Promise.reject(new Error('Unsupported headless client request'));
        }
        const labels = request.options?.map((option) => option.label);
        if (labels && new Set(labels).size !== labels.length) {
          return Promise.reject(new Error('Select option labels must be unique'));
        }
        const id = `headless-ui:${randomUUID()}`;
        return new Promise((resolve, reject) => {
          let started = false;
          const finish = (outcome: { value: unknown } | { error: unknown }): void => {
            if (!pending.delete(id)) return;
            signal?.removeEventListener('abort', abort);
            try {
              if (started) options.emitFrame({ type: 'extension_ui_answered', id });
              if ('error' in outcome) reject(outcome.error);
              else resolve(outcome.value);
            } catch (error) {
              reject(error);
            } finally {
              advance();
            }
          };
          const abort = (): void => finish({ value: undefined });
          pending.set(id, {
            start() {
              if (started || disposed) return;
              started = true;
              try {
                options.emitFrame({
                  type: 'extension_ui_request',
                  id,
                  method: request.kind === 'input' && request.multiline ? 'editor' : request.kind,
                  title: request.title,
                  message: request.message,
                  options: labels,
                  placeholder: request.message,
                  prefill: request.initialValue,
                });
              } catch (error) {
                finish({ error });
              }
            },
            respond(frame) {
              if (!started) return;
              if (frame.cancelled === true) return finish({ value: undefined });
              if (request.kind === 'confirm') {
                if (typeof frame.confirmed === 'boolean') finish({ value: frame.confirmed });
              } else if (typeof frame.value === 'string') {
                // Rich questionnaire clients return an encoded whole-answer envelope here.
                const selected = request.options?.find((option) => option.label === frame.value);
                finish({ value: selected?.value ?? frame.value });
              }
            },
            close: () => finish({ error: new Error('Headless client is closed') }),
          });
          signal?.addEventListener('abort', abort, { once: true });
          advance();
        });
      },
    },
    receive(frame) {
      if (frame.type !== 'extension_ui_response') return false;
      if (typeof frame.id === 'string') pending.get(frame.id)?.respond(frame);
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const request of pending.values()) request.close();
    },
  };
}
