import { DOOM_PLANNING_THINKING_LEVELS } from '@agimon-ai/doompi-config';
import { describe, expect, it } from 'vitest';
import { PLAN_SETTINGS, planConfigSections, planSettingByFieldId } from '../src/exports/planConfig';

describe('planConfigSections', () => {
  it('renders one section holding every planning setting', () => {
    const [section] = planConfigSections(undefined);
    expect(section?.id).toBe('planning');
    expect(section?.fields.map((field) => field.id)).toEqual([
      'main.model',
      'main.thinking',
      'subagents.model',
      'subagents.thinking',
      'plansdirectory',
    ]);
    // Nothing configured, so every field falls back to its placeholder.
    expect(section?.fields.every((field) => field.value === undefined)).toBe(true);
  });

  it('reads configured values onto their fields', () => {
    const [section] = planConfigSections({
      main: { model: 'anthropic/claude', thinking: 'high' },
      subagents: { model: 'anthropic/haiku' },
      plansDirectory: '~/plans',
    });
    const byId = new Map(section?.fields.map((field) => [field.id, field.value]));
    expect(byId.get('main.model')).toBe('anthropic/claude');
    expect(byId.get('main.thinking')).toBe('high');
    expect(byId.get('subagents.model')).toBe('anthropic/haiku');
    expect(byId.get('subagents.thinking')).toBeUndefined();
    expect(byId.get('plansdirectory')).toBe('~/plans');
  });

  it('offers exactly the thinking levels the parser accepts', () => {
    const [section] = planConfigSections(undefined);
    const thinking = section?.fields.find((field) => field.id === 'main.thinking');
    expect(thinking?.kind).toBe('enum');
    // Drift guard: a level added to the parser must appear here without an edit.
    expect(thinking?.choices?.map((choice) => choice.id)).toEqual([...DOOM_PLANNING_THINKING_LEVELS]);
    expect(thinking?.choices?.every((choice) => choice.action === 'set')).toBe(true);
  });

  it('offers the session models for a model setting, with an entry that clears it', () => {
    const [section] = planConfigSections(undefined, undefined, [
      { provider: 'openai-codex', id: 'gpt-5.6-luna' },
      { provider: 'anthropic', id: 'claude-opus-5' },
    ]);
    const main = section?.fields.find((field) => field.id === 'main.model');

    expect(main?.kind).toBe('choice');
    expect(main?.choices?.map((choice) => choice.id)).toEqual([
      'inherit',
      'openai-codex/gpt-5.6-luna',
      'anthropic/claude-opus-5',
    ]);
    // Inheriting is an absent key, so its entry clears rather than writing.
    expect(main?.choices?.[0]).toMatchObject({ action: 'clear' });
    expect(main?.choices?.[1]).toMatchObject({ action: 'set', group: 'openai-codex' });
    expect(section?.fields.find((field) => field.id === 'subagents.model')?.kind).toBe('choice');
  });

  it('leaves a model setting as free text when the session offers no models', () => {
    const [section] = planConfigSections(undefined);

    expect(section?.fields.find((field) => field.id === 'main.model')?.kind).toBe('text');
    expect(section?.fields.find((field) => field.id === 'main.model')?.choices).toBeUndefined();
  });

  it('carries a failure as a section-level error notice', () => {
    const [section] = planConfigSections(undefined, 'read only');
    expect(section?.notice).toBe('read only');
    expect(section?.noticeLevel).toBe('error');
  });

  it('maps every field id back to a key path the config schema accepts', () => {
    for (const setting of PLAN_SETTINGS) {
      expect(planSettingByFieldId(setting.id)).toBe(setting);
      expect(setting.keyPath.slice(0, 2)).toEqual(['modes', 'planning']);
    }
    expect(planSettingByFieldId('nope')).toBeUndefined();
  });
});
