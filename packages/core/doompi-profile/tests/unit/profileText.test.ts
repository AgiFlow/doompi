import type { AgentProfile } from '@agimon-ai/doompi-config/profiles';
import { describe, expect, it } from 'vitest';
import {
  PROFILE_STATUS_KEY,
  profileDescription,
  profileItems,
  profileStatus,
  profileSummary,
  profileTitle,
} from '../../src/services/profileText.ts';

const marketing: AgentProfile = {
  name: 'marketing-agiflow',
  persona: 'agents/agiflow/mara-voss',
  personaRoot: '/repo',
  env: { BRAND: 'agiflow' },
};

const product: AgentProfile = {
  name: 'product-agiflow',
  persona: 'agents/agiflow/vuong-ngo',
  personaRoot: '/repo',
  env: {},
};

describe('profile picker text', () => {
  it('describes the persona and its environment keys', () => {
    expect(profileItems([marketing, product])).toEqual([
      {
        value: 'marketing-agiflow',
        label: 'marketing-agiflow',
        description: 'agents/agiflow/mara-voss (env: BRAND)',
      },
      {
        value: 'product-agiflow',
        label: 'product-agiflow',
        description: 'agents/agiflow/vuong-ngo',
      },
    ]);
    expect(profileDescription(product)).toBe('agents/agiflow/vuong-ngo');
  });

  it('summarizes an already loaded profile', () => {
    const summary = profileSummary(marketing);
    expect(summary).toContain('Persona: agents/agiflow/mara-voss');
    expect(summary).toContain('Env: BRAND');
    expect(summary).toContain('Already loaded.');
    expect(profileSummary(product)).toContain('Env: (none)');
  });

  it('names the current profile in the picker title', () => {
    expect(profileTitle('marketing-agiflow')).toBe('Profile (current: marketing-agiflow)');
    expect(profileTitle(undefined)).toBe('Profile (current: (none))');
  });
});

describe('profile axis status', () => {
  it('publishes the active profile name, even when its catalogue is gone', () => {
    expect(profileStatus('marketing-agiflow', true)).toBe('marketing-agiflow');
    expect(profileStatus('marketing-agiflow', false)).toBe('marketing-agiflow');
  });

  it('publishes empty while profiles exist with none active', () => {
    expect(profileStatus(undefined, true)).toBe('');
  });

  it('withholds the status when there is nothing to select', () => {
    expect(profileStatus(undefined, false)).toBeUndefined();
    expect(profileStatus('', false)).toBeUndefined();
    expect(PROFILE_STATUS_KEY).toBe('doom-profile');
  });
});
