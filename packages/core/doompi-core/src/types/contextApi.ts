import type { ContextItemSource } from '../services/contextProjection';

export type ContextItemKind = 'tool' | 'skill' | 'prompt';

/**
 * Whether the prompt on offer is the one a turn actually sent.
 *
 * A session that has sent nothing has built no prompt yet, and building one to
 * look at it would fire `before_agent_start` on every package that hooks it.
 * `base` is the hook-free assembly shown instead; `effective` is what a turn
 * really handed the model.
 */
export type ContextPromptStage = 'base' | 'effective';

/** What a tool costs, split the way it is actually paid. */
export interface ContextTokenBreakdown {
  /** The JSON schema in the tool list. */
  readonly schemaTokens: number;
  /** The prose Pi folds into the system prompt. */
  readonly promptTokens: number;
  readonly totalTokens: number;
}

export interface ContextToolDetail {
  readonly itemKind: 'tool';
  readonly name: string;
  readonly owner: string;
  readonly source: ContextItemSource;
  readonly active: boolean;
  readonly tokens: ContextTokenBreakdown;
  readonly description?: string;
  /** The one-line snippet Pi keys by tool name in the system prompt. */
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  /** The parameter schema as the model receives it. */
  readonly parameters?: unknown;
}

export interface ContextSkillDetail {
  readonly itemKind: 'skill';
  readonly name: string;
  readonly owner: string;
  readonly source: ContextItemSource;
  readonly active: true;
  /** A skill has no schema half, so the figure is the prompt cost alone. */
  readonly tokens: number;
  readonly description: string;
  readonly filePath?: string;
  /** Whether the model may invoke it, as opposed to a human running it. */
  readonly modelInvocable: boolean;
}

/**
 * The assembled system prompt, as one addressable row.
 *
 * It carries no owner or source: every mode, package and profile in the
 * composition contributes to it, and the text arrives as one blob with no
 * seam to attribute slices along.
 */
export interface ContextPromptDetail {
  readonly itemKind: 'prompt';
  readonly name: 'system';
  readonly tokens: number;
  readonly stage: ContextPromptStage;
  readonly text: string;
}

export type ContextItemDetail = ContextToolDetail | ContextSkillDetail | ContextPromptDetail;

/** The file the agent writes and the session API reads back. */
export interface ContextDetailFile {
  readonly version: 1;
  /** Matches the projection revision the panel is rendering. */
  readonly revision: number;
  readonly items: readonly ContextItemDetail[];
}
