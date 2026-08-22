import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BashRunRequest, BashRunResult, IBashRunService } from '../../src/types/bashRunService';
import { formatRunResult, registerBashTool } from '../../src/exports/tool/bashTool';
import {
  boundExcerpt,
  boundResultText,
  collectErrorLines,
  countLines,
  formatRunnerLine,
  formatSize,
  formatUptime,
  truncateForResult,
  type ToolResult,
} from '../../src/exports/tool/responseEnvelope';
import { estimateTokens } from '../../src/services/TokenEstimate/tokenEstimate';
import type { BashParams } from '../../src/exports/tool/schema';

let directory: string;

type BashExecute = (
  toolCallId: string,
  params: BashParams,
  signal: AbortSignal | undefined,
  onUpdate: ((result: ToolResult) => void) | undefined,
  context: never,
) => Promise<ToolResult>;

function captureBashExecute(bashRunService: IBashRunService): BashExecute {
  let execute: BashExecute | undefined;
  const pi = {
    registerTool: (definition: { execute: BashExecute }) => {
      execute = definition.execute;
    },
  } as unknown as ExtensionAPI;
  registerBashTool(pi, {
    bashRunService,
    getSessionId: () => 'session-a',
    onRunnerStarted: () => undefined,
  });
  if (!execute) throw new Error('bash tool was not registered');
  return execute;
}

beforeEach(() => {
  vi.clearAllMocks();
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-runner-envelope-')));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('formatSize', () => {
  it.each([
    [512, '512 B'],
    [2048, '2.0 KB'],
    [5 * 1024 * 1024, '5.0 MB'],
  ])('renders %i bytes as %s', (bytes, expected) => {
    expect(formatSize(bytes)).toBe(expected);
  });
});

describe('countLines', () => {
  it.each([
    ['', 0],
    ['one', 1],
    ['one\n', 1],
    ['one\ntwo', 2],
    ['one\ntwo\n', 2],
  ])('counts %j as %i', (text, expected) => {
    expect(countLines(text)).toBe(expected);
  });
});

describe('boundResultText', () => {
  it('bounds the complete UTF-8 response while retaining its leading and final recovery text', () => {
    const result = boundResultText(`head\n${'é'.repeat(100)}\nfooter`, 64);

    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(64);
    expect(result).toMatch(/^head\n/u);
    expect(result).toContain('line elided');
    expect(result).toMatch(/footer$/u);
  });

  it('uses a valid UTF-8 tail when the limit is smaller than the notice', () => {
    const result = boundResultText('🙂'.repeat(20), 7);

    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(7);
    expect(result).not.toContain('\uFFFD');
  });

  it('keeps an in-budget response unchanged', () => {
    expect(boundResultText('complete', 32)).toBe('complete');
  });
});

