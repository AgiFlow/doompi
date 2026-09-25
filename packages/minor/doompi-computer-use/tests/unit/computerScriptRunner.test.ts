import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ComputerScriptExecutionError, ComputerScriptRunner } from '../../src/services/computerScriptRunner';
import { computerScriptOutput } from '../../src/services/computerToolOutput';
import type { ComputerUseObservation, ComputerUseSessionClient } from '../../src/types/computerUse';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(source: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'doompi-computer-script-'));
  directories.push(directory);
  const scriptPath = path.join(directory, 'script.ts');
  await writeFile(scriptPath, source);
  return { directory, scriptPath };
}

const observation: ComputerUseObservation = {
  runId: 'run',
  snapshotId: 'fresh',
  targetGeneration: 'target',
  applicationName: 'Fixture',
  bundleId: 'fixture.app',
  windowTitle: 'Fixture window',
  elements: [],
  screenshot: { mimeType: 'image/png', data: 'cG5n' },
};
function client(): ComputerUseSessionClient {
  return {
    state: vi.fn(async () => ({ sessionId: 'session', phase: 'active' as const, revision: 1, wake: 1 })),
    observe: vi.fn(async () => observation),
    act: vi.fn(async () => ({ applied: true })),
    stop: vi.fn(async () => ({ sessionId: 'session', phase: 'inactive' as const, revision: 2, wake: 2 })),
  };
}

