/**
 * Plan mode's slice of the `SPC e c` config panel.
 *
 * Plan mode reads `modes.planning` from disk on every activation, so an edit
 * here lands on the next time the mode is turned on with no restart and nothing
 * to invalidate.
 *
 * The descriptor table is the whole design: the panel renders it and the write
 * handler looks the key path back up in it, so adding a setting means adding a
 * row rather than a case.
 */

import {
  CONFIG_ACTION,
  type ConfigChoice,
  type ConfigField,
  type ConfigSection,
} from '@agimon-ai/doompi-extension-contracts/config';
import type { PlanningModeConfig } from './config.ts';
import { PLAN_CONFIG_SECTION_ID, PLAN_SETTING_SHAPES, type PlanSettingShape } from '../../types/planSettings.ts';

export { PLAN_CONFIG_SECTION_ID };
const SECTION_ORDER = 30;
/** Selecting this clears the setting, which is how the file spells "inherit". */
const INHERIT_CHOICE_ID = 'inherit';

/**
 * A planning setting as the terminal panel needs it: the shared shape, plus how
 * to read the value out of a loaded config. The reader stays here because it
 * touches the parsed config types, which the browser half never sees.
 */
export interface PlanSettingDescriptor extends PlanSettingShape {
  readonly read: (config: PlanningModeConfig | undefined) => string | undefined;
}

const READERS: Readonly<Record<string, (config: PlanningModeConfig | undefined) => string | undefined>> = {
  'main.model': (config) => config?.main?.model,
  'main.thinking': (config) => config?.main?.thinking,
  'subagents.model': (config) => config?.subagents?.model,
  'subagents.thinking': (config) => config?.subagents?.thinking,
  plansdirectory: (config) => config?.plansDirectory,
};

export const PLAN_SETTINGS: readonly PlanSettingDescriptor[] = PLAN_SETTING_SHAPES.map((shape) => ({
  ...shape,
  read: READERS[shape.id]!,
}));

export function planSettingByFieldId(fieldId: string): PlanSettingDescriptor | undefined {
  return PLAN_SETTINGS.find((setting) => setting.id === fieldId);
}

/** A model this session could actually switch to, as the panel offers it. */
export interface PlanModelChoice {
  readonly provider: string;
  readonly id: string;
}

/**
 * The models the session can reach, plus the entry that clears the setting.
 *
 * Offered as a list because a model spec is `provider/id` and typing one from
 * memory is how a setting ends up naming a model this session cannot use. The
 * inherit entry CLEARS rather than writing a value: unset is what "use the
 * session's own model" means in the file.
 */
function modelChoices(models: readonly PlanModelChoice[]): ConfigChoice[] {
  const inherit: ConfigChoice = {
    id: INHERIT_CHOICE_ID,
    label: PLAN_SETTING_SHAPES.find((shape) => shape.models === true)?.placeholder ?? INHERIT_CHOICE_ID,
    detail: 'Leaves the setting unset.',
    action: CONFIG_ACTION.clear,
  };
  return [
    inherit,
    ...models.map((model): ConfigChoice => ({
      id: `${model.provider}/${model.id}`,
      label: model.id,
      group: model.provider,
      detail: model.provider,
      action: CONFIG_ACTION.set,
    })),
  ];
}

function choicesFor(
  setting: PlanSettingDescriptor,
  models: readonly PlanModelChoice[],
): { choices: ConfigChoice[]; kind: 'enum' | 'choice' } | undefined {
  // `set` rather than a bespoke action: choosing a level is the same write as
  // typing one, so it shares the handler.
  if (setting.options) {
    return {
      kind: 'enum',
      choices: setting.options.map((option) => ({ id: option, label: option, action: CONFIG_ACTION.set })),
    };
  }
  // A model setting with nothing to offer stays free text rather than opening
  // an empty list: a session with no authenticated provider can still be edited.
  if (!setting.models || models.length === 0) return undefined;
  return { kind: 'choice', choices: modelChoices(models) };
}

export function planConfigSections(
  config: PlanningModeConfig | undefined,
  notice?: string,
  models: readonly PlanModelChoice[] = [],
): readonly ConfigSection[] {
  const fields: ConfigField[] = PLAN_SETTINGS.map((setting) => {
    const value = setting.read(config);
    const offered = choicesFor(setting, models);
    return {
      id: setting.id,
      label: setting.label,
      kind: offered?.kind ?? ('text' as const),
      keyPath: setting.keyPath.join('.'),
      placeholder: setting.placeholder,
      detail: setting.detail,
      ...(value ? { value } : {}),
      ...(offered ? { choices: offered.choices } : {}),
    };
  });
  return [
    {
      id: PLAN_CONFIG_SECTION_ID,
      title: 'planning',
      order: SECTION_ORDER,
      detail: 'plan mode',
      fields,
      ...(notice ? { notice, noticeLevel: 'error' as const } : {}),
    },
  ];
}
