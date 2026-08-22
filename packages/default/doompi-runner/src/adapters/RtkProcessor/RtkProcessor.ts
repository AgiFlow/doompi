import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { getResultMaxBytes } from '../../types/config.ts';
import {
  type IRtkProcessor,
  RTK_FAILED_WARNING,
  RTK_OVERSIZED_WARNING,
  RTK_TIMEOUT_WARNING,
  RTK_UNAVAILABLE_WARNING,
  type RtkFilter,
  type RtkProcessRequest,
  type RtkProcessResult,
} from '../../types/rtkProcessor';

const BYTES_PER_MIB = 1024 * 1024;
export const RTK_STDIN_MAX_BYTES = 10 * BYTES_PER_MIB;
const DEFAULT_RTK_TIMEOUT_MS = 10_000;
const RTK_KILL_WAIT_MS = 1_000;
const OUTPUT_BUFFER_FACTOR = 2;
const EXECUTABLE_MODE = 0o755;
const SIMPLE_TOKEN_PATTERN = /^[A-Za-z0-9_./:@%+=,-]+$/u;
const SHELL_CONTROL_PATTERN = /[\r\n;&|<>`$\\'"(){}*?!]/u;
const GIT_DIFF_INCOMPATIBLE_OPTIONS = [
  '-s',
  '-z',
  '--raw',
  '--numstat',
  '--shortstat',
  '--stat',
  '--dirstat',
  '--dirstat-by-file',
  '--summary',
  '--compact-summary',
  '--name-only',
  '--name-status',
  '--check',
  '--binary',
  '--word-diff',
  '--word-diff-regex',
  '--color',
  '--color-words',
  '--color-moved',
  '--color-moved-ws',
  '--line-prefix',
  '--no-patch',
  '--patch-with-raw',
  '--patch-with-stat',
  '--ext-diff',
  '--textconv',
  '--quiet',
  '--submodule',
] as const;
const STRUCTURED_SEARCH_INCOMPATIBLE_OPTIONS = [
  '--json',
  '--null',
  '--null-data',
  '--color',
  '--colour',
  '--after-context',
  '--before-context',
  '--context',
  '--no-filename',
  '--no-line-number',
  '--heading',
] as const;
const PACKAGE_BY_PLATFORM: Readonly<Record<string, string>> = {
  'darwin-arm64': '@agimon-ai/doompi-runner-rtk-darwin-arm64',
  'darwin-x64': '@agimon-ai/doompi-runner-rtk-darwin-x64',
  'linux-arm64': '@agimon-ai/doompi-runner-rtk-linux-arm64',
  'linux-x64': '@agimon-ai/doompi-runner-rtk-linux-x64',
};

type BinaryResolver = () => string | undefined;

export class RtkProcessor implements IRtkProcessor {
  constructor(
    private readonly resolveBinary: BinaryResolver = bundledBinary,
    private readonly timeoutMs = DEFAULT_RTK_TIMEOUT_MS,
  ) {}

  async process(request: RtkProcessRequest): Promise<RtkProcessResult> {
    const filter = classifyRtkFilter(request.command);
    if (!filter) return { kind: 'skipped' };

    let inputBytes: number;
    try {
      inputBytes = fs.statSync(request.logPath).size;
    } catch {
      return { kind: 'fallback', warning: RTK_FAILED_WARNING };
    }
    if (inputBytes > RTK_STDIN_MAX_BYTES) return { kind: 'fallback', warning: RTK_OVERSIZED_WARNING };

    let binary: string | undefined;
    try {
      binary = this.resolveBinary();
      if (!binary) return { kind: 'fallback', warning: RTK_UNAVAILABLE_WARNING };
      if ((fs.statSync(binary).mode & 0o111) === 0) fs.chmodSync(binary, EXECUTABLE_MODE);
    } catch {
      return { kind: 'fallback', warning: RTK_UNAVAILABLE_WARNING };
    }

    return this.pipe(binary, filter, request.logPath, inputBytes);
  }

  private pipe(binary: string, filter: RtkFilter, logPath: string, inputBytes: number): Promise<RtkProcessResult> {
    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(binary, ['pipe', '-f', filter], { stdio: 'pipe' });
      } catch {
        resolve({ kind: 'fallback', warning: RTK_FAILED_WARNING });
        return;
      }

      const input = fs.createReadStream(logPath);
      const outputLimit = getResultMaxBytes() * OUTPUT_BUFFER_FACTOR;
      let head: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let output: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let outputBytes = 0;
      let newlineCount = 0;
      let lastByte: number | undefined;
      let settled = false;
      let fallbackWarning: string | undefined;
      let killWaitTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: RtkProcessResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killWaitTimer) clearTimeout(killWaitTimer);
        input.destroy();
        resolve(result);
      };
      const stop = (warning: string): void => {
        if (settled) return;
        fallbackWarning = warning;
        let killed = false;
        try {
          killed = child.kill('SIGKILL');
        } catch {
          finish({ kind: 'fallback', warning });
          return;
        }
        if (!killed) {
          finish({ kind: 'fallback', warning });
          return;
        }
        killWaitTimer ??= setTimeout(() => finish({ kind: 'fallback', warning }), RTK_KILL_WAIT_MS);
      };
      const timer = setTimeout(() => stop(RTK_TIMEOUT_WARNING), this.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        for (const byte of chunk) if (byte === 0x0a) newlineCount += 1;
        lastByte = chunk.at(-1);
        if (head.byteLength < outputLimit) {
          head = Buffer.concat([head, chunk.subarray(0, outputLimit - head.byteLength)]);
        }
        output = appendTail(output, chunk, outputLimit);
      });
      child.stderr.resume();
      child.once('error', () => stop(RTK_FAILED_WARNING));
      child.stdin.once('error', () => stop(RTK_FAILED_WARNING));
      input.once('error', () => stop(RTK_FAILED_WARNING));
      child.once('close', (code) => {
        if (fallbackWarning) {
          finish({ kind: 'fallback', warning: fallbackWarning });
          return;
        }
        const processedOutput = decodeUtf8Tail(output);
        if (code !== 0 || (inputBytes > 0 && processedOutput.trim().length === 0)) {
          finish({ kind: 'fallback', warning: RTK_FAILED_WARNING });
          return;
        }
        const lines = newlineCount + (outputBytes > 0 && lastByte !== 0x0a ? 1 : 0);
        finish({
          kind: 'processed',
          result: {
            filter,
            // Only meaningful once the stream outgrew the buffer; below that
            // `output` already starts at byte zero.
            head: outputBytes > output.byteLength ? head.toString('utf8') : '',
            output: processedOutput,
            bytes: outputBytes,
            lines,
          },
        });
      });

      input.pipe(child.stdin);
    });
  }
}

/**
 * Classifies only whitespace-delimited single commands. Shell syntax, expansion,
 * quoting, and globbing are rejected instead of being partially interpreted.
 */
export function classifyRtkFilter(command: string): RtkFilter | undefined {
  if (SHELL_CONTROL_PATTERN.test(command)) return undefined;
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  const tokens = trimmed.split(/[ \t]+/u);
  if (tokens.some((token) => !SIMPLE_TOKEN_PATTERN.test(token))) return undefined;

  if (tokens[0] === 'cargo' && tokens[1] === 'test') {
    if (tokens.includes('--') || tokens.some((token) => token.startsWith('--message-format') || token === '--json')) {
      return undefined;
    }
    return 'cargo-test';
  }
  if (tokens[0] === 'pytest') {
    if (tokens.some((token) => token.startsWith('--json-report'))) return undefined;
    return 'pytest';
  }
  if (tokens[0] === 'git' && tokens[1] === 'diff') {
    if (
      tokens.some((token) =>
        GIT_DIFF_INCOMPATIBLE_OPTIONS.some((option) => token === option || token.startsWith(`${option}=`)),
      )
    ) {
      return undefined;
    }
    return 'git-diff';
  }
  if (tokens[0] === 'grep') {
    if (tokens.length < 4 || incompatibleStructuredSearch(tokens)) return undefined;
    return hasShortOrLongOption(tokens, 'n', '--line-number') && hasShortOrLongOption(tokens, 'H', '--with-filename')
      ? 'grep'
      : undefined;
  }
  if (tokens[0] === 'rg') {
    if (tokens.length < 4 || incompatibleStructuredSearch(tokens) || !tokens.includes('--no-heading')) return undefined;
    return hasShortOrLongOption(tokens, 'n', '--line-number') && hasShortOrLongOption(tokens, 'H', '--with-filename')
      ? 'grep'
      : undefined;
  }
  if (tokens[0] === 'go' && tokens[1] === 'test') {
    let jsonOutput = false;
    for (const token of tokens.slice(2)) {
      if (token === '-json' || token === '-json=true') jsonOutput = true;
      if (token === '-json=false') jsonOutput = false;
    }
    return jsonOutput ? 'go-test' : undefined;
  }
  if (tokens[0] === 'ruff' && tokens[1] === 'check') {
    const jsonOutput = tokens.some(
      (token, index) =>
        token === '--output-format=json' || (token === '--output-format' && tokens[index + 1] === 'json'),
    );
    return jsonOutput ? 'ruff-check' : undefined;
  }
  return undefined;
}

export function rtkPackageForTarget(platform: string, architecture: string): string | undefined {
  const target = `${platform}-${architecture}`;
  const packageName = PACKAGE_BY_PLATFORM[target];
  if (!packageName) process.emitWarning(`Bundled RTK binary is unavailable for unsupported target ${target}`);
  return packageName;
}

function bundledBinary(): string | undefined {
  const packageName = rtkPackageForTarget(process.platform, process.arch);
  if (!packageName) return undefined;
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve(`${packageName}/package.json`);
    return path.join(path.dirname(manifest), 'vendor', 'bin', 'rtk');
  } catch {
    return undefined;
  }
}

function appendTail(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
  limit: number,
): Buffer<ArrayBufferLike> {
  if (chunk.byteLength >= limit) return Buffer.from(chunk.subarray(chunk.byteLength - limit));
  const combined = Buffer.concat([current, chunk]);
  return combined.byteLength > limit ? Buffer.from(combined.subarray(combined.byteLength - limit)) : combined;
}

function decodeUtf8Tail(output: Buffer<ArrayBufferLike>): string {
  let start = 0;
  while (start < output.byteLength && (output[start]! & 0xc0) === 0x80) start += 1;
  return output.subarray(start).toString('utf8');
}
function hasShortOrLongOption(tokens: readonly string[], short: string, long: string): boolean {
  return tokens.some(
    (token) => token === long || (token.startsWith('-') && !token.startsWith('--') && token.slice(1).includes(short)),
  );
}

function incompatibleStructuredSearch(tokens: readonly string[]): boolean {
  return tokens.some(
    (token) =>
      (token.startsWith('-') && !token.startsWith('--') && /[0ABCILNchzZ]/u.test(token.slice(1))) ||
      STRUCTURED_SEARCH_INCOMPATIBLE_OPTIONS.some((option) => token === option || token.startsWith(`${option}=`)),
  );
}
