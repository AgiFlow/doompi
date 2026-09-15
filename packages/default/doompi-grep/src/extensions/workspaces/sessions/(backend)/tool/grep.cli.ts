import { definePiTool } from '@agimon-ai/doompi-core/pi-extension';
import { isWritableFile } from '@agimon-ai/doompi-hashline/files';
import { createGrepToolDefinition, type AgentToolResult, type ToolDefinition } from '@earendil-works/pi-coding-agent';

import { GrepParamsSchema, type GrepParams } from '../../../../../schemas/grepTool';
import { assertNotAborted, tagGrepResult, type GrepResult } from '../../../../../services/grepTool';

type WritableCheck = (path: string) => Promise<boolean>;

/**
 * Grep as Pi registers it.
 *
 * Everything here is shape. The search is Pi's own grep, which this wraps
 * rather than replaces, and the tagging is the grepTool service the headless
 * half uses too. What is left is the part Pi's execute signature does not
 * share with the headless one; the headless half is grep.server.ts.
 *
 * Drawing the call belongs to the frontend side, so renderShell, renderCall
 * and renderResult live in the `(frontend)/tool/grep.cli.ts` sibling and the
 * generated entry merges the pair.
 */
export function createHashlineGrepTool(
  writable: WritableCheck = isWritableFile,
): ToolDefinition<typeof GrepParamsSchema> {
  return {
    name: 'grep',
    label: 'grep',
    description:
      'Search file contents using Pi-compatible ripgrep semantics, then add exact-byte file tags and stable line anchors for writable matches. Non-writable matches retain native Pi output. Respects .gitignore.',
    promptSnippet: 'Search file contents and return editable hashline anchors',
    parameters: GrepParamsSchema,
    executionMode: 'parallel',
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const input = params as GrepParams;
      const nativeGrep = createGrepToolDefinition(ctx.cwd);
      const nativeResult = await nativeGrep.execute(toolCallId, input, signal, onUpdate, ctx);
      assertNotAborted(signal);
      const tagged = await tagGrepResult(nativeResult as GrepResult, input, ctx.cwd, signal, writable);
      return tagged as unknown as AgentToolResult<unknown>;
    },
  };
}

/**
 * Pi ships its own grep, so this claims that name rather than adding one.
 *
 * `overrides` makes it a claim the host arbitrates: only one package may own a
 * name, and the loser registers nothing.
 */
export default definePiTool(createHashlineGrepTool(), { overrides: true });
