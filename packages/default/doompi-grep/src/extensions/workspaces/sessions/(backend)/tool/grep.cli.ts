import { definePiTool } from '@agimon-ai/doompi-core/pi-extension';
import { isWritableFile } from '@agimon-ai/doompi-hashline/files';
import { renderHashlineCall, renderHashlineResult } from '@agimon-ai/doompi-ui/hashlineRendering';
import { createGrepToolDefinition, type AgentToolResult, type ToolDefinition } from '@earendil-works/pi-coding-agent';

import { GrepParamsSchema, type GrepParams } from '../../../../../schemas/grepTool';
import { assertNotAborted, tagGrepResult, type GrepResult } from '../../../../../services/grepTool';

type WritableCheck = (path: string) => Promise<boolean>;

/**
 * Grep as Pi registers it.
 *
 * Everything here is shape. The search is Pi's own grep, which this wraps
 * rather than replaces, and the tagging is the grepTool service the headless
 * half uses too. What cannot be shared is what is left: renderShell,
 * renderCall and renderResult draw into a terminal, and Pi's execute signature
 * differs from the headless one. The headless half is grep.server.ts.
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
    renderShell: 'self',
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const input = params as GrepParams;
      const nativeGrep = createGrepToolDefinition(ctx.cwd);
      const nativeResult = await nativeGrep.execute(toolCallId, input, signal, onUpdate, ctx);
      assertNotAborted(signal);
      const tagged = await tagGrepResult(nativeResult as GrepResult, input, ctx.cwd, signal, writable);
      return tagged as unknown as AgentToolResult<unknown>;
    },
    renderCall(args, theme) {
      const input = args as GrepParams;
      const details = [
        input.path ?? '.',
        input.glob,
        input.ignoreCase === true ? 'ignore case' : undefined,
        input.limit === undefined ? undefined : `${input.limit} matches`,
      ].filter((value): value is string => value !== undefined);
      return renderHashlineCall('grep', input.pattern, details, theme);
    },
    renderResult(result, options, theme, context) {
      return renderHashlineResult(result, options, theme, context, 'grep');
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
