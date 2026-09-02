/**
 * The autocompact settings, described once for both surfaces.
 *
 * The cockpit's settings page renders these, and the runtime reads the same key
 * paths out of `.doom/config.yaml`, so the ids, labels and key paths live here
 * rather than in either place.
 *
 * It lives under src/types because that is the one server root a browser bundle
 * may read, which also means it may import nothing outside this directory:
 * pulling the config package in for the thinking levels would drag a node
 * module into the page. They are spelled out instead, and a test asserts they
 * still match the parser's.
 */

import { COMPACTION_THRESHOLDS } from './constants.ts';

export const AUTOCOMPACT_CONFIG_SECTION_ID = 'autocompact';
const AUTOCOMPACT_PATH = ['modes', AUTOCOMPACT_CONFIG_SECTION_ID] as const;
const THRESHOLDS_KEY = 'thresholds';

/** Unset means the session's own model and thinking level do the summarizing. */
const INHERIT_MODEL = 'inherit the session model';
const INHERIT_THINKING = 'inherit';

/** Mirrors DOOM_PLANNING_THINKING_LEVELS; pinned by this package's config test. */
export const AUTOCOMPACT_THINKING_LEVELS: readonly string[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** The parser accepts a real boolean too; the page can only write strings. */
export const AUTOCOMPACT_ENABLED_VALUES: readonly string[] = ['true', 'false'];

export interface AutocompactSettingShape {
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

export const AUTOCOMPACT_SETTING_SHAPES: readonly AutocompactSettingShape[] = [
  {
    id: 'enabled',
    label: 'enabled',
    keyPath: [...AUTOCOMPACT_PATH, 'enabled'],
    placeholder: 'on',
    detail: 'off leaves compaction to Pi. unset is on.',
    options: AUTOCOMPACT_ENABLED_VALUES,
  },
  {
    id: 'model',
    label: 'summarization model',
    keyPath: [...AUTOCOMPACT_PATH, 'model'],
    placeholder: INHERIT_MODEL,
    detail: 'model that writes the checkpoint summaries.',
    models: true,
  },
  {
    id: 'thinking',
    label: 'summarization thinking',
    keyPath: [...AUTOCOMPACT_PATH, 'thinking'],
    placeholder: INHERIT_THINKING,
    detail: 'thinking level appended to the summarization model.',
    options: AUTOCOMPACT_THINKING_LEVELS,
  },
  {
    id: 'thresholds.pass1',
    label: 'pass 1 threshold',
    keyPath: [...AUTOCOMPACT_PATH, THRESHOLDS_KEY, 'pass1'],
    placeholder: String(COMPACTION_THRESHOLDS[1].ratio),
    detail: 'fraction of the remaining context window at which the first pass fires.',
  },
  {
    id: 'thresholds.pass2',
    label: 'pass 2 threshold',
    keyPath: [...AUTOCOMPACT_PATH, THRESHOLDS_KEY, 'pass2'],
    placeholder: String(COMPACTION_THRESHOLDS[2].ratio),
    detail: 'second pass. a value below pass 1 is raised back to it.',
  },
  {
    id: 'thresholds.pass3',
    label: 'pass 3 threshold',
    keyPath: [...AUTOCOMPACT_PATH, THRESHOLDS_KEY, 'pass3'],
    placeholder: String(COMPACTION_THRESHOLDS[3].ratio),
    detail: 'last pass before Pi compacts natively. a value below pass 2 is raised back to it.',
  },
];
