import type { DoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerDoomConfigHelp } from '../src/adapters/pi/helpContribution.ts';

const helpHandle = vi.hoisted(() => ({ dispose: vi.fn() }));
const register = vi.hoisted(() => vi.fn(() => helpHandle));

describe('Doom Config Help contribution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers one package-qualified runtime configuration Help descriptor', () => {
    const service = { register } as unknown as DoomHelpService;

    expect(registerDoomConfigHelp(service)).toBe(helpHandle);
    expect(register).toHaveBeenCalledWith({
      source: '@agimon-ai/doompi-config',
      moduleUrl: expect.stringMatching(/helpContribution\.ts$/u),
      skills: [
        {
          name: 'doompi-author-config',
          description:
            'Configure DoomPi runtime settings, source precedence, and typed session configuration. Use for config.yaml, the doom/config Cordis service, immutable context snapshots, or shared selection transition state. Do not use for defining modes.yaml, domains.yaml, or profiles.yaml.',
        },
      ],
    });
  });
});
