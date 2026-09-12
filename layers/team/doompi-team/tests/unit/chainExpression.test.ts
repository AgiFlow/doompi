import { describe, expect, it } from 'vitest';
import {
  DeprecatedBackgroundFlagError,
  extractForkFlag,
  parseAgentToken,
  parseInlineConfig,
  parseSingleTaskToken,
} from '../../src/adapters/pi/commands/slash/chainExpression.ts';

describe('Team slash argument parsing', () => {
  it('parses supported inline settings and ignores unknown or empty fields', () => {
    expect(
      parseInlineConfig(
        ' , progress, output=false, outputMode=file-only, reads=a++b, skills=one+two, model=m, as=x, label=l, phase=p, cwd=/tmp, count=2, outputSchema={}, acceptance=done, unknown=value',
      ),
    ).toEqual({
      progress: true,
      output: false,
      outputMode: 'file-only',
      reads: ['a', 'b'],
      skill: ['one', 'two'],
      model: 'm',
      as: 'x',
      label: 'l',
      phase: 'p',
      cwd: '/tmp',
      count: 2,
      outputSchema: '{}',
      acceptance: 'done',
    });
  });

  it('handles disabled, empty, and invalid inline values', () => {
    expect(
      parseInlineConfig(
        'output=log,outputMode=unknown,reads=false,skill=false,progress=false,model=,as=,label=,phase=,cwd=,count=0,outputSchema=,acceptance=',
      ),
    ).toEqual({
      output: 'log',
      reads: false,
      skill: false,
      progress: false,
      model: undefined,
      as: undefined,
      label: undefined,
      phase: undefined,
      cwd: undefined,
      outputSchema: undefined,
      acceptance: undefined,
    });
    expect(parseInlineConfig('count=1.5,count=no,outputMode=inline,skill=x++y')).toEqual({
      outputMode: 'inline',
      skill: ['x', 'y'],
    });
  });

  it('separates agent names, inline config, and quoted or dash-delimited tasks', () => {
    expect(parseAgentToken('writer')).toEqual({ name: 'writer', config: {} });
    expect(parseAgentToken('writer[count=2')).toEqual({ name: 'writer', config: { count: 2 } });
    expect(parseSingleTaskToken('writer[progress] "write report"')).toEqual({
      kind: 'step',
      name: 'writer',
      config: { progress: true },
      task: 'write report',
    });
    expect(parseSingleTaskToken("writer 'write report'")).toEqual({
      kind: 'step',
      name: 'writer',
      config: {},
      task: 'write report',
    });
    expect(parseSingleTaskToken('writer -- write report')).toEqual({
      kind: 'step',
      name: 'writer',
      config: {},
      task: 'write report',
    });
    expect(parseSingleTaskToken('writer -- ')).toEqual({ kind: 'step', name: 'writer', config: {}, task: undefined });
  });

  it('extracts repeated fork flags and rejects obsolete background flags', () => {
    expect(extractForkFlag(' writer --fork --fork ')).toEqual({ args: 'writer', fork: true });
    expect(extractForkFlag('writer')).toEqual({ args: 'writer', fork: false });
    expect(extractForkFlag('--fork')).toEqual({ args: '', fork: true });
    expect(() => extractForkFlag('writer --bg')).toThrow(DeprecatedBackgroundFlagError);
    expect(() => extractForkFlag('writer --async')).toThrow("'--async' is no longer needed");
  });
});
