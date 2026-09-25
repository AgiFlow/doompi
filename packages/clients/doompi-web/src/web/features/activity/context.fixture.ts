import { itemDetailUrl, type ContextItemDetail } from '@agimon-ai/doompi-core/contextApi';
import { sessionApiPath } from '@agimon-ai/doompi-core/web';

import { mockStoryRequests, seedStorySession, STORY_SESSION_ID } from '../../components/Story.fixture.tsx';
import type { SessionState } from '../../lib/sessionModel.ts';

export const contextProjection: NonNullable<SessionState['context']> = {
  version: 1,
  revision: 1,
  estimator: 'gpt-tokenizer',
  selection: { majorMode: 'development', domains: ['testing'] },
  totalTokens: 1200,
  inactiveTokens: 300,
  systemPrompt: { stage: 'base', tokens: 2200 },
  groups: [
    {
      id: 'development',
      label: 'development',
      kind: 'major',
      tokens: 1200,
      inactiveTokens: 300,
      items: [
        {
          name: 'read',
          itemKind: 'tool',
          source: 'extension',
          owner: '@agimon-ai/doompi-read',
          tokens: 800,
          active: true,
        },
        {
          name: 'review-component-stories-with-a-long-name',
          itemKind: 'skill',
          source: 'extension',
          owner: '@agimon-ai/doompi-read',
          tokens: 400,
          active: true,
        },
        {
          name: 'optional-tool',
          itemKind: 'tool',
          source: 'extension',
          owner: '@agimon-ai/doompi-read',
          tokens: 300,
          active: false,
        },
      ],
    },
    { id: 'testing', label: 'testing', kind: 'domain', tokens: 0, inactiveTokens: 0, items: [] },
  ],
};

export const contextDetails: readonly ContextItemDetail[] = [
  {
    itemKind: 'tool',
    name: 'read',
    owner: '@agimon-ai/doompi-read',
    source: 'extension',
    active: true,
    tokens: { schemaTokens: 500, promptTokens: 300, totalTokens: 800 },
    description: 'Read a file from the selected workspace. Long files can be read in bounded ranges.',
    promptSnippet: 'Read source before changing a component.',
    promptGuidelines: ['Keep paths relative to the workspace.', 'Read the smallest useful range.'],
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'integer' } },
      required: ['path'],
    },
  },
  {
    itemKind: 'skill',
    name: 'review-component-stories-with-a-long-name',
    owner: '@agimon-ai/doompi-read',
    source: 'extension',
    active: true,
    tokens: 400,
    modelInvocable: true,
    description: 'Review component variants, empty states, keyboard access, and responsive layouts.',
    filePath: 'skills/review-component-stories/skill.md',
  },
  {
    itemKind: 'prompt',
    name: 'system',
    stage: 'base',
    tokens: 2200,
    text: 'Review the requested source and preserve existing behavior.\n\nUse shared design tokens for spacing, typography, and colors. Verify the rendered component before considering a visual change complete.',
  },
];

export function seedContextStory(): void {
  seedStorySession({ context: contextProjection });
  mockStoryRequests(
    Object.fromEntries(
      contextDetails.map((item) => [
        `GET ${itemDetailUrl(sessionApiPath(STORY_SESSION_ID), item.itemKind, item.name)}`,
        { item },
      ]),
    ),
  );
}
