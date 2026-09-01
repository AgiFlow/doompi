import type { SettingsSectionContribution } from '@agimon-ai/doompi-web-contracts';
import { AUTOCOMPACT_CONFIG_SECTION_ID, AUTOCOMPACT_SETTING_SHAPES } from '../src/types/autocompactSettings.ts';

/**
 * The autocompact settings, as the cockpit's settings page renders them.
 *
 * Built from the same descriptor table the runtime resolves against, so the
 * page and the extension cannot disagree about which config key a field writes.
 * The host owns the scope switch and the writes; this only says what the fields
 * are.
 */
export const autocompactSettingsSection: SettingsSectionContribution = {
  id: AUTOCOMPACT_CONFIG_SECTION_ID,
  label: 'autocompact',
  detail: 'the model that writes checkpoint summaries, and when each compaction pass fires',
  order: 40,
  fields: AUTOCOMPACT_SETTING_SHAPES.map((shape) => ({
    id: shape.id,
    label: shape.label,
    // A model field offers the machine's authenticated models, which only the
    // host can enumerate; the rest are a closed set or free text.
    kind: shape.models === true || shape.options !== undefined ? ('select' as const) : ('text' as const),
    keyPath: shape.keyPath,
    detail: shape.detail,
    placeholder: shape.placeholder,
    ...(shape.models === true ? { optionsFrom: 'models' as const } : {}),
    ...(shape.options === undefined
      ? {}
      : { options: shape.options.map((option) => ({ value: option, label: option })) }),
  })),
};
