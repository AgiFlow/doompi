import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComputerScriptRunner } from '../../src/services/computerScriptRunner';
import type { ComputerUseSessionClient } from '../../src/services/sessionApiClient';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function script(source: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'doompi-computer-script-'));
  directories.push(directory);
  const scriptPath = path.join(directory, 'script.ts');
  await writeFile(scriptPath, source, 'utf8');
  return scriptPath;
}

const freshObservation = {
  runId: 'run-1',
  snapshotId: 'fresh',
  targetGeneration: 'target-1',
  applicationName: 'Test',
  bundleId: 'test.app',
  windowTitle: 'Test window',
  elements: [],
  screenshot: { mimeType: 'image/png' as const, data: '' },
};

function client(): ComputerUseSessionClient {
  return {
    state: vi.fn(),
    observe: vi.fn(async () => freshObservation),
    act: vi.fn(async () => ({ applied: true })),
    stop: vi.fn(),
  };
}

describe('ComputerScriptRunner', () => {
  it('runs an allowed typed script, serializes program calls, and returns a fresh observation', async () => {
    const scriptPath = await script(`
      interface Input { snapshotId: string }
      export async function run({ context: { program }, input, logger }: any) {
        const value = input as Input;
        logger.info('running');
        const results = await Promise.all([
          program.act({ kind: 'press', snapshotId: value.snapshotId, elementRef: 'one' }),
          program.act({ kind: 'press', snapshotId: value.snapshotId, elementRef: 'two' }),
        ]);
        return { count: results.length };
      }
    `);
    const session = client();
    let active = 0;
    let maximum = 0;
    vi.mocked(session.act).mockImplementation(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { applied: true };
    });
    const runner = new ComputerScriptRunner({ client: session, allowedScriptPaths: [scriptPath] });

    await expect(runner.execute(scriptPath, { snapshotId: 'snapshot-1' })).resolves.toEqual({
      result: { count: 2 },
      observation: freshObservation,
      logs: ['[info] running'],
    });
    expect(maximum).toBe(1);
    expect(session.act).toHaveBeenCalledTimes(2);
    expect(session.observe).toHaveBeenCalledOnce();
    expect(session.stop).not.toHaveBeenCalled();
  });

  it('rejects a path that was not explicitly allowed', async () => {
    const scriptPath = await script('export function run() {}');
    const runner = new ComputerScriptRunner({ client: client(), allowedScriptPaths: [] });
    await expect(runner.execute(scriptPath, {})).rejects.toThrow(/not explicitly allowed/u);
  });

  it('terminates a worker that exceeds its timeout', async () => {
    const scriptPath = await script('export async function run() { await new Promise(() => {}); }');
    const runner = new ComputerScriptRunner({ client: client(), allowedScriptPaths: [scriptPath], timeoutMs: 250 });
    await expect(runner.execute(scriptPath, {})).rejects.toThrow(/timed out/u);
  });

  it('terminates a worker whose output exceeds the bound', async () => {
    const scriptPath = await script("export function run() { console.log('x'.repeat(4096)); }");
    const runner = new ComputerScriptRunner({
      client: client(),
      allowedScriptPaths: [scriptPath],
      maxOutputBytes: 512,
    });
    await expect(runner.execute(scriptPath, {})).rejects.toThrow(/output exceeded/u);
  });
});
