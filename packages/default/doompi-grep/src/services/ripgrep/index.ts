import { spawn } from 'node:child_process';
import { relative } from 'node:path';

import { resolveInputPath } from '@agimon-ai/doompi-hashline/files';

import type { GrepParams } from '../../schemas/grepTool';
import type { RipgrepRequest, RipgrepResult } from './type';

/**
 * Searching with ripgrep, with no host in it.
 *
 * The interactive host delegates to Pi's own grep and only re-tags the result,
 * so today this has one caller. It still belongs here rather than beside that
 * caller: spawning a process and parsing its output is the same work whichever
 * host asked for it, and a routed file's job is the shape a host expects, not
 * the search underneath it.
 */
export async function runRipgrep(request: RipgrepRequest): Promise<RipgrepResult> {
  const { params, cwd, signal } = request;
  const output = await spawnRipgrep(argumentsFor(params, cwd), cwd, signal);
  if (output.trim() === '') return { content: [{ type: 'text', text: 'No matches found' }] };
  return { content: [{ type: 'text', text: limitMatches(output, params.limit) }] };
}

/** The ripgrep argv one search needs, exposed so a test can assert it without spawning. */
export function argumentsFor(params: GrepParams, cwd: string): string[] {
  const target = resolveInputPath(params.path ?? '.', cwd);
  const targetArg = relative(cwd, target) || '.';
  const args = ['--color', 'never', '--no-heading', '--with-filename', '--line-number'];
  if (params.ignoreCase === true) args.push('--ignore-case');
  if (params.literal === true) args.push('--fixed-strings');
  if (params.context !== undefined) args.push('--context', String(params.context));
  if (params.glob !== undefined) args.push('--glob', params.glob);
  args.push('--', params.pattern, targetArg);
  return args;
}

/**
 * Keeps at most `limit` matching lines, and every context line around them.
 *
 * A context line carries no `:<line>:` marker, which is what separates it from
 * a match, so trimming by line count alone would drop the context ripgrep was
 * asked for.
 */
export function limitMatches(output: string, limit: number | undefined): string {
  if (limit === undefined) return output.trimEnd();
  let matches = 0;
  const selected: string[] = [];
  for (const line of output.trimEnd().split('\n')) {
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
      // 1 is ripgrep's "no matches", which is a result rather than a failure.
      if (code === 0 || code === 1) {
        resolveOutput(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `ripgrep exited with code ${code ?? 'unknown'}`));
    });
  });
}
