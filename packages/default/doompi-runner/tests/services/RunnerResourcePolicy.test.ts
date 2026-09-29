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
    'pnpm exec nx fixcode example',
    'pnpm exec playwright test',
    'pnpm exec oxlint src',
    './node_modules/.bin/nx build example',
    '"/workspace with spaces/node_modules/.bin/nx" run example:build',
    'pnpm --filter=@scope/example run build',
    'env CI=1 command pnpm exec nx run-many --targets=build,test-unit',
    'pnpm exec nx run-many -t=fixcode',
    'pnpm exec vite build',
    'node tools/scripts/build.mjs',
    'node node_modules/vitest/vitest.mjs run',
    'python -m pytest tests',
    'cargo test',
    'bun tools/scripts/dev.ts agiflow api,app,mcp',
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
    'pnpm exec playwright --help',
    'pnpm exec nx show project build --json',
    './node_modules/.bin/nx show project build',
    'node tools/scripts/read-logs.mjs',
    'echo "build && pnpm test"',
    'git log --format="test; pnpm build"',
  ])('does not budget %s', (command) => expect(isHeavyCommand(command)).toBe(false));
});

describe('noninteractive process defaults', () => {
  it('disables nested Nx terminal handling and bounds default parallelism', () => {
    expect(noninteractiveEnvironment({})).toEqual({
      NX_NATIVE_COMMAND_RUNNER: 'false',
      DOOM_RUNNER_MAX_WORKERS: '2',
      PLAYWRIGHT_WORKERS: '1',
      NX_TUI: 'false',
      NX_PARALLEL: '1',
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
      DOOM_RUNNER_MAX_WORKERS: '2',
      PLAYWRIGHT_WORKERS: '1',
      NX_TUI: 'true',
      NX_PARALLEL: '1',
      VITEST_MAX_WORKERS: '4',
      NX_NATIVE_COMMAND_RUNNER: 'true',
    });
    expect(environment.OTHER).toBe('unchanged');
  });
});