describe('error salvage from the elided middle', () => {
  function buildLog(): string {
    const lines = ['==> build start', 'compiling'];
    for (let index = 0; index < 300; index += 1) {
      lines.push(`  compiled src/module-${index}.ts`);
      if (index % 100 === 0) lines.push(`ERROR in src/widget-${index}.ts:${index}:7 - Type mismatch`);
    }
    lines.push('assertion failed: expected 1 got 2');
    for (let index = 0; index < 300; index += 1) lines.push(`  compiled src/other-${index}.ts`);
    lines.push('exit status 1');
    return lines.join('\n');
  }

  it('rescues error lines that neither end would have shown', () => {
    const result = boundExcerpt(buildLog(), 14, 700);

    expect(result.text).toMatch(/^==> build start\n/u);
    expect(result.text).toContain('src/widget-0.ts');
    expect(result.text).toContain('assertion failed: expected 1 got 2');
    expect(result.text).toMatch(/exit status 1$/u);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(700);
  });

  it('joins near-identical failures without losing what differs between them', () => {
    const result = boundExcerpt(buildLog(), 14, 700);

    // The file names are the actionable part; a bare occurrence count drops them.
    expect(result.text).toContain('src/widget-100.ts:100:7|src/widget-200.ts:200:7');
    expect(result.text).toContain('- Type mismatch');
    expect(result.text.match(/- Type mismatch/gu)).toHaveLength(1);
  });

  it('collapses only byte-identical lines into a count', () => {
    const repeated = ['error: connection refused', 'error: connection refused', 'error: connection refused'];
    expect(collectErrorLines(repeated)).toEqual([{ variants: ['error: connection refused'], count: 3 }]);
  });

  it('keeps each distinct variant of one shape', () => {
    const varied = ['error: cannot open /tmp/a.txt', 'error: cannot open /tmp/b.txt'];
    expect(collectErrorLines(varied)).toEqual([
      { variants: ['error: cannot open /tmp/a.txt', 'error: cannot open /tmp/b.txt'], count: 2 },
    ]);
  });

  it('spends the whole remaining budget on the tail when nothing failed', () => {
    const clean = Array.from({ length: 600 }, (_, index) => `  compiled src/module-${index}.ts`).join('\n');
    const result = boundExcerpt(clean, 14, 700);

    expect(result.text).not.toContain('shown below');
    expect(result.text).toContain('module-599');
  });

  it('counts past the entry cap so the tallies stay honest', () => {
    const repeated = Array.from({ length: 50 }, () => 'error: connection refused');
    expect(collectErrorLines(repeated)).toEqual([{ variants: ['error: connection refused'], count: 50 }]);
  });

  it.each([
    ['[widget] build: error TS2322', 'a tag before the severity'],
    ['FAILED tests/test_x.py::test_y', 'an uppercase severity at the start'],
    ['2026-08-22T10:00:00Z Error: connection refused', 'a timestamp before the severity'],
    ['MIDDLE-ERROR-MARKER: something failed here', 'severity only later in the line'],
  ])('matches %s (%s)', (line) => {
    expect(collectErrorLines([line])).toHaveLength(1);
  });

  it.each([
    '0 errors, 0 warnings',
    'no failures detected',
    'npm run build --error-format json',
    '  compiled src/error-handler.ts',
  ])('leaves %s alone', (line) => {
    expect(collectErrorLines([line])).toEqual([]);
  });

  it('ignores keyword mentions that are not the subject of the line', () => {
    expect(
      collectErrorLines(['0 errors, 0 warnings', 'no failures detected', 'npm run build --error-format json']),
    ).toEqual([]);
  });

  it('matches a bracketed severity prefix', () => {
    expect(collectErrorLines(['[2026-08-22] ERROR could not bind port'])).toHaveLength(1);
  });
});

describe('result shape follows the exit status', () => {
  function writeLog(): string {
    const logPath = path.join(directory, 'shape.log');
    const lines = ['$ pnpm build'];
    for (let index = 0; index < 400; index += 1) {
      lines.push(`  compiled src/module-${index}.ts`);
      if (index === 200) lines.push('ERROR in src/widget.ts:12:7 - Type mismatch');
    }
    lines.push('Done in 12.4s');
    fs.writeFileSync(logPath, lines.join('\n'));
    return logPath;
  }

  const base = {
    kind: 'completed' as const,
    id: 'run-a',
    name: 'brave-otter',
    output: '',
    signal: null,
    backend: 'native' as const,
  };

  it('spends far less on a success, which has already reported itself by exiting 0', () => {
    const logPath = writeLog();
    const success = formatRunResult({ ...base, exitCode: 0, logPath }).content[0]?.text ?? '';
    let failure = '';
    try {
      formatRunResult({ ...base, exitCode: 1, logPath });
    } catch (error) {
      failure = (error as Error).message;
    }

    // Same shape either way: both ends, with the middle elided.
    expect(success).toContain('Log excerpt (');
    expect(success).toMatch(/\$ pnpm build/u);
    expect(success).toContain('Done in 12.4s');
    expect(Buffer.byteLength(success, 'utf8')).toBeLessThanOrEqual(2_048);
    expect(Buffer.byteLength(failure, 'utf8')).toBeGreaterThan(Buffer.byteLength(success, 'utf8'));
  });

  it('lets a pragma buy back the wider result on a success', () => {
    const logPath = writeLog();
    const narrow = formatRunResult({ ...base, exitCode: 0, logPath }).content[0]?.text ?? '';
    // Both ceilings apply, so a pragma has to lift both to buy anything back.
    const wide =
      formatRunResult({ ...base, exitCode: 0, logPath }, { maxBytes: 8_192, maxTokens: 2_048 }).content[0]?.text ?? '';

    expect(Buffer.byteLength(wide, 'utf8')).toBeGreaterThan(Buffer.byteLength(narrow, 'utf8'));
  });

  it('gives a failure both ends and the rescued error', () => {
    const logPath = writeLog();
    let text = '';
    try {
      formatRunResult({ ...base, exitCode: 1, logPath });
    } catch (error) {
      text = (error as Error).message;
    }

    expect(text).toContain('Log excerpt (');
    expect(text).toMatch(/\$ pnpm build/u);
    expect(text).toContain('ERROR in src/widget.ts:12:7');
    expect(text).toContain('Done in 12.4s');
  });
});

