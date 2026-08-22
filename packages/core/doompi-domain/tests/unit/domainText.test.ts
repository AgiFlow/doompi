import type { DoomTransitionResult } from '@agimon-ai/doompi-extension-contracts/transition';
import { VOICE_TOOL_MAX_DOMAIN_COUNT } from '@agimon-ai/doompi-extension-contracts/voice-tools';
import { describe, expect, it } from 'vitest';
import {
  domainItems,
  domainSummary,
  errorMessage,
  normalizeDomainNames,
  pickerTitle,
  splitDomains,
  switchedSummary,
  transitionError,
  unchangedSummary,
  voiceSwitchToken,
} from '../../src/services/domainText.ts';

const listing = { active: ['default'], effective: ['default'], available: ['default', 'development'] };

describe('splitDomains', () => {
  it('trims and drops the blanks a trailing comma leaves behind', () => {
    expect(splitDomains(' development , qa ,')).toEqual(['development', 'qa']);
    expect(splitDomains('')).toEqual([]);
  });
});

describe('domainItems', () => {
  it('omits the description key entirely when a domain declares none', () => {
    expect(domainItems(['a', 'b'], { a: 'A tools' })).toEqual([
      { value: 'a', label: 'a', description: 'A tools' },
      { value: 'b', label: 'b' },
    ]);
  });

  it('defaults to no descriptions at all', () => {
    expect(domainItems(['a'])).toEqual([{ value: 'a', label: 'a' }]);
  });
});

describe('summaries', () => {
  it('names the active and available sets and how to switch', () => {
    expect(domainSummary(listing)).toBe(
      'Active domains: default\nAvailable domains: default, development\nUse /domains <name[,name...]> to switch.',
    );
  });

  it('reads an empty selection as a state rather than a blank', () => {
    expect(domainSummary({ ...listing, effective: [] })).toContain('Active domains: (none)');
    expect(switchedSummary([])).toBe('Switched domains to: (none)');
    expect(unchangedSummary([])).toBe('Domains already active: (none)');
    expect(pickerTitle({ ...listing, effective: [] })).toBe('Domains (active: (none))');
  });

  it('lists the selection in the picker title and both switch summaries', () => {
    expect(pickerTitle(listing)).toBe('Domains (active: default)');
    expect(switchedSummary(['a', 'b'])).toBe('Switched domains to: a, b');
    expect(unchangedSummary(['a'])).toBe('Domains already active: a');
  });
});

describe('normalizeDomainNames', () => {
  it('deduplicates while keeping first-seen order', () => {
    expect(normalizeDomainNames([' development ', 'qa', 'development'])).toEqual(['development', 'qa']);
  });

  it('rejects anything that could escape a path or an environment variable', () => {
    expect(() => normalizeDomainNames(['../escape'])).toThrow('Invalid domain name: ../escape');
    expect(() => normalizeDomainNames([''])).toThrow('Invalid domain name');
    expect(() => normalizeDomainNames(['a b'])).toThrow('Invalid domain name');
    expect(() => normalizeDomainNames(['x'.repeat(1024)])).toThrow('Invalid domain name');
  });

  it('bounds the selection before any manifest is read', () => {
    const many = Array.from({ length: VOICE_TOOL_MAX_DOMAIN_COUNT + 1 }, (_, index) => `domain-${index}`);
    expect(() => normalizeDomainNames(many)).toThrow(/maximum/u);
  });
});

describe('voiceSwitchToken', () => {
  it('returns undefined for a plain argument, so it stays a domain list', () => {
    expect(voiceSwitchToken('development,qa')).toBeUndefined();
    expect(voiceSwitchToken('  ')).toBeUndefined();
  });

  it('extracts the token when it is the whole argument', () => {
    expect(voiceSwitchToken('  --voice-switch-token=doom-domain-switch:abc ')).toBe('doom-domain-switch:abc');
  });

  it('refuses a token smuggled in beside other arguments', () => {
    expect(() => voiceSwitchToken('--voice-switch-token=abc development')).toThrow('only command argument');
    expect(() => voiceSwitchToken('--voice-switch-token=')).toThrow('token is missing');
  });
});

describe('error rendering', () => {
  it('keeps a thrown non-Error readable', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('boom')).toBe('boom');
  });

  it('names the outcome and the diagnostics behind a refused transition', () => {
    const selection = { domains: ['default'], majorMode: 'copilot', layers: [] };
    const result: DoomTransitionResult = {
      operationId: 'test-operation',
      axis: 'domains',
      disposition: 'reload',
      previous: selection,
      candidate: selection,
      diagnostics: ['transition.rejected.duplicate'],
      reloadHandoffRequired: false,
      externalRelaunchRequired: false,
      outcome: 'rejected',
    };
    expect(transitionError(result).message).toBe('Domain transition was rejected: transition.rejected.duplicate');
  });
});
