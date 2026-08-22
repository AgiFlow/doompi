/**
 * Team package configuration schema tests.
 *
 * DESIGN PATTERNS:
 * - Exercise Team-owned validation independently from generic modes.yaml parsing.
 * - Pin ordered merge semantics for models and excluded tools.
 *
 * AVOID:
 * - Reintroducing the removed layer-level config wrapper in fixtures.
 */

import { describe, expect, it } from 'vitest';
import { mergeTeamPackageConfigurations, parseTeamPackageConfig } from '../../src/schemas/team/packageConfig';

const LOCATION = 'Package "@agimon-ai/doompi-team" config in layer "team" of .doom/modes.yaml';

describe('Team package configuration', () => {
  it('normalizes models and deduplicates excluded tools', () => {
    expect(
      parseTeamPackageConfig(
        {
          models: [
            { model: ' openai/primary ', thinking: 'high' },
            { model: 'openai/fallback', thinking: 'low' },
          ],
          excludeTools: [' tool-a ', 'tool-a', 'tool-b'],
        },
        LOCATION,
      ),
    ).toEqual({
      models: [
        { model: 'openai/primary', thinking: 'high' },
        { model: 'openai/fallback', thinking: 'low' },
      ],
      excludeTools: ['tool-a', 'tool-b'],
    });
  });

  it.each([
    ['non-mapping config', 'invalid', 'must be a mapping'],
    ['unknown field', { typo: true }, 'has unsupported field(s): typo'],
    ['empty config', {}, 'must define models or excludeTools'],
    ['empty models', { models: [] }, '.models must be a non-empty array'],
    ['non-mapping model', { models: ['model'] }, '.models[0] must be a mapping'],
    ['unknown model field', { models: [{ model: 'openai/model', typo: true }] }, 'unsupported field(s): typo'],
    ['blank model', { models: [{ model: ' ' }] }, '.models[0].model must be a non-empty string'],
    [
      'invalid thinking level',
      { models: [{ model: 'openai/model', thinking: 'extreme' }] },
      '.models[0].thinking must be one of',
    ],
    ['invalid excluded tools', { excludeTools: 'tool' }, '.excludeTools must be a non-empty array'],
    ['empty excluded tools', { excludeTools: [] }, '.excludeTools must be a non-empty array'],
    ['blank excluded tool', { excludeTools: [' '] }, '.excludeTools[0] must be a non-empty string'],
    ['non-string excluded tool', { excludeTools: [false] }, '.excludeTools[0] must be a non-empty string'],
  ])('rejects %s', (_name, value, message) => {
    expect(() => parseTeamPackageConfig(value, LOCATION)).toThrow(message);
  });

  it('lets later layers replace models while unioning exclusions', () => {
    expect(
      mergeTeamPackageConfigurations([
        {
          layer: 'team',
          specifier: '@agimon-ai/doompi-team',
          config: {
            models: [{ model: 'openai/primary', thinking: 'high' }],
            excludeTools: ['tool-a', 'tool-b'],
          },
          baseDirectory: '/workspace',
        },
        {
          layer: 'restrictions',
          specifier: '@agimon-ai/doompi-team/extensions/pi',
          config: { excludeTools: ['tool-b', 'tool-c'] },
          baseDirectory: '/workspace',
        },
        {
          layer: 'economy',
          specifier: '@agimon-ai/doompi-team',
          config: { models: [{ model: 'openai/economy', thinking: 'minimal' }] },
          baseDirectory: '/workspace',
        },
      ]),
    ).toEqual({
      models: [{ model: 'openai/economy', thinking: 'minimal' }],
      excludeTools: ['tool-a', 'tool-b', 'tool-c'],
    });
  });

  it('returns no policy when no selected Team package owns config', () => {
    expect(mergeTeamPackageConfigurations([])).toBeUndefined();
  });
});
