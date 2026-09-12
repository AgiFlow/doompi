import { displayPath, isWritableFile, resolveReadInputPath } from '@agimon-ai/doompi-hashline/files';
import { readFile } from 'node:fs/promises';
import { renderHashlineCall, renderHashlineResult } from '@agimon-ai/doompi-ui/hashlineRendering';
import {
  createReadToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  type AgentToolResult,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { ReadParamsSchema, type ReadParams } from '../schemas/readTool';
import { applyImageLimits, imageLimits } from '../services/piReadImage';
import { assertNotAborted, createTaggedReadResult, isImageRead } from '../services/readTool';
export { assertNotAborted, createTaggedReadResult, isImageRead } from '../services/readTool';

type WritableCheck = (path: string) => Promise<boolean>;

/** Register the snapshot-bound replacement for Pi's read tool. */
export function createHashlineReadTool(
  writable: WritableCheck = isWritableFile,
): ToolDefinition<typeof ReadParamsSchema> {
  return {
    name: 'read',
    label: 'read',
    description: `Read a writable text file with an exact-byte file tag and stable line anchors. Non-writable files and images retain Pi's native behavior. Text is truncated to ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet: 'Read file contents with snapshot-bound line anchors',
    promptGuidelines: [
      'Use read before edit. When hashline metadata is present, preserve the @file hash and anchors such as 5#abc exactly.',
      'Continue large reads with offset until the required anchored lines are visible.',
    ],
    parameters: ReadParamsSchema,
    executionMode: 'parallel',
    renderShell: 'self',
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const input = params as ReadParams;
      assertNotAborted(signal);
      const absolutePath = await resolveReadInputPath(input.path, ctx.cwd);
      // Pi resizes at a cap it hardcodes, so it is told not to: the block comes
      // back converted but full size, and the machine's configured cap is
      // applied below. Everything else about the native read is kept.
      const nativeRead = createReadToolDefinition(ctx.cwd, { autoResizeImages: false });
      const nativeResult = await nativeRead.execute(
        toolCallId,
        { ...input, path: absolutePath },
        signal,
        onUpdate,
        ctx,
      );
      if (isImageRead(nativeResult.content)) {
        assertNotAborted(signal);
        return { ...nativeResult, content: await applyImageLimits(nativeResult.content, imageLimits()) };
      }

      assertNotAborted(signal);
      const canEdit = await writable(absolutePath);
      assertNotAborted(signal);
      if (!canEdit) return nativeResult;
      const bytes = await readFile(absolutePath);
      assertNotAborted(signal);
      return createTaggedReadResult(
        bytes,
        displayPath(absolutePath, ctx.cwd),
        input,
      ) as unknown as AgentToolResult<unknown>;
    },
    renderCall(args, theme) {
      const input = args as ReadParams;
      const details = [
        input.offset === undefined ? undefined : `from ${input.offset}`,
        input.limit === undefined ? undefined : `${input.limit} lines`,
      ].filter((value): value is string => value !== undefined);
      return renderHashlineCall('read', input.path, details, theme);
    },
    renderResult(result, options, theme, context) {
      return renderHashlineResult(result, options, theme, context, 'read');
    },
  };
}
