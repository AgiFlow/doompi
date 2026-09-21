import {
  DOOM_HEADLESS_OWNER,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessTool,
} from '@agimon-ai/doompi-core/headless';
import { HeadlessHost } from '@agimon-ai/doompi-core/main';
import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerBundleEntry,
  type DoomServerHostService,
} from '@agimon-ai/doompi-core/server-facet';
import { DOOM_VOICE_AUTO_MODE_ID } from '@agimon-ai/doompi-core/voice-tools';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';

import { facet } from '../../generated/server';

const candidate: DoomServerBundleEntry = {
  packageName: '@agimon-ai/doompi-user-feedback',
  entry: './server.ts',
  module: './server.mjs',
  scopes: ['session'],
  required: true,
  owners: [{ majorMode: 'test', layer: 'default' }],
};

const questions = {
  questions: [
    {
      header: 'Proceed',
      question: 'Continue?',
      options: [
        { label: 'Continue', description: 'Proceed' },
        { label: 'Stop', description: 'Stop here' },
      ],
      multiSelect: false,
    },
  ],
};

describe('headless autonomous Voice question gate', () => {
  it.each([{ modes: [] }, { modes: ['workflow'] }, { modes: ['workflow', 'plan', 'computer-use', 'author'] }])(
    'keeps questions available outside autonomous Voice ($modes)',
    async ({ modes }) => {
      const root = new Context();
      const request = vi.fn(async () => 'Continue');
      let tools: readonly DoomHeadlessTool[] = [];
      const host = new HeadlessHost(root, {
        candidates: [candidate],
        selection: { majorMode: 'test', activeLayers: [], domains: [], state: { 'minor-mode': modes } },
        context: (selection) =>
          ({
            cwd: process.cwd(),
            repoRoot: process.cwd(),
            sessionId: 'question-gate',
            environment: {},
            selection,
            client: { request, notify: vi.fn(), setStatus: vi.fn() },
            session: { entries: () => [], appendCustomEntry: vi.fn() },
            shutdown: vi.fn(),
          }) as unknown as DoomHeadlessExecutionContext,
        applyTools: (next) => {
          tools = next;
        },
        applyResources: () => undefined,
      });
      root.provide(DOOM_SERVER_HOST_SERVICE, {
        scope: 'session',
        context: {},
        registerApi: () => ({ dispose() {} }),
        registerChannel: () => ({ dispose() {} }),
      } as unknown as DoomServerHostService);
      const release = await facet.apply(root.extend({ [DOOM_HEADLESS_OWNER]: candidate }));
      host.setAvailableSources([candidate.packageName]);
      try {
        await host.select({});
        const question = tools.find(({ name }) => name === 'ask_user_question')!;
        expect(question).toBeDefined();
        await host.changeSelection({ axis: 'state', key: 'minor-mode', values: [...modes, DOOM_VOICE_AUTO_MODE_ID] });
        expect(tools.map(({ name }) => name)).not.toContain('ask_user_question');
        expect(
          host
            .getContextInventory()
            .sources.flatMap(({ tools }) => tools)
            .find(({ name }) => name === 'ask_user_question')?.active,
        ).toBe(false);
        await expect(question.execute('stale', questions, undefined, undefined, host.context)).rejects.toThrow(
          'no longer active',
        );
        expect(request).not.toHaveBeenCalled();
        await host.changeSelection({ axis: 'state', key: 'minor-mode', values: modes });
        const restored = tools.find(({ name }) => name === 'ask_user_question')!;
        expect(restored).toBeDefined();
        await restored.execute('restored', questions, undefined, undefined, host.context);
        expect(request).toHaveBeenCalled();
      } finally {
        await host.close();
        await release?.();
        await root.fiber.dispose();
      }
    },
  );
});
