import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { provideDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import { readHarnessState } from '@agimon-ai/doompi-config/harnessState';
import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPersonaHandlers } from '../../src/adapters/pi/persona.ts';
import type { ProfileTelemetry } from '../../src/types/telemetry.ts';

type BeforeAgentStart = (
  event: { systemPrompt: string },
  ctx: ExtensionContext,
) => Promise<{ systemPrompt: string } | undefined>;

let root: string;
let cordis: Context | undefined;
const recorded: string[] = [];
const telemetry: ProfileTelemetry = {
  recordError: async (event) => {
    recorded.push(event);
  },
  recordEvent: async () => undefined,
};

function hookFor(personaFile?: string): { hook: BeforeAgentStart; ctx: ExtensionContext } {
  const handlers = new Map<string, BeforeAgentStart>();
  const pi = {
    on(event: string, handler: BeforeAgentStart) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: { getSessionId: () => 'persona-session' },
  } as unknown as ExtensionContext;
  cordis = new Context();
  provideDoomConfigContext(cordis, {
    settings: { projectTrust: 'ask' },
    harness: { ...readHarnessState({}), root, personaFile },
    requiresRelaunch: false,
  });
  registerPersonaHandlers(pi, telemetry, () => {
    if (!cordis) throw new Error('test runtime context is unavailable');
    return cordis;
  });
  const hook = handlers.get('before_agent_start');
  if (!hook) throw new Error('persona registered no before_agent_start hook');
  return { hook, ctx };
}

beforeEach(() => {
  recorded.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-persona-'));
});

afterEach(() => {
  void cordis?.fiber.dispose();
  cordis = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('persona entry', () => {
  it('appends the assembled persona to the system prompt', async () => {
    const personaFile = path.join(root, 'persona.md');
    fs.writeFileSync(personaFile, '[PERSONA] You are Mara.\n');
    const { hook, ctx } = hookFor(personaFile);

    const result = await hook({ systemPrompt: 'base prompt' }, ctx);

    expect(result?.systemPrompt).toBe('base prompt\n\n[PERSONA] You are Mara.');
  });

  it('does nothing when no persona file is recorded', async () => {
    const { hook, ctx } = hookFor(undefined);
    expect(await hook({ systemPrompt: 'base prompt' }, ctx)).toBeUndefined();
  });

  it('leaves the prompt alone when the persona file is empty', async () => {
    const personaFile = path.join(root, 'persona.md');
    fs.writeFileSync(personaFile, '   \n');
    const { hook, ctx } = hookFor(personaFile);

    expect(await hook({ systemPrompt: 'base prompt' }, ctx)).toBeUndefined();
  });

  it('reports an unreadable persona file rather than failing the turn', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { hook, ctx } = hookFor(path.join(root, 'missing.md'));

    expect(await hook({ systemPrompt: 'base prompt' }, ctx)).toBeUndefined();
    expect(recorded).toEqual(['doom_pi_profile.persona_read_failed']);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[pi-persona] could not read'));
    stderr.mockRestore();
  });
});
