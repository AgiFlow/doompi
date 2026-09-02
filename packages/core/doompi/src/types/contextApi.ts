import type { ContextItemSource } from '../services/contextProjection.ts';

/**
 * What one entry in the composition actually is, for a reader who clicked it.
 *
 * The projection prices the composition and stops there: names, owners, and
 * integer counts, small enough to republish whenever the composition changes.
 * The prose and the schema behind a figure are an order of magnitude larger and
 * are wanted one row at a time, so they travel on request instead. This module
 * is the contract both ends of that request share, and it is deliberately free
 * of Node imports so a browser can hold it too.
 */

/** Where a host mounts this package's API; the segment after /api/plugin/. */
export const API_BASE_PATH = 'context';

/** The session a proxied request belongs to; the hub strips it before forwarding. */
export const SESSION_QUERY_PARAM = 'session';

export const ITEM_ROUTE = '/item';
export const NAME_QUERY_PARAM = 'name';
export const KIND_QUERY_PARAM = 'kind';

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
  readonly filePath: string;
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

export const CONTEXT_DETAIL_VERSION = 1;

/** The absolute URL a page reads one row's detail through. */
export function itemDetailUrl(sessionId: string, itemKind: ContextItemKind, name: string): string {
  const search = new URLSearchParams({
    [SESSION_QUERY_PARAM]: sessionId,
    [KIND_QUERY_PARAM]: itemKind,
    [NAME_QUERY_PARAM]: name,
  });
  return `/api/plugin/${API_BASE_PATH}${ITEM_ROUTE}?${search.toString()}`;
}
