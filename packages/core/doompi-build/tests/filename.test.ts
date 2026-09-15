import { describe, expect, it } from 'vitest';

import { parseFilename } from '../src/services/filename';

const BACKEND = ['cli', 'server'];
const FRONTEND = ['web', 'ios', 'android', 'desktop'];

describe('parseFilename', () => {
  it('reads a neutral file as name only', () => {
    expect(parseFilename('write-plan.ts', BACKEND)).toEqual({
      name: 'write-plan',
      target: undefined,
      platform: undefined,
      extension: 'ts',
    });
  });

  it('reads the last segment as a platform when it names one for this side', () => {
    expect(parseFilename('write-plan.cli.ts', BACKEND)?.platform).toBe('cli');
    expect(parseFilename('write-plan.web.tsx', FRONTEND)?.platform).toBe('web');
  });

  it('leaves a platform of the other side as a target, since sides have separate namespaces', () => {
    expect(parseFilename('write-plan.cli.ts', FRONTEND)).toEqual({
      name: 'write-plan',
      target: 'cli',
      platform: undefined,
      extension: 'ts',
    });
  });

  it('keeps a dotted target whole by parsing right to left', () => {
    expect(parseFilename('PlanRef.task.detail.tsx', FRONTEND)).toEqual({
      name: 'PlanRef',
      target: 'task.detail',
      platform: undefined,
      extension: 'tsx',
    });
    expect(parseFilename('PlanRef.task.detail.web.tsx', FRONTEND)).toEqual({
      name: 'PlanRef',
      target: 'task.detail',
      platform: 'web',
      extension: 'tsx',
    });
  });

  it('rejects a non-source extension', () => {
    expect(parseFilename('README.md', BACKEND)).toBeUndefined();
    expect(parseFilename('payload.json', BACKEND)).toBeUndefined();
  });

  it('rejects an excluded infix wherever it sits', () => {
    expect(parseFilename('write-plan.test.ts', BACKEND)).toBeUndefined();
    expect(parseFilename('write-plan.spec.ts', BACKEND)).toBeUndefined();
    expect(parseFilename('PlanPanel.stories.tsx', FRONTEND)).toBeUndefined();
  });

  it('rejects a dotfile and an extensionless name', () => {
    expect(parseFilename('.gitignore', BACKEND)).toBeUndefined();
    expect(parseFilename('LICENSE', BACKEND)).toBeUndefined();
  });

  it('accepts every source extension', () => {
    for (const extension of ['ts', 'tsx', 'mts', 'cts']) {
      expect(parseFilename(`thing.${extension}`, BACKEND)?.extension).toBe(extension);
    }
  });
});
