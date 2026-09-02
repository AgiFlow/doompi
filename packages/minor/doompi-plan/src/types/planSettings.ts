/**
 * The planning settings, described once for both surfaces.
 *
 * The terminal panel and the cockpit settings page render the same five fields,
 * and the one thing they must agree on is which config key each one writes. So
 * the ids, labels and key paths live here rather than in either renderer.
 *
 * It lives under src/types because that is the one server root a browser bundle
 * may read, which also means it may import nothing: pulling the config package
 * in for the thinking levels would drag a node module into the page. They are
 * spelled out instead, and a test asserts they still match the parser's.
 */

export const PLAN_CONFIG_SECTION_ID = 'planning';
const PLANNING_PATH = ['modes', PLAN_CONFIG_SECTION_ID] as const;
const MAIN_KEY = 'main';
const SUBAGENTS_KEY = 'subagents';

/** Both agents fall back to the session's own settings when left unset. */
const INHERIT_MODEL = 'inherit the session model';
const INHERIT_THINKING = 'inherit';

/** Mirrors DOOM_PLANNING_THINKING_LEVELS; pinned by planConfig's test. */
export const PLAN_THINKING_LEVELS: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface PlanSettingShape {
  readonly id: string;
  readonly label: string;
  readonly keyPath: readonly string[];
  readonly placeholder: string;
  readonly detail: string;
  /** Present for a closed set; a renderer offers these rather than free text. */
  readonly options?: readonly string[];
  /** Offers the machine's authenticated models rather than free text. */
  readonly models?: boolean;
}

export const PLAN_SETTING_SHAPES: readonly PlanSettingShape[] = [
  {
    id: 'main.model',
    label: 'main model',
    keyPath: [...PLANNING_PATH, MAIN_KEY, 'model'],
    placeholder: INHERIT_MODEL,
    detail: 'model the main agent switches to while plan mode is on.',
    models: true,
  },
  {
    id: 'main.thinking',
    label: 'main thinking',
    keyPath: [...PLANNING_PATH, MAIN_KEY, 'thinking'],
    placeholder: INHERIT_THINKING,
    detail: 'thinking level appended to the main model while planning.',
    options: PLAN_THINKING_LEVELS,
  },
  {
    id: 'subagents.model',
    label: 'subagent model',
    keyPath: [...PLANNING_PATH, SUBAGENTS_KEY, 'model'],
    placeholder: INHERIT_MODEL,
    detail: 'model forced onto delegated planning subagents.',
    models: true,
  },
  {
    id: 'subagents.thinking',
    label: 'subagent thinking',
    keyPath: [...PLANNING_PATH, SUBAGENTS_KEY, 'thinking'],
    placeholder: INHERIT_THINKING,
    detail: 'thinking level appended to the subagent model.',
    options: PLAN_THINKING_LEVELS,
  },
  {
    id: 'plansdirectory',
    label: 'plans directory',
    keyPath: [...PLANNING_PATH, 'plansDirectory'],
    placeholder: '~/.pi/plans',
    detail: 'absolute, repo-relative, or under ~. written plans land here.',
  },
];
