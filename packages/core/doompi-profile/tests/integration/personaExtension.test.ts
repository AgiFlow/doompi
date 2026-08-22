import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readHarnessState } from '@agimon-ai/doompi-config/harnessState';
import { provideDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { personaExtension } from '../../src/adapters/pi/persona.ts';
import type { ProfileTelemetry } from '../../src/types/telemetry.ts';

type Handler = (event?: unknown, context?: ExtensionContext) => unknown;

const telemetry: ProfileTelemetry = {
  recordError: async () => undefined,
  recordEvent: async () => undefined,
};

function harness(failPersonaRegistration = false) {
  const handlers = new Map<string, Handler>();
  const eventHandlers = new Map<string, Set<(value: unknown) => void>>();
  const pi = {
    events: {
      emit(event: string, value: unknown) {
        for (const handler of eventHandlers.get(event) ?? []) handler(value);
      },
      on(event: string, handler: (value: unknown) => void) {
        const subscriptions = eventHandlers.get(event) ?? new Set();
        subscriptions.add(handler);
        eventHandlers.set(event, subscriptions);
        return () => subscriptions.delete(handler);
      },
    },
    on(event: string, handler: Handler) {
      if (failPersonaRegistration && event === 'before_agent_start') throw new Error('persona registration boom');
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  return { handlers, pi };
}

async function bindConfig(pi: ExtensionAPI, source: string, root: string, personaFile?: string) {
  const connection = await connectDoomCordisHost(pi, source);
  const fiber = connection.root.plugin((cordis) => {
    provideDoomConfigContext(
      cordis,
      {
        settings: { projectTrust: 'ask' },
        harness: { ...readHarnessState({}), root, personaFile },
        requiresRelaunch: false,
      },
      `${source}:config`,
    );
  });
  await fiber;
  return {
    async dispose() {
      try {
        await fiber.dispose();
      } finally {
        await connection.dispose();
      }
    },
  };
}

describe('persona Pi factory', () => {
  it('clears a lost config provider and reads from its replacement', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-persona-extension-'));
    const firstFile = path.join(root, 'first.md');
    const replacementFile = path.join(root, 'replacement.md');
    fs.writeFileSync(firstFile, 'First persona.');
    fs.writeFileSync(replacementFile, 'Replacement persona.');
    const { handlers, pi } = harness();
    await personaExtension(pi, telemetry);
    const beforeAgentStart = handlers.get('before_agent_start');
    if (!beforeAgentStart) throw new Error('the persona hook was not registered');
    const event = { systemPrompt: 'Base prompt.' };

    await expect(beforeAgentStart(event)).rejects.toThrow('waiting for the session config service');

    const first = await bindConfig(pi, 'persona-provider-first', root, firstFile);
    await expect(beforeAgentStart(event)).resolves.toEqual({ systemPrompt: 'Base prompt.\n\nFirst persona.' });

    await first.dispose();
    await expect(beforeAgentStart(event)).rejects.toThrow('waiting for the session config service');

    const replacement = await bindConfig(pi, 'persona-provider-replacement', root, replacementFile);
    try {
      await expect(beforeAgentStart(event)).resolves.toEqual({
        systemPrompt: 'Base prompt.\n\nReplacement persona.',
      });
    } finally {
      await replacement.dispose();
      await handlers.get('session_shutdown')?.();
      await handlers.get('session_shutdown')?.();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rethrows a failed handler registration after releasing its host lease', async () => {
    const { pi } = harness(true);

    await expect(personaExtension(pi, telemetry)).rejects.toThrow('persona registration boom');
  });
});
