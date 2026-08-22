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

import { DOOM_PLANNING_THINKING_LEVELS } from '@agimon-ai/doompi-config';
import {
  CONFIG_ACTION,
  type ConfigChoice,
  type ConfigField,
  type ConfigSection,
} from '@agimon-ai/doompi-extension-contracts/config';
import type { PlanningModeConfig } from './config.ts';

export const PLAN_CONFIG_SECTION_ID = 'planning';
const SECTION_ORDER = 30;
const PLANNING_PATH = ['modes', PLAN_CONFIG_SECTION_ID] as const;
const MAIN_KEY = 'main';
const SUBAGENTS_KEY = 'subagents';
/** Both agents fall back to the session's own settings when left unset. */
const INHERIT_MODEL = 'inherit the session model';
const INHERIT_THINKING = 'inherit';
/** Selecting this clears the setting, which is how the file spells "inherit". */
const INHERIT_CHOICE_ID = 'inherit';

interface PlanSettingDescriptor {
  readonly id: string;
  readonly label: string;
  readonly keyPath: readonly string[];
  readonly placeholder: string;
  readonly detail: string;
  /** Present for a closed set; the panel offers these rather than free text. */
  readonly options?: readonly string[];
  /** Offers the session's own models rather than free text. See `planConfigSections`. */
  readonly models?: boolean;
  readonly read: (config: PlanningModeConfig | undefined) => string | undefined;
}

export const PLAN_SETTINGS: readonly PlanSettingDescriptor[] = [
  {
    id: 'main.model',
    label: 'main model',
    keyPath: [...PLANNING_PATH, MAIN_KEY, 'model'],
    placeholder: INHERIT_MODEL,
    detail: 'Model the main agent switches to while plan mode is on.',
    models: true,
    read: (config) => config?.main?.model,
  },
  {
    id: 'main.thinking',
    label: 'main thinking',
    keyPath: [...PLANNING_PATH, MAIN_KEY, 'thinking'],
    placeholder: INHERIT_THINKING,
    detail: 'Thinking level appended to the main model while planning.',
    options: DOOM_PLANNING_THINKING_LEVELS,
    read: (config) => config?.main?.thinking,
  },
  {
    id: 'subagents.model',
    label: 'subagent model',
    keyPath: [...PLANNING_PATH, SUBAGENTS_KEY, 'model'],
    placeholder: INHERIT_MODEL,
    detail: 'Model forced onto delegated planning subagents.',
    models: true,
    read: (config) => config?.subagents?.model,
  },
  {
    id: 'subagents.thinking',
    label: 'subagent thinking',
    keyPath: [...PLANNING_PATH, SUBAGENTS_KEY, 'thinking'],
    placeholder: INHERIT_THINKING,
    detail: 'Thinking level appended to the subagent model.',
    options: DOOM_PLANNING_THINKING_LEVELS,
    read: (config) => config?.subagents?.thinking,
  },
  {
    id: 'plansdirectory',
    label: 'plans directory',
    keyPath: [...PLANNING_PATH, 'plansDirectory'],
    placeholder: '~/.pi/plans',
    detail: 'Absolute, repo-relative, or under ~. Written plans land here.',
    read: (config) => config?.plansDirectory,
  },
];

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
    label: INHERIT_MODEL,
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
