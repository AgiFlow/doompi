import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessActivity,
  type DoomHeadlessHook,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';

const CONFIG_PATH = '.doom/config.yaml';

async function readOrFallback(filePath: string, fallback: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

export const autocompactHeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    const resource: DoomHeadlessResource = {
      name: 'doompi/autocompact-config',
      kind: 'context',
      read: (execution) => readOrFallback(path.join(execution.cwd, CONFIG_PATH), '(no .doom/config.yaml found)'),
    };
    const hooks: DoomHeadlessHook[] = [
      {
        event: 'session_before_compact',
        async handle(event, execution) {
          if (event.reason !== 'threshold' || event.cancel === true) return undefined;
          // The host owns history projection and model selection. This hook only
          // requests the shared compaction path when a headless host asks for it.
          if (typeof event.instructions === 'string') await execution.session.compact(event.instructions);
          return { cancel: true };
        },
      },
      {
        event: 'session_compact',
        handle(_event, execution) {
          execution.client.setStatus('doom-autocompact', undefined);
        },
      },
      {
        event: 'session_shutdown',
        handle(_event, execution) {
          execution.client.setStatus('doom-autocompact', undefined);
        },
      },
    ];
    const activity: DoomHeadlessActivity = {
      name: 'doompi-autocompact',
      start(execution) {
        execution.client.setStatus('doom-autocompact', 'ready');
        return () => execution.client.setStatus('doom-autocompact', undefined);
      },
    };
    const registrations = [
      host.registerResource(resource),
      ...hooks.map((hook) => host.registerHook(hook)),
      host.registerActivity(activity),
    ];
    return () => {
      for (const registration of registrations) registration.dispose();
    };
  },
};
