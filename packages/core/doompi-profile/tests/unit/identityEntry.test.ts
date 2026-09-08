import { DOOM_PROFILE_IDENTITY_ENTRY_TYPE } from '@agimon-ai/doompi-extension-contracts/profile-identity';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { publishProfileIdentity } from '../../src/adapters/pi/identityEntry.ts';

function host() {
  const appendEntry = vi.fn();
  return { pi: { appendEntry } as unknown as Pick<ExtensionAPI, 'appendEntry'>, appendEntry };
}

describe('publishProfileIdentity', () => {
  it('journals the persona under the transcript entry type', () => {
    const { pi, appendEntry } = host();

    const published = publishProfileIdentity(
      pi,
      'rhea',
      { name: 'Rhea', icon: 'data:image/png;base64,AAAA' },
      undefined,
    );

    expect(appendEntry).toHaveBeenCalledWith(DOOM_PROFILE_IDENTITY_ENTRY_TYPE, {
      profile: 'rhea',
      name: 'Rhea',
      icon: 'data:image/png;base64,AAAA',
    });
    expect(published).toContain('rhea');
  });

  it('publishes a bare profile that declares no identity', () => {
    const { pi, appendEntry } = host();

    publishProfileIdentity(pi, 'writer', undefined, undefined);

    expect(appendEntry).toHaveBeenCalledWith(DOOM_PROFILE_IDENTITY_ENTRY_TYPE, { profile: 'writer' });
  });

  it('says nothing when no profile is active', () => {
    const { pi, appendEntry } = host();

    expect(publishProfileIdentity(pi, undefined, { name: 'Rhea' }, undefined)).toBeUndefined();
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it('adds no seam when the identity is unchanged across a reload', () => {
    const { pi, appendEntry } = host();

    const first = publishProfileIdentity(pi, 'rhea', { name: 'Rhea' }, undefined);
    const second = publishProfileIdentity(pi, 'rhea', { name: 'Rhea' }, first);

    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('journals again when the persona actually changes', () => {
    const { pi, appendEntry } = host();

    const first = publishProfileIdentity(pi, 'rhea', { name: 'Rhea' }, undefined);
    publishProfileIdentity(pi, 'writer', undefined, first);

    expect(appendEntry).toHaveBeenCalledTimes(2);
    expect(appendEntry).toHaveBeenLastCalledWith(DOOM_PROFILE_IDENTITY_ENTRY_TYPE, { profile: 'writer' });
  });
});
