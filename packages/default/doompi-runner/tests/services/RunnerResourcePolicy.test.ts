import { describe, expect, it } from 'vitest';

import { isHeavyCommand } from '../../src/services/bashRunService/resources';
import { noninteractiveEnvironment } from '../../src/services/runnerConfig';

describe('known heavy commands', () => {
  it.each([
    'pnpm test',
    'pnpm run test:unit',
    'npm run build',
    'npx vitest run',
    'pnpm --dir packages/example exec vitest run',
    'pnpm --filter @scope/example test',
    'NX_DAEMON=false pnpm nx run @scope/example:typecheck',
    'cd /workspace && pnpm nx run-many -t build,test --parallel=2',
    'tsc --noEmit',
    'env pnpm build',
  ])('budgets %s', (command) => expect(isHeavyCommand(command)).toBe(true));

  it.each([
    'git status --short',
    'rg test src',
    'echo "pnpm test"',
    'pnpm nx show project test',
    'pnpm nx graph',
    'pnpm exec vitest --help',
    'node server.mjs',
    'pnpm dev',
  ])('does not budget %s', (command) => expect(isHeavyCommand(command)).toBe(false));
});

describe('noninteractive process defaults', () => {
  it('disables nested Nx terminal handling and bounds default parallelism', () => {
    expect(noninteractiveEnvironment({})).toEqual({
      NX_NATIVE_COMMAND_RUNNER: 'false',
      NX_TUI: 'false',
      NX_PARALLEL: '2',
      VITEST_MAX_WORKERS: '2',
    });
  });

  it('preserves explicit settings without mutating the admitted environment', () => {
    const environment = Object.freeze({
      NX_TUI: 'true',
      NX_PARALLEL: '1',
      VITEST_MAX_WORKERS: '4',
      NX_NATIVE_COMMAND_RUNNER: 'true',
      OTHER: 'unchanged',
    });
    expect(noninteractiveEnvironment(environment)).toEqual({
      NX_TUI: 'true',
      NX_PARALLEL: '1',
      VITEST_MAX_WORKERS: '4',
      NX_NATIVE_COMMAND_RUNNER: 'true',
    });
    expect(environment.OTHER).toBe('unchanged');
  });
});