describe('token ceiling', () => {
  const asciiLog = Array.from({ length: 800 }, (_, index) => `  compiled src/module-${index}.ts`).join('\n');
  const base64Log = Array.from({ length: 800 }, () => 'SGVsbG8gV29ybGQhIFRoaXMgaXMgYmFzZTY0IGVuY29kZWQ=').join('\n');

  it('trims dense output that the byte ceiling alone would let through', () => {
    const capped = boundExcerpt(base64Log, 120, 8_192, 2_048);
    const bytesOnly = boundExcerpt(base64Log, 120, 8_192, Number.POSITIVE_INFINITY);

    expect(estimateTokens(capped.text)).toBeLessThan(estimateTokens(bytesOnly.text));
    expect(estimateTokens(capped.text)).toBeLessThanOrEqual(2_048);
  });

  it('leaves ordinary output alone, where bytes and lines already bind', () => {
    const capped = boundExcerpt(asciiLog, 120, 8_192, 2_048);
    const bytesOnly = boundExcerpt(asciiLog, 120, 8_192, Number.POSITIVE_INFINITY);

    expect(capped.text).toBe(bytesOnly.text);
  });

  it('keeps the byte ceiling as the hard bound behind the estimate', () => {
    const capped = boundExcerpt(base64Log, 120, 4_096, Number.POSITIVE_INFINITY);
    expect(Buffer.byteLength(capped.text, 'utf8')).toBeLessThanOrEqual(4_096);
  });
});

describe('formatUptime', () => {
  const now = Date.parse('2026-08-01T12:00:00.000Z');

  it.each([
    ['2026-08-01T11:59:30.000Z', '30s'],
    ['2026-08-01T11:45:00.000Z', '15m'],
    ['2026-08-01T09:00:00.000Z', '3h'],
    ['2026-07-29T12:00:00.000Z', '3d'],
  ])('renders a runner started at %s as %s', (startedAt, expected) => {
    expect(formatUptime(startedAt, now)).toBe(expected);
  });

  it('says so when the timestamp is unreadable', () => {
    expect(formatUptime('not-a-date', now)).toBe('unknown');
  });
});

describe('formatRunnerLine', () => {
  it('puts name, pid, uptime and command on one line', () => {
    const now = Date.parse('2026-08-01T12:00:00.000Z');
    const line = formatRunnerLine(
      {
        id: 'runner-id',
        name: 'api',
        pid: 42,
        command: 'nx dev-start api',
        cwd: '/repo',
        logPath: '/logs/api.log',
        interactive: false,
        sessionId: 's',
        startedAt: '2026-08-01T11:55:00.000Z',
        state: 'running',
        promoted: true,
        backend: 'native',
        hostPid: 1,
      },
      now,
    );
    expect(line).toBe('api  pid 42  up 5m  nx dev-start api');
  });

  it('marks interactive runners', () => {
    const now = Date.parse('2026-08-01T12:00:00.000Z');
    const line = formatRunnerLine(
      {
        id: 'runner-id',
        name: 'deploy',
        pid: 42,
        command: 'deploy',
        cwd: '/repo',
        logPath: '/logs/deploy.log',
        interactive: true,
        sessionId: 's',
        startedAt: '2026-08-01T12:00:00.000Z',
        state: 'running',
        promoted: true,
        backend: 'native',
        hostPid: 1,
      },
      now,
    );
    expect(line).toContain('interactive');
  });
});

