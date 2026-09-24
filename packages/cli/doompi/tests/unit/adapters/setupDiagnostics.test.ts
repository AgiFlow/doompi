import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { collectDoctorReport, runDoctor } from '../../../src/cli/commands/doctor';
import { createSetupDiagnosticsTool } from '../../../src/extensions/setupDiagnostics';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'doom-help-setup-'));
  directories.push(root);
  const home = path.join(root, 'home');
  const repoRoot = path.join(root, 'repo');
  await mkdir(home);
  await mkdir(path.join(repoRoot, '.doom'), { recursive: true });
  const scope = {
    cwd: repoRoot,
    repoRoot,
    environment: { HOME: home, DOOMPI_ROOT: repoRoot },
    selection: { majorMode: 'copilot', domains: ['development'], profile: 'test' },
  };
  const tool = createSetupDiagnosticsTool(
    () => scope,
    (signal) => signal ?? new AbortController().signal,
  );
  const execute = () => tool.execute({}, { cwd: repoRoot, toolCallId: 'setup', notify() {}, update() {} });
  return { scope, tool, execute };
}

describe('read-only setup diagnostics', () => {
  it.each(['config.yaml', 'modes.yaml', 'domains.yaml', 'profiles.yaml'])(
    'reports invalid %s without exposing values or changing files',
    async (filename) => {
      const { scope, execute } = await fixture();
      const file = path.join(scope.repoRoot, '.doom', filename);
      const secret = 'broken: [secret-test-value';
      await writeFile(file, secret);
      const before = await readdir(scope.repoRoot, { recursive: true });
      const result = await execute();
      const report = result.details as {
        status: string;
        checks: { area: string; status: string }[];
        skipped: string[];
        appliedSelection: unknown;
      };
      expect(report.status).toBe('issues-found');
      expect(report.checks.find((check) => check.area === filename)?.status).toBe('failed');
      expect(report.skipped).toEqual(['packages', 'sync state', 'drift']);
      expect(report.appliedSelection).toEqual(scope.selection);
      expect(JSON.stringify(result)).not.toContain('secret-test-value');
      expect(await readFile(file, 'utf8')).toBe(secret);
      expect(await readdir(scope.repoRoot, { recursive: true })).toEqual(before);
    },
  );

  it('shares the exact checks with the doctor CLI and retains its exit behavior', async () => {
    const { scope } = await fixture();
    await writeFile(path.join(scope.repoRoot, '.doom', 'config.yaml'), 'unexpectedHelpKey: true\n');
    const report = collectDoctorReport(scope.environment, scope.cwd);
    let output = '';
    const code = runDoctor(['doctor'], scope.environment, scope.cwd, {
      write(chunk) {
        output += chunk;
      },
    });
    expect(report.problems).toBeGreaterThan(0);
    expect(code).toBe(1);
    expect(output).toContain('config.yaml');
    expect(output).toContain('FAILED');
    expect(report.repoRoot).toBe(scope.repoRoot);
    expect(report.homeDirectory).toBe(scope.environment.HOME);
  });

  it('honors cancellation before reading configuration', async () => {
    const { scope } = await fixture();
    const controller = new AbortController();
    controller.abort(new Error('Help revoked'));
    const tool = createSetupDiagnosticsTool(
      () => {
        throw new Error('must not read scope');
      },
      () => {
        controller.signal.throwIfAborted();
        return controller.signal;
      },
    );
    await expect(
      tool.execute({}, { cwd: scope.cwd, toolCallId: 'cancelled', notify() {}, update() {} }),
    ).rejects.toThrow('Help revoked');
  });
});
