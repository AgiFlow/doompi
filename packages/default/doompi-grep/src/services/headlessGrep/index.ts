import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';

import type {
  DoomHeadlessExecutionContext,
  DoomHeadlessTool,
  DoomHeadlessToolResult,
} from '@agimon-ai/doompi-core/headless';
import { resolveInputPath, isWritableFile } from '@agimon-ai/doompi-hashline/files';
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, truncateLine } from '@earendil-works/pi-coding-agent';

import { GrepParamsSchema, type GrepParams } from '../../schemas/grepTool';
import {
  type GrepFileSystem,
  type GrepOutputOperations,
  type GrepResult,
  tagGrepResult as tagServiceGrepResult,
} from '../grepTool';

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
      const input = params as GrepParams;
      const result = await runRipgrep(input, context.cwd, signal);
      return tagServiceGrepResult(result, input, context.cwd, signal, isWritableFile, fileSystem, outputOperations);
    },
  };
}

async function runRipgrep(params: GrepParams, cwd: string, signal: AbortSignal | undefined): Promise<GrepResult> {
  const target = resolveInputPath(params.path ?? '.', cwd);
  const targetArg = relative(cwd, target) || '.';
  const args = ['--color', 'never', '--no-heading', '--with-filename', '--line-number'];
  if (params.ignoreCase === true) args.push('--ignore-case');
  if (params.literal === true) args.push('--fixed-strings');
  if (params.context !== undefined) args.push('--context', String(params.context));
  if (params.glob !== undefined) args.push('--glob', params.glob);
  args.push('--', params.pattern, targetArg);

  const output = await spawnRipgrep(args, cwd, signal);
  if (output.trim() === '') return { content: [{ type: 'text', text: 'No matches found' }] };
  return { content: [{ type: 'text', text: limitMatches(output, params.limit) }] };
}

function limitMatches(output: string, limit: number | undefined): string {
  if (limit === undefined) return output.trimEnd();
  let matches = 0;
  const lines = output.trimEnd().split('\n');
  const selected: string[] = [];
  for (const line of lines) {
    if (/:(\d+):/u.test(line)) {
      matches++;
      if (matches > limit) continue;
    }
    selected.push(line);
  }
  return selected.join('\n');
}

function spawnRipgrep(args: readonly string[], cwd: string, signal: AbortSignal | undefined): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn('rg', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const abort = (): void => {
      child.kill('SIGTERM');
      reject(new Error('Operation aborted'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      signal?.removeEventListener('abort', abort);
      reject(new Error(`Could not start ripgrep: ${error.message}`, { cause: error }));
    });
    child.once('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (code === 0 || code === 1) {
        resolveOutput(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `ripgrep exited with code ${code ?? 'unknown'}`));
    });
  });
}
