import { describe, expect, it } from 'vitest';

import { runtimeBinaryEnvVar } from '../../src/exports/env';
import {
  DEFAULT_RUNTIMES,
  isPiRuntime,
  resolveRuntimeLaunch,
  resolveRuntimeTable,
} from '../../src/adapters/runs/shared/runtimeRegistry';

const values = { prompt: 'do the thing', cwd: '/work' };

describe('isPiRuntime', () => {
  it('treats an unset runtime as the in-process default, so existing callers keep working', () => {
    expect(isPiRuntime(undefined)).toBe(true);
    expect(isPiRuntime('pi')).toBe(true);
  });

  it('treats every configured CLI as external', () => {
    expect(isPiRuntime('claude')).toBe(false);
    expect(isPiRuntime('antigravity')).toBe(false);
  });
});

describe('resolveRuntimeTable', () => {
  it('ships claude and antigravity without any configuration', () => {
    expect(Object.keys(resolveRuntimeTable(undefined)).sort()).toEqual(['antigravity', 'claude']);
  });

  it('lets config override a shipped entry and add new ones', () => {
    const table = resolveRuntimeTable({
      claude: { command: '/opt/claude', args: ['--print', '{prompt}'] },
      custom: { command: 'my-agent', args: ['{prompt}'] },
    });
    expect(table.claude).toEqual({ command: '/opt/claude', args: ['--print', '{prompt}'] });
    expect(table.custom.command).toBe('my-agent');
    expect(table.antigravity).toEqual(DEFAULT_RUNTIMES.antigravity);
  });

  it('does not mutate the shipped defaults when config overrides one', () => {
    resolveRuntimeTable({ claude: { command: 'x', args: [] } });
    expect(DEFAULT_RUNTIMES.claude.command).toBe('claude');
  });
});

describe('resolveRuntimeLaunch', () => {
  const table = resolveRuntimeTable(undefined);

  it('substitutes the prompt into the argv template', () => {
    const launch = resolveRuntimeLaunch('claude', table, values, {});
    expect(launch).toEqual({ runtime: 'claude', command: 'claude', args: ['-p', 'do the thing'] });
  });

  it('names the configured runtimes when asked for one that does not exist', () => {
    expect(() => resolveRuntimeLaunch('gpt', table, values, {})).toThrow(
      /Unknown subagent runtime 'gpt'.*antigravity, claude/,
    );
  });

  it('prefers a per-runtime binary override from the environment', () => {
    const env = { [runtimeBinaryEnvVar('claude')]: '/custom/bin/claude' };
    expect(resolveRuntimeLaunch('claude', table, values, env).command).toBe('/custom/bin/claude');
  });

  it('ignores a blank override rather than spawning an empty command', () => {
    const env = { [runtimeBinaryEnvVar('claude')]: '   ' };
    expect(resolveRuntimeLaunch('claude', table, values, env).command).toBe('claude');
  });

  it('drops an argument that reduces to nothing, so a flag never arrives bare', () => {
    const withModel = resolveRuntimeTable({ x: { command: 'x', args: ['--model', '{model}', '{prompt}'] } });
    // No model override: `--model` would otherwise be passed with no value.
    expect(resolveRuntimeLaunch('x', withModel, values, {}).args).toEqual(['--model', 'do the thing']);
    expect(resolveRuntimeLaunch('x', withModel, { ...values, model: 'opus' }, {}).args).toEqual([
      '--model',
      'opus',
      'do the thing',
    ]);
  });

  it('substitutes cwd, so a template can pass the working directory explicitly', () => {
    const table2 = resolveRuntimeTable({ x: { command: 'x', args: ['--cwd', '{cwd}'] } });
    expect(resolveRuntimeLaunch('x', table2, values, {}).args).toEqual(['--cwd', '/work']);
  });
});

describe('runtimeBinaryEnvVar', () => {
  it('produces a legal environment variable name from any legal runtime name', () => {
    expect(runtimeBinaryEnvVar('claude')).toBe('DOOM_TEAM_CLAUDE_BIN');
    expect(runtimeBinaryEnvVar('my-agent.v2')).toBe('DOOM_TEAM_MY_AGENT_V2_BIN');
  });
});
