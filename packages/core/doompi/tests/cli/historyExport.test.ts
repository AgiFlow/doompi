import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryExportCommand } from '../../src/commands/historyExportCommand.ts';
import { CliApp } from '../../src/commands/cli/cliApp.ts';

function v4Source(): string {
  return `${JSON.stringify({
    v: 4,
    kind: 'header',
    id: 'session',
    storageVersion: 1,
    createdAt: 0,
    cwd: '/workspace',
  })}\n`;
}

describe('history-export CLI', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-history-cli-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    [[], 'requires a v4 source'],
    [['source.jsonl'], 'requires a v4 source'],
    [['--'], 'passthrough'],
    [['--unknown'], 'does not accept'],
    [['--source'], 'requires a value'],
    [['--source='], 'requires a value'],
    [['--source', 'a', '--source-path=b'], 'more than once'],
    [['a', 'b', 'extra'], 'Unexpected history-export argument'],
  ])('rejects invalid paths without writing files: %j', async (args, error) => {
    const output = { write: vi.fn() };
    await expect(new HistoryExportCommand().execute(['history-export', ...args], {}, root, output)).rejects.toThrow(
      error,
    );
    expect(fs.readdirSync(root)).toEqual([]);
    expect(output.write).not.toHaveBeenCalled();
  });

  it.each([false, true])('honors explicit sidecar paths (long aliases: %s)', async (long) => {
    fs.writeFileSync(path.join(root, 'source.jsonl'), v4Source());
    const suffix = long ? '-path' : '';
    const output = { write: vi.fn() };
    const command = new HistoryExportCommand();
    expect(command.matches(['history-export'])).toBe(true);
    expect(command.matches(['history-import'])).toBe(false);
    await expect(
      command.execute(
        [
          'history-export',
          `--source${suffix}=source.jsonl`,
          `--destination${suffix}`,
          'derived.jsonl',
          `--report${suffix}=losses.json`,
          `--state${suffix}`,
          'state.json',
        ],
        {},
        root,
        output,
      ),
    ).resolves.toBe(0);
    const result = JSON.parse(output.write.mock.calls[0]![0]);
    expect(result).toMatchObject({
      reportPath: path.join(root, 'losses.json'),
      statePath: path.join(root, 'state.json'),
    });
    expect(fs.existsSync(result.reportPath)).toBe(true);
    expect(fs.existsSync(result.statePath)).toBe(true);
    expect(fs.readFileSync(path.join(root, 'source.jsonl'), 'utf8')).toBe(v4Source());
  });

  it('exports only v4 input to distinct v3 output and reports the result', async () => {
    fs.writeFileSync(path.join(root, 'source.jsonl'), v4Source());
    const output = { write: vi.fn() };
    const command = new HistoryExportCommand();

    await expect(command.execute(['history-export', 'source.jsonl', 'derived.jsonl'], {}, root, output)).resolves.toBe(
      0,
    );

    const result = JSON.parse(output.write.mock.calls[0]![0] as string) as {
      destinationPath: string;
      reportPath: string;
      lossCount: number;
    };
    expect(result.destinationPath).toBe(path.join(root, 'derived.jsonl'));
    expect(result.lossCount).toBe(0);
    expect(JSON.parse(fs.readFileSync(result.reportPath, 'utf8'))).toMatchObject({
      format: 'doompi-v4-to-v3-loss-report',
      sourcePath: path.join(root, 'source.jsonl'),
    });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'derived.jsonl'), 'utf8'))).toMatchObject({
      type: 'session',
      version: 3,
    });
  });

  it('does not overwrite an existing continued export', async () => {
    fs.writeFileSync(path.join(root, 'source.jsonl'), v4Source());
    const destinationPath = path.join(root, 'derived.jsonl');
    fs.writeFileSync(destinationPath, 'unrelated');

    await expect(
      new HistoryExportCommand().execute(['history-export', 'source.jsonl', 'derived.jsonl'], {}, root),
    ).rejects.toThrow(/overwrite|existing/i);
    expect(fs.readFileSync(destinationPath, 'utf8')).toBe('unrelated');
  });

  it('registers history-export without preparing the harness and serves command help', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(new CliApp().run(['history-export', '--help'])).resolves.toBe(0);
    expect(write.mock.calls.flat().join('')).toContain('Usage: doompi history-export');
  });
});