describe('truncateForResult', () => {
  it('returns output untouched when it fits', () => {
    const result = truncateForResult('one\ntwo\n', '/logs/api.log', 1000);
    expect(result).toEqual({ text: 'one\ntwo\n', truncated: false, outputLines: 2 });
  });

  it('keeps whole lines from both ends', () => {
    const text = Array.from({ length: 100 }, (_, index) => `line-${index}`).join('\n');
    const result = truncateForResult(text, '/logs/api.log', 100);

    expect(result.truncated).toBe(true);
    expect(result.text.startsWith('line-0\n')).toBe(true);
    expect(result.text).toContain('lines elided');
    expect(result.text).toContain('line-99');
  });

  it('states the log path, its real size and the full line count', () => {
    const logPath = path.join(directory, 'api.log');
    const text = Array.from({ length: 500 }, (_, index) => `line-${index}`).join('\n');
    fs.writeFileSync(logPath, text);

    const result = truncateForResult(text, logPath, 100);

    expect(result.text).toContain(logPath);
    expect(result.text).toContain('500 lines');
    expect(result.text).toContain(formatSize(fs.statSync(logPath).size));
    expect(result.text).toContain('doom-runner logs');
  });

  it('counts the file, not the capped buffer it was handed', () => {
    // The in-memory buffer is capped well below the log, so a notice derived
    // from it would send the reader looking past the end of a longer file.
    const logPath = path.join(directory, 'api.log');
    const whole = Array.from({ length: 20_000 }, (_, index) => `line-${index}`).join('\n');
    fs.writeFileSync(logPath, whole);
    const capped = whole.slice(-4096);

    const result = truncateForResult(capped, logPath, 2048);

    expect(result.text).toContain('20,000 lines');
    expect(result.text).not.toContain('683 lines');
    expect(result.text).toContain(formatSize(fs.statSync(logPath).size));
  });

  it('falls back to the in-memory size when the log file is gone', () => {
    const text = 'x'.repeat(400);
    const result = truncateForResult(text, path.join(directory, 'absent.log'), 100);
    expect(result.text).toContain(formatSize(400));
    expect(result.text).toContain('1 line');
  });
});

describe('registerBashTool', () => {
  it('emits an initial partial result and live foreground output', async () => {
    const logPath = path.join(directory, 'foreground.log');
    fs.writeFileSync(logPath, 'live output\n');
    const run = vi.fn(async (request: BashRunRequest): Promise<BashRunResult> => {
      request.onOutput?.('live output\n');
      return {
        kind: 'completed',
        id: 'runner-id',
        name: 'foreground',
        output: 'live output\n',
        exitCode: 0,
        signal: null,
        logPath,
        backend: 'native',
      };
    });
    const execute = captureBashExecute({ run });
    const onUpdate = vi.fn();

    await execute('call-id', { command: 'echo live' }, undefined, onUpdate, undefined as never);

    expect(onUpdate).toHaveBeenNthCalledWith(1, {
      content: [{ type: 'text', text: 'Starting command...' }],
      details: {},
    });
    expect(onUpdate).toHaveBeenNthCalledWith(2, {
      content: [{ type: 'text', text: 'live output\n' }],
      details: {},
    });
    expect(run.mock.calls[0]?.[0].onOutput).toBeTypeOf('function');
  });

  it.each([
    ['background', { command: 'sleep 10', background: true }, 'Starting background runner...'],
    ['interactive', { command: 'confirm', interactive: true }, 'Starting interactive runner...'],
  ])('emits an initial update without streaming output for %s execution', async (mode, params, message) => {
    const run = vi.fn(async (_request: BashRunRequest): Promise<BashRunResult> => ({
      kind: 'promoted',
      id: 'runner-id',
      name: 'runner',
      pid: 42,
      logPath: '/tmp/runner.log',
      backend: 'native',
      reason: mode === 'interactive' ? 'interactive' : 'requested',
    }));
    const execute = captureBashExecute({ run });
    const onUpdate = vi.fn();

    await execute('call-id', params, undefined, onUpdate, undefined as never);

    expect(onUpdate).toHaveBeenCalledWith({ content: [{ type: 'text', text: message }], details: {} });
    expect(run.mock.calls[0]?.[0].onOutput).toBeUndefined();
  });
});

function thrownMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error('Expected action to throw');
}

describe('formatRunResult', () => {
  const promoted = {
    kind: 'promoted' as const,
    id: 'runner-id',
    name: 'api',
    pid: 42,
    logPath: '/logs/api.log',
    backend: 'native' as const,
    reason: 'threshold' as const,
  };

  it('returns only the controls needed for a background runner', () => {
    const result = formatRunResult(promoted);
    const text = result.content[0]?.text ?? '';

    expect(text).toBe(
      [
        'Still running after the background threshold: runner "api" (runner-id).',
        'Streaming log: /logs/api.log',
        'Inspect: doom-runner logs runner-id',
      ].join('\n'),
    );
    expect(text).not.toContain('Backend:');
    expect(result.details).toMatchObject({ promoted: true, reason: 'threshold' });
    expect(result.addedToolNames).toBeUndefined();
  });

  it('distinguishes requested and interactive background starts', () => {
    expect(formatRunResult({ ...promoted, reason: 'requested' }).content[0]?.text).toContain(
      'Started in the background',
    );
    expect(formatRunResult({ ...promoted, reason: 'interactive' }).content[0]?.text).toContain('Started interactively');
  });

  it('keeps a short successful result to output only', () => {
    const logPath = path.join(directory, 'completed.log');
    fs.writeFileSync(logPath, 'hi\n');
    const result = formatRunResult({
      kind: 'completed',
      id: 'runner-id',
      name: 'api',
      output: 'hi\n',
      exitCode: 0,
      signal: null,
      logPath,
      backend: 'native',
    });
    const text = result.content[0]?.text ?? '';

    expect(text).toBe('hi');
    expect(text).not.toContain('Runner ID:');
    expect(text).not.toContain('File size:');
    expect(text).not.toContain(logPath);
    expect(result.details).toMatchObject({ logPath, lines: 1, tailLines: 1 });
  });

  it('returns bounded RTK output while leaving the complete raw log untouched', () => {
    const logPath = path.join(directory, 'rtk.log');
    const raw = 'verbose raw test output\n';
    fs.writeFileSync(logPath, raw);
    const result = formatRunResult({
      kind: 'completed',
      id: 'runner-id',
      name: 'tests',
      output: raw,
      exitCode: 0,
      signal: null,
      logPath,
      backend: 'native',
      rtkOutput: { filter: 'pytest', head: '', output: '3 passed\n', bytes: 9, lines: 1 },
    });

    expect(result.content[0]?.text).toBe('3 passed');
    expect(result.details).toMatchObject({ rtkFilter: 'pytest', rtkOutputBytes: 9, lines: 1 });
    expect(fs.readFileSync(logPath, 'utf8')).toBe(raw);
  });

  it('keeps bounded raw output and appends an RTK fallback warning', () => {
    const logPath = path.join(directory, 'rtk-fallback.log');
    fs.writeFileSync(logPath, 'raw failure context\n');
    const result = formatRunResult({
      kind: 'completed',
      id: 'runner-id',
      name: 'tests',
      output: 'raw failure context\n',
      exitCode: 0,
      signal: null,
      logPath,
      backend: 'native',
      rtkWarning: 'Warning: RTK is unavailable; showing raw output.',
    });

    expect(result.content[0]?.text).toBe('raw failure context\nWarning: RTK is unavailable; showing raw output.');
  });
  it('falls back to captured output when the saved log is unavailable', () => {
    const result = formatRunResult({
      kind: 'completed',
      id: 'runner-id',
      name: 'api',
      output: 'captured\n',
      exitCode: 0,
      signal: null,
      logPath: path.join(directory, 'missing.log'),
      backend: 'native',
    });

    expect(result.content[0]?.text).toBe('captured');
    expect(result.details).toMatchObject({ tail: 'captured\n', lines: 1, tailLines: 1 });
  });

  it('returns a complete failure without generic recovery options or redundant metadata', () => {
    const logPath = path.join(directory, 'failed.log');
    const output = [
      'To github.com:example/repo.git',
      ' ! [rejected] main -> main (fetch first)',
      "error: failed to push some refs to 'github.com:example/repo.git'",
      'hint: Updates were rejected because the remote contains work that you do not have locally.',
    ].join('\n');
    fs.writeFileSync(logPath, `${output}\n`);
    const message = thrownMessage(() =>
      formatRunResult({
        kind: 'completed',
        id: 'runner-id',
        name: 'git-push',
        output: `${output}\n`,
        exitCode: 1,
        signal: null,
        logPath,
        backend: 'native',
      }),
    );

    expect(message).toBe(`${output}\nExit: 1`);
    expect(message).not.toContain('Options:');
    expect(message).not.toContain('Runner ID:');
    expect(message).not.toContain(logPath);
  });

  it('adds log recovery controls only when output is truncated', () => {
    const logPath = path.join(directory, 'truncated.log');
    fs.writeFileSync(logPath, Array.from({ length: 250 }, (_, index) => `line-${index}`).join('\n'));
    const message = thrownMessage(() =>
      formatRunResult({
        kind: 'completed',
        id: 'runner-id',
        name: 'api',
        output: '',
        exitCode: 2,
        signal: null,
        logPath,
        backend: 'native',
      }),
    );

    expect(message).toContain('Log excerpt (120 of 250 lines):');
    expect(message).toContain('line-249');
    expect(message).toContain('Exit: 2');
    expect(message).toContain(`Full log: ${logPath}`);
    expect(message).toContain('inspect with doom-runner logs runner-id');
    expect(message).not.toContain('Options:');
  });

  it('gives one recovery path when a failed command produced no output', () => {
    const message = thrownMessage(() =>
      formatRunResult({
        kind: 'completed',
        id: 'runner-id',
        name: 'api',
        output: '',
        exitCode: null,
        signal: 'SIGTERM',
        logPath: '/logs/api.log',
        backend: 'native',
        timedOut: true,
      }),
    );

    expect(message).toContain('No output.');
    expect(message).toContain('Timed out: exceeded the requested timeout.');
    expect(message).toContain('Log: /logs/api.log');
    expect(message).toContain('Next: run one read-only diagnostic; retry only after correcting the cause.');
    expect(message).not.toContain('Options:');
  });

  it('reports a signal without extra recovery copy when output is complete', () => {
    const message = thrownMessage(() =>
      formatRunResult({
        kind: 'completed',
        id: 'runner-id',
        name: 'api',
        output: 'interrupted\n',
        exitCode: null,
        signal: 'SIGINT',
        logPath: '/logs/api.log',
        backend: 'rmux',
      }),
    );

    expect(message).toBe('interrupted\nSignal: SIGINT');
  });

  it('says so when a successful command produced nothing', () => {
    const text =
      formatRunResult({
        kind: 'completed',
        id: 'runner-id',
        name: 'api',
        output: '',
        exitCode: 0,
        signal: null,
        logPath: '/logs/api.log',
        backend: 'native',
      }).content[0]?.text ?? '';

    expect(text).toBe('Completed with no output.');
  });

  it('surfaces a start failure with one guarded retry instruction', () => {
    const message = thrownMessage(() =>
      formatRunResult({ kind: 'failed', id: 'runner-id', name: 'api', error: 'spawn ENOENT' }),
    );

    expect(message).toBe(
      'Could not start runner "api": spawn ENOENT\nNext: correct the reported launch or supervision problem. Retry only after changing the command or environment.',
    );
    expect(message).not.toContain('Options:');
  });
});
