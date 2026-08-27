import type { SettingsSectionContribution } from '@agimon-ai/doompi-web-contracts';
import { PLAN_CONFIG_SECTION_ID, PLAN_SETTING_SHAPES } from '../src/types/planSettings.ts';

/**
 * The planning settings, as the cockpit's settings page renders them.
 *
 * Built from the same descriptor table the terminal panel uses, so the two
 * surfaces cannot disagree about which config key a field writes. The host owns
 * the scope switch and the writes; this only says what the fields are.
 */
export const planSettingsSection: SettingsSectionContribution = {
  id: PLAN_CONFIG_SECTION_ID,
  label: 'planning',
  detail: 'the models plan mode switches to, and where written plans land',
  order: 30,
  fields: PLAN_SETTING_SHAPES.map((shape) => ({
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
