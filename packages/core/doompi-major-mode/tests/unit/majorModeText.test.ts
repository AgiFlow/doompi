import type { MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { describe, expect, it } from 'vitest';
import {
  applySummary,
  errorMessage,
  majorModeItems,
  majorModeOptionLabel,
  majorModeSummary,
  optionName,
  voiceSwitchToken,
} from '../../src/services/majorModeText.ts';

const config: MajorModesConfig = {
  defaultMajorMode: 'copilot',
  layers: { team: { baseDirectory: '/repo' }, plan: { baseDirectory: '/repo' } },
  majorMode: {
    minimal: { description: 'Lean mode.', layers: ['team'] },
    copilot: { description: 'Full mode.', layers: ['team', 'plan'] },
  },
};

describe('major mode picker text', () => {
  it('lists modes with their description, falling back for an undescribed one', () => {
    expect(majorModeItems(config, ['minimal', 'ghost'])).toEqual([
      { value: 'minimal', label: 'minimal', description: 'Lean mode.' },
      { value: 'ghost', label: 'ghost', description: 'core only' },
    ]);
  });

  it('marks only the current mode and lists its layers', () => {
    expect(majorModeOptionLabel('copilot', ['team', 'plan'], 'copilot')).toBe('[x] copilot: team, plan');
    expect(majorModeOptionLabel('minimal', ['team'], 'copilot')).toBe('[ ] minimal: team');
    expect(majorModeOptionLabel('bare', [], 'copilot')).toBe('[ ] bare: core only');
  });

  it('recovers the bare mode name from a rendered option', () => {
    expect(optionName('[x] copilot: team, plan')).toBe('copilot');
    expect(optionName('copilot')).toBe('copilot');
  });
});

describe('switch summaries', () => {
  it('tells a launcher session it must relaunch, and a synced one that it reloaded', () => {
    expect(applySummary('copilot', ['team'], true, false, 'process-relaunch')).toContain('is pending');
    expect(applySummary('copilot', ['team'], true, false, 'process-relaunch')).toContain('remains active');
    expect(applySummary('copilot', ['team'], true, false, 'process-relaunch', true)).toContain(
      'the supervisor is restarting the agent',
    );
    expect(applySummary('copilot', ['team'], false, true, 'pi-reload')).toContain('Pi reloaded.');
    expect(applySummary('copilot', ['team'], false, false)).toContain('Hooks reloaded.');
    // Stale on a launcher session: hooks change in place, extensions cannot.
    expect(applySummary('copilot', ['team'], true, false)).toContain('Extensions are fixed at launch');
  });

  it('distinguishes an already-active mode from one that needs a relaunch', () => {
    expect(majorModeSummary('copilot', ['team'], 'copilot')).toContain('Already using this major mode.');
    expect(majorModeSummary('bare', [], 'bare')).toContain('Major mode bare: core only');
    expect(majorModeSummary('minimal', ['team'], 'copilot', false)).toContain('Relaunch with:');
    expect(majorModeSummary('minimal', ['team'], 'copilot', true)).not.toContain('Relaunch with:');
  });
});

describe('voice switch token', () => {
  it('accepts the token only as the sole argument', () => {
    expect(voiceSwitchToken('--voice-switch-token=abc123')).toBe('abc123');
    expect(voiceSwitchToken('')).toBeUndefined();
    expect(voiceSwitchToken('  ')).toBeUndefined();
    expect(() => voiceSwitchToken('--voice-switch-token=abc extra')).toThrow('only command argument');
    expect(() => voiceSwitchToken('--voice-switch-token=')).toThrow('is missing');
  });

  it('renders any thrown value as a message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
  });
});
