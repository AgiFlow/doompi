import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readDoomHarnessMetadata } from '../src/exports/harnessMetadata.ts';

describe('readDoomHarnessMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses the display fields from a harness environment', () => {
    expect(
      readDoomHarnessMetadata({
        DOOMPI_ROOT: '/repo/agirepo',
        DOOMPI_MAJOR_MODE: 'dev',
        DOOMPI_DOMAINS: 'development, qa',
        DOOMPI_LAYERS: 'guardrails, vibe-lint',
        DOOMPI_PROFILE: 'product-agiflow',
      }),
    ).toEqual({
      root: '/repo/agirepo',
      majorMode: 'dev',
      domains: ['development', 'qa'],
      layers: ['guardrails', 'vibe-lint'],
      profile: 'product-agiflow',
    });
  });

  it('uses safe display defaults for an unmanaged Pi session', () => {
    expect(readDoomHarnessMetadata({})).toEqual({
      root: undefined,
      majorMode: 'copilot',
      domains: [],
      layers: [],
      profile: undefined,
    });
  });
});
