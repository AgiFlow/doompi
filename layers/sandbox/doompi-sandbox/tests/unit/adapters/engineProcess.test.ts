import { describe, expect, it } from 'vitest';
import { SpawnEngineProcessRunner } from '../../../src/adapters/engineProcess.ts';

const runner = new SpawnEngineProcessRunner();
const node = process.execPath;
const MISSING_BINARY = 'doompi-sandbox-missing-binary';

describe('SpawnEngineProcessRunner', () => {
  it('runs a command and reports its exit code', async () => {
    await expect(runner.run(node, ['-e', 'process.exit(3)'])).resolves.toBe(3);
  });

  it('pipes provided input to stdin instead of the terminal', async () => {
    const script = 'let d="";process.stdin.on("data",(c)=>{d+=c}).on("end",()=>process.exit(d==="dockerfile"?0:9))';

    await expect(runner.run(node, ['-e', script], { input: 'dockerfile' })).resolves.toBe(0);
  });

  it('rejects when the command cannot spawn', async () => {
    await expect(runner.run(MISSING_BINARY, [])).rejects.toThrowError();
  });

  it('captures stdout together with the exit code', async () => {
    await expect(runner.capture(node, ['-e', 'process.stdout.write("v1.2")'])).resolves.toEqual({
      exitCode: 0,
      stdout: 'v1.2',
    });
  });

  it('captures a probe failure as its exit code', async () => {
    await expect(runner.capture(node, ['-e', 'process.exit(125)'])).resolves.toEqual({ exitCode: 125, stdout: '' });
  });

  it('answers undefined for an unspawnable probe', async () => {
    await expect(runner.capture(MISSING_BINARY, [])).resolves.toBeUndefined();
  });
});