describe('computer functions', () => {
  it('composes typed relative helpers with fresh state in one restricted invocation', async () => {
    const { directory, scriptPath } = await fixture(`
      import { press } from './press.ts';
      export async function run({ context: { program }, input, logger }: any) {
        logger.info('running');
        await press(program, input.ref);
        await press(program, input.ref);
        return { done: true };
      }
    `);
    await writeFile(
      path.join(directory, 'press.ts'),
      `
      export async function press(program: any, ref: string) {
        const state = await program.observe();
        await program.act({ kind: 'press', snapshotId: state.snapshotId, elementRef: ref });
      }
    `,
    );
    const session = client();
    let sequence = 0;
    vi.mocked(session.observe).mockImplementation(async () => ({ ...observation, snapshotId: String(sequence) }));
    vi.mocked(session.act).mockImplementation(async (action) => {
      expect(action.snapshotId).toBe(String(sequence));
      sequence += 1;
      return { applied: true };
    });
    const runner = new ComputerScriptRunner({ client: session, allowedScriptPaths: [], scriptRoot: directory });
    const result = await runner.execute(scriptPath, { ref: 'button' });
    expect(result).toMatchObject({
      result: { done: true },
      logs: ['[info] running'],
      metrics: { actions: 2, observations: 3 },
    });
    expect(result.observation.snapshotId).toBe('2');
    expect(result.observation.screenshot).toBeUndefined();
    expect(session.observe).toHaveBeenCalledWith(expect.any(AbortSignal), { includeScreenshot: false });
    expect(session.stop).not.toHaveBeenCalled();
  });

  it('resolves allowlisted relative scripts from the invoking session pwd', async () => {
    const { directory, scriptPath } = await fixture('export function run() { return "worktree"; }');
    const runner = new ComputerScriptRunner({ client: client(), allowedScriptPaths: [scriptPath] });
    expect((await runner.execute('script.ts', {}, undefined, { trusted: true }, directory)).result).toBe('worktree');
  });

  it('does not expose Node globals, credentials, or host constructors to generated functions', async () => {
    const { directory, scriptPath } = await fixture(`
      export function run() {
        return { process: typeof process, require: typeof require, fetch: typeof fetch,
          buffer: typeof Buffer, constructorEscape: Function('return typeof process')() };
      }
    `);
    const runner = new ComputerScriptRunner({ client: client(), allowedScriptPaths: [], scriptRoot: directory });
    expect((await runner.execute(scriptPath, {})).result).toEqual({
      process: 'undefined',
      require: 'undefined',
      fetch: 'undefined',
      buffer: 'undefined',
      constructorEscape: 'undefined',
    });
  });

  it.each(['node:fs', 'node:child_process', 'quickjs-emscripten'])(
    'rejects restricted imports of %s',
    async (specifier) => {
      const { directory, scriptPath } = await fixture(
        `import * as host from '${specifier}'; export function run() { return host; }`,
      );
      const runner = new ComputerScriptRunner({ client: client(), allowedScriptPaths: [], scriptRoot: directory });
      await expect(runner.execute(scriptPath, {})).rejects.toThrow(/cannot import host or package modules/u);
    },
  );

  it('rejects helper symlinks outside the admitted root', async () => {
    const outside = await fixture('export const value = 1;');
    const { directory, scriptPath } = await fixture(
      "import { value } from './helper.ts'; export function run() { return value; }",
    );
    await symlink(outside.scriptPath, path.join(directory, 'helper.ts'));
    const runner = new ComputerScriptRunner({ client: client(), allowedScriptPaths: [], scriptRoot: directory });
    await expect(runner.execute(scriptPath, {})).rejects.toThrow(/escapes the admitted script root/u);
  });

  it('requires an explicit trusted option and exact allowlist for full Node, with relative imports preserved', async () => {
    const { directory, scriptPath } = await fixture(
      "import { value } from './helper.ts'; export function run() { return { value, node: typeof process }; }",
    );
    await writeFile(path.join(directory, 'helper.ts'), 'export const value: number = 42;');
    const untrusted = new ComputerScriptRunner({ client: client(), allowedScriptPaths: [], scriptRoot: directory });
    await expect(untrusted.execute(scriptPath, {}, undefined, { trusted: true })).rejects.toThrow(
      /not explicitly allowed/u,
    );
    const trusted = new ComputerScriptRunner({ client: client(), allowedScriptPaths: [scriptPath] });
    expect((await trusted.execute(scriptPath, {}, undefined, { trusted: true })).result).toEqual({
      value: 42,
      node: 'object',
    });
    expect((await trusted.execute(scriptPath, {})).result).toEqual({ value: 42, node: 'undefined' });
  });

  it('enforces the text budget on the final observation', async () => {
    const { directory, scriptPath } = await fixture('export function run() { return 1; }');
    const session = client();
    vi.mocked(session.observe).mockResolvedValue({ ...observation, windowTitle: 'x'.repeat(4096) });
    const runner = new ComputerScriptRunner({
      client: session,
      allowedScriptPaths: [],
      scriptRoot: directory,
      maxOutputBytes: 1024,
    });
    await expect(runner.execute(scriptPath, {})).rejects.toThrow(/observation exceeds/u);
  });

  it('returns an optional image block instead of base64 in model text', async () => {
    const { directory, scriptPath } = await fixture('export function run() { return 1; }');
    const runner = new ComputerScriptRunner({ client: client(), allowedScriptPaths: [], scriptRoot: directory });
    const result = computerScriptOutput(await runner.execute(scriptPath, {}, undefined, { includeScreenshot: true }));
    expect(result.content).toContainEqual({ type: 'image', data: 'cG5n', mimeType: 'image/png' });
    expect(
      result.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join(''),
    ).not.toContain('cG5n');
  });

  it.each(['text', 'image'] as const)(
    'retains completed actions when the final %s response exceeds its limit',
    (kind) => {
      const result = {
        result: kind === 'text' ? 'x'.repeat(256 * 1024) : undefined,
        observation: {
          ...observation,
          ...(kind === 'image'
            ? { screenshot: { mimeType: 'image/png' as const, data: 'x'.repeat(8 * 1024 * 1024 + 1) } }
            : {}),
        },
        logs: [],
        metrics: { actions: 2, observations: 3, durationMs: 1, outputBytes: 0 },
      };
      let failure: unknown;
      try {
        computerScriptOutput(result);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ComputerScriptExecutionError);
      expect(failure).toMatchObject({ completedActions: 2, outcomeUncertain: false });
    },
  );

  it('terminates synchronous infinite loops', async () => {
    const { directory, scriptPath } = await fixture('export function run() { while (true) {} }');
    const runner = new ComputerScriptRunner({
      client: client(),
      allowedScriptPaths: [],
      scriptRoot: directory,
      timeoutMs: 500,
    });
    await expect(runner.execute(scriptPath, {})).rejects.toThrow(/timed out|interrupted/u);
  });

  it('terminates excessive logging', async () => {
    const { directory, scriptPath } = await fixture("export function run({logger}) { logger.info('x'.repeat(4096)); }");
    const runner = new ComputerScriptRunner({
      client: client(),
      allowedScriptPaths: [],
      scriptRoot: directory,
      maxOutputBytes: 1024,
    });
    await expect(runner.execute(scriptPath, {})).rejects.toThrow(/output exceeded|message exceeds/u);
  });

  it('cancels in-flight work without starting the queued action or taking a final screenshot', async () => {
    const { directory, scriptPath } = await fixture(`export async function run({context:{program}}) {
      await Promise.all([program.act({kind:'press',snapshotId:'s',elementRef:'one'}), program.act({kind:'press',snapshotId:'s',elementRef:'two'})]);
    }`);
    const session = client();
    let release!: () => void;
    vi.mocked(session.act).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ applied: true });
        }),
    );
    const runner = new ComputerScriptRunner({ client: session, allowedScriptPaths: [], scriptRoot: directory });
    const controller = new AbortController();
    const result = runner.execute(scriptPath, {}, controller.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(session.act).toHaveBeenCalledOnce());
    controller.abort();
    const error = await result;
    expect(error).toBeInstanceOf(ComputerScriptExecutionError);
    expect(error).toMatchObject({ completedActions: 0, outcomeUncertain: true });
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.act).toHaveBeenCalledOnce();
    expect(session.observe).not.toHaveBeenCalled();
  });
});
