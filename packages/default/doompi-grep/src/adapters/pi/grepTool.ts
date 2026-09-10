import { readFile, stat } from 'node:fs/promises';
import { renderHashlineCall, renderHashlineResult } from '@agimon-ai/doompi-ui/hashlineRendering';
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
  createGrepToolDefinition,
  type AgentToolResult,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { isWritableFile } from '@agimon-ai/doompi-hashline/files';
import { GrepParamsSchema, type GrepParams } from '../../schemas/grepTool.ts';
import {
  assertNotAborted,
  type GrepFileSystem,
  type GrepOutputOperations,
  type GrepResult,
  tagGrepResult as tagServiceGrepResult,
} from '../../services/grepTool.ts';

const fileSystem: GrepFileSystem = {
  stat: (path) => stat(path),
  readFile: (path) => readFile(path),
};

const outputOperations: GrepOutputOperations = {
  maxBytes: DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
};

export async function tagGrepResult(
  nativeResult: GrepResult,
  params: GrepParams,
  cwd: string,
  signal: AbortSignal | undefined,
  writable: WritableCheck = isWritableFile,
): Promise<GrepResult> {
  return tagServiceGrepResult(nativeResult, params, cwd, signal, writable, fileSystem, outputOperations);
}

export { groupGrepRows, parseGrepRow } from '../../services/grepTool.ts';
export type { GrepGroup, GrepRow } from '../../services/grepTool.ts';

type WritableCheck = (path: string) => Promise<boolean>;

/** Register only the snapshot-bound replacement for Pi's grep tool. */
export function registerHashlineGrepTool(
  pi: Pick<ExtensionAPI, 'registerTool'>,
  writable: WritableCheck = isWritableFile,
): void {
  pi.registerTool({
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
      return tagGrepResult(
        nativeResult as GrepResult,
        input,
        ctx.cwd,
        signal,
        writable,
      ) as unknown as AgentToolResult<unknown>;
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
  });
}
