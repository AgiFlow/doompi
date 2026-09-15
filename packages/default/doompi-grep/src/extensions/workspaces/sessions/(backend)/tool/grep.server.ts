import { defineServerTool } from '@agimon-ai/doompi-core/extension-file';
import type {
  DoomHeadlessExecutionContext,
  DoomHeadlessTool,
  DoomHeadlessToolResult,
} from '@agimon-ai/doompi-core/headless';

import { GrepParamsSchema, type GrepParams } from '../../../../../schemas/grepTool';
import { tagGrepResult } from '../../../../../services/grepTool';
import { runRipgrep } from '../../../../../services/ripgrep';

/**
 * Grep as the headless host registers it.
 *
 * Everything this file does is shape: name the tool, declare its schema, and
 * adapt the host's execute signature. Searching is the ripgrep service and
 * tagging is the grepTool service, both of which the interactive half uses
 * too. What cannot be shared is exactly what is left here, and the reason is
 * the host: this signature takes a DoomHeadlessExecutionContext and carries no
 * renderers, because a hub session has no terminal to draw into. The
 * interactive half in grep.cli.ts is the same capability in Pi's shape.
 */
export function createHeadlessGrepTool(): DoomHeadlessTool<typeof GrepParamsSchema> {
  return {
    name: 'grep',
    label: 'grep',
    description:
      'Search file contents using ripgrep semantics, then add exact-byte file tags and stable line anchors for writable matches. Respects .gitignore.',
    promptSnippet: 'Search file contents and return editable hashline anchors',
    parameters: GrepParamsSchema,
    executionMode: 'parallel',
    execute: async (
      _toolCallId: string,
      params: GrepParams,
      signal: AbortSignal | undefined,
      _onUpdate: ((result: DoomHeadlessToolResult) => void) | undefined,
      context: DoomHeadlessExecutionContext,
    ) => {
      const result = await runRipgrep({ params, cwd: context.cwd, signal });
      return tagGrepResult(result, params, context.cwd, signal);
    },
  };
}

export default defineServerTool(createHeadlessGrepTool);
