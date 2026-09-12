import type { ContextItemSource } from '../services/contextProjection';

export type ContextItemKind = 'tool' | 'skill';

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

export type ContextItemDetail = ContextToolDetail | ContextSkillDetail;

/** The file the agent writes and the session API reads back. */
export interface ContextDetailFile {
  readonly version: 1;
  /** Matches the projection revision the panel is rendering. */
  readonly revision: number;
  readonly items: readonly ContextItemDetail[];
}
