import { DOOM_PLANNING_THINKING_LEVELS, parseAutocompactModeConfig } from '@agimon-ai/doompi-config';
import { describe, expect, it } from 'vitest';
import {
  AUTOCOMPACT_CONFIG_SECTION_ID,
  AUTOCOMPACT_SETTING_SHAPES,
  AUTOCOMPACT_THINKING_LEVELS,
} from '../src/types/autocompactSettings.ts';
import { autocompactSettingsSection } from '../src/web/autocompactSettings.ts';
import { webPlugin } from '../src/web/index.ts';

/** The value a settings field of this shape would send, in the string form the page writes. */
function sampleValue(id: string): string {
  if (id === 'enabled') return 'false';
  if (id === 'model') return 'openai/gpt-5';
  if (id === 'thinking') return 'low';
  return '0.6';
}

describe('autocompact settings', () => {
  it('offers exactly the thinking levels the config parser accepts', () => {
    expect(AUTOCOMPACT_THINKING_LEVELS).toEqual([...DOOM_PLANNING_THINKING_LEVELS]);
  });

  it('writes key paths the config parser accepts, in the page string form', () => {
    const document: Record<string, unknown> = {};
    for (const shape of AUTOCOMPACT_SETTING_SHAPES) {
      expect(shape.keyPath.slice(0, 2)).toEqual(['modes', AUTOCOMPACT_CONFIG_SECTION_ID]);
      const leaf = shape.keyPath.slice(2);
      let cursor = document;
      for (const segment of leaf.slice(0, -1)) {
        cursor[segment] ??= {};
        cursor = cursor[segment] as Record<string, unknown>;
      }
      cursor[leaf.at(-1)!] = sampleValue(shape.id);
    }

    expect(parseAutocompactModeConfig(document, '/config.yaml')).toEqual({
      enabled: false,
      model: 'openai/gpt-5',
      thinking: 'low',
      thresholds: { pass1: 0.6, pass2: 0.6, pass3: 0.6 },
    });
  });

  it('contributes one settings page and nothing else to the cockpit', () => {
    expect(webPlugin.id).toBe('autocompact');
    expect(webPlugin.settingsSections).toEqual([autocompactSettingsSection]);

    const byId = new Map(autocompactSettingsSection.fields.map((field) => [field.id, field]));
    expect(byId.get('model')).toMatchObject({ kind: 'select', optionsFrom: 'models' });
    expect(byId.get('thinking')?.options?.map((option) => option.value)).toEqual([...AUTOCOMPACT_THINKING_LEVELS]);
    expect(byId.get('thresholds.pass1')).toMatchObject({ kind: 'text' });
  });
});
