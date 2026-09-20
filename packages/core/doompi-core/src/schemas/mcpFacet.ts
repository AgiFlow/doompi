import type { TSchema } from 'typebox';

import type {
  DoomHeadlessExecutionContext,
  DoomHeadlessSelection,
  DoomHeadlessSelectionChange,
  DoomHeadlessTool,
} from './headless';

/** Repository-scoped instructions and applied selection safe to disclose to a remote MCP client. */
export interface DoomMcpContextSnapshot {
  readonly session: { readonly id: string; readonly revision: number };
  readonly repository: { readonly root: string; readonly cwd: string };
  readonly selection: {
    readonly profile: string | null;
    readonly domains: readonly string[];
    readonly majorMode: string;
    readonly activeLayers: readonly string[];
  };
  readonly instructions: readonly { readonly path: string; readonly content: string }[];
  readonly persona: string | null;
}

/** A lazy Markdown resource available only to remote MCP clients. */
export interface DoomMcpSkill {
  readonly name: string;
  readonly description: string;
  read(context: DoomHeadlessExecutionContext): string | Promise<string>;
}

/** A dedicated remote surface, deliberately separate from local agent registrations. */
export interface DoomMcpSessionPlugin {
  readonly tools?: readonly DoomHeadlessTool<TSchema>[];
  readonly skills?: readonly DoomMcpSkill[];
}

export interface DoomMcpServiceScope {
  /** Reads a service already mounted in this session without exposing host registration APIs. */
  get<T>(name: string): T | undefined;
}

export interface DoomMcpPluginContext {
  readonly execution: DoomHeadlessExecutionContext;
  readonly services: DoomMcpServiceScope;
  readonly selection: {
    read(): DoomHeadlessSelection;
    change(change: DoomHeadlessSelectionChange): Promise<void>;
  };
  /** Reads the allowlisted repository context from the current applied session selection. */
  loadContext(): DoomMcpContextSnapshot;
  /** Aborted when this plugin surface is replaced or the session closes. */
  readonly signal: AbortSignal;
  /** Rebuilds the remote surface after a live MCP catalog changes. */
  refresh(): void;
}

export interface DoomMcpPluginDefinition {
  readonly name: string;
  readonly session:
    | DoomMcpSessionPlugin
    | ((context: DoomMcpPluginContext) => DoomMcpSessionPlugin | Promise<DoomMcpSessionPlugin>);
}

/** Makes an MCP declaration's contract explicit without registering it locally. */
export function defineMcpPlugin(definition: DoomMcpPluginDefinition): DoomMcpPluginDefinition {
  return definition;
}

/** `tool/[name].mcp.ts`. Keeps the declaration independently typed. */
export function defineMcpTool<TParameters extends TSchema = TSchema, TContext = unknown>(
  tool: DoomHeadlessTool<TParameters> | ((context: TContext) => DoomHeadlessTool<TParameters>),
): DoomHeadlessTool<TParameters> | ((context: TContext) => DoomHeadlessTool<TParameters>) {
  return tool;
}

/** `skill/[name].mcp.ts`. Keeps remote guidance out of the local prompt surface. */
export function defineMcpSkill<TContext = unknown>(
  skill: DoomMcpSkill | ((context: TContext) => DoomMcpSkill),
): DoomMcpSkill | ((context: TContext) => DoomMcpSkill) {
  return skill;
}
