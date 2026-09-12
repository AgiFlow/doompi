import type { Static, TSchema } from 'typebox';
import type { DoomNotificationRequest } from './notification';

/** Capabilities available to portable commands on both agent hosts. */
export interface DoomPluginExecution {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  notify(request: DoomNotificationRequest): void | Promise<void>;
}

export interface DoomPluginToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  details?: unknown;
  isError?: boolean;
}

export interface DoomPluginToolExecution extends DoomPluginExecution {
  readonly toolCallId: string;
  update(result: DoomPluginToolResult): void;
}

export interface DoomPluginTool<TParameters extends TSchema = TSchema> {
  readonly kind: 'tool';
  readonly when?: { readonly minorMode?: string; readonly domain?: string };
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly parameters: TParameters;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly executionMode?: 'parallel' | 'serial';
  execute(input: Static<TParameters>, execution: DoomPluginToolExecution): Promise<DoomPluginToolResult>;
}

export interface DoomPluginCommand {
  readonly kind: 'command';
  readonly name: string;
  readonly description: string;
  execute(args: string, execution: DoomPluginExecution): void | Promise<void>;
}

/** Preserve schema inference at the declaration, before heterogeneous composition. */
export function defineTool<TParameters extends TSchema>(
  tool: Omit<DoomPluginTool<TParameters>, 'kind'>,
): DoomPluginTool<TParameters> {
  return { ...tool, kind: 'tool' };
}

export function defineCommand(command: Omit<DoomPluginCommand, 'kind'>): DoomPluginCommand {
  return { ...command, kind: 'command' };
}
