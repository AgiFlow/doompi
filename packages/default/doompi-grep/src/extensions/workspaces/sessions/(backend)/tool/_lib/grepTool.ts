import { isWritableFile } from '@agimon-ai/doompi-hashline/files';
import { createGrepToolDefinition, type AgentToolResult, type ToolDefinition } from '@earendil-works/pi-coding-agent';

import { GrepParamsSchema, type GrepParams } from '../../../../../../schemas/grepTool';
import { assertNotAborted, type GrepResult, tagGrepResult } from '../../../../../../services/grepTool';

type WritableCheck = (path: string) => Promise<boolean>;

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
