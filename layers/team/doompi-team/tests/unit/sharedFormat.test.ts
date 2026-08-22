import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  formatDuration,
  formatModelThinking,
  formatTokens,
  formatToolCall,
  formatUsage,
  shortenPath,
} from '../../src/adapters/pi/tui/formatters';
import {
  findModelInfo,
  getSupportedThinkingLevels,
  type ModelInfo,
  resolveEffectiveThinking,
  splitKnownThinkingSuffix,
  THINKING_LEVELS,
  toModelInfo,
} from '../../src/services/models/modelInfo';
import type { Usage } from '../../src/types';

const temporaryDirs: string[] = [];

/** A fully populated usage record; individual cases zero out what they are not exercising. */
function usage(overrides: Partial<Usage> = {}): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, ...overrides };
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('formatTokens', () => {
  it('leaves counts below a thousand exact', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('switches to one decimal at the first thousand', () => {
    expect(formatTokens(1000)).toBe('1.0k');
    expect(formatTokens(1540)).toBe('1.5k');
  });

  it('drops the decimal once the count no longer needs the precision', () => {
    // 10000 is the boundary where the fractional form is abandoned; rounding at
    // 9999 still produces "10.0k", which is why the boundary is inclusive-above.
    expect(formatTokens(9999)).toBe('10.0k');
    expect(formatTokens(10000)).toBe('10k');
    expect(formatTokens(10500)).toBe('11k');
  });
});

describe('formatModelThinking', () => {
  it('is empty when there is nothing to show', () => {
    expect(formatModelThinking()).toBe('');
    expect(formatModelThinking('')).toBe('');
  });

  it('shows only the last path segment so a provider prefix does not eat the row', () => {
    expect(formatModelThinking('anthropic/claude-opus-5')).toBe('claude-opus-5');
  });

  it('keeps a model id that merely contains a colon intact', () => {
    // `:free` is not a thinking level, so it must stay part of the id rather
    // than being parsed off as a thinking request.
    expect(formatModelThinking('openrouter/vendor:free')).toBe('vendor:free');
  });

  it('splits a known thinking suffix off the model', () => {
    expect(formatModelThinking('anthropic/claude-opus-5:high')).toBe('claude-opus-5 · thinking high');
  });

  it('lets the suffix win over the separately configured level', () => {
    expect(formatModelThinking('gpt-5:off', 'high')).toBe('gpt-5 · thinking off');
  });

  it('uses the configured level when the model carries no suffix', () => {
    expect(formatModelThinking('gpt-5', 'medium')).toBe('gpt-5 · thinking medium');
  });

  it('trims the configured level before matching', () => {
    expect(formatModelThinking('gpt-5', '  low  ')).toBe('gpt-5 · thinking low');
  });

  it('ignores a level that is not a known thinking level', () => {
    expect(formatModelThinking('gpt-5', 'turbo')).toBe('gpt-5');
  });

  it('still renders a thinking level when no model was given', () => {
    expect(formatModelThinking(undefined, 'high')).toBe('thinking high');
  });
});

describe('formatUsage', () => {
  it('is empty when nothing was consumed', () => {
    expect(formatUsage(usage())).toBe('');
  });

  it('singularises a lone turn', () => {
    expect(formatUsage(usage({ turns: 1 }))).toBe('1 turn');
    expect(formatUsage(usage({ turns: 2 }))).toBe('2 turns');
  });

  it('emits every populated field in order', () => {
    const formatted = formatUsage(
      usage({ turns: 3, input: 1200, output: 400, cacheRead: 5000, cacheWrite: 250, cost: 0.123456 }),
      'claude',
    );
    expect(formatted).toBe('3 turns in:1.2k out:400 R5.0k W250 $0.1235 claude');
  });

  it('omits zeroed fields rather than printing noise', () => {
    expect(formatUsage(usage({ input: 10 }))).toBe('in:10');
  });

  it('appends the model only when one is supplied', () => {
    expect(formatUsage(usage({ input: 10 }), 'gpt-5')).toBe('in:10 gpt-5');
  });
});

describe('formatDuration', () => {
  it('reports sub-second work in milliseconds', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('reports seconds with one decimal up to a minute', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(59999)).toBe('60.0s');
  });

  it('reports minutes and whole seconds past a minute', () => {
    expect(formatDuration(60000)).toBe('1m0s');
    expect(formatDuration(90500)).toBe('1m30s');
    expect(formatDuration(3661000)).toBe('61m1s');
  });
});

describe('formatToolCall', () => {
  it('renders a bash call as a shell prompt', () => {
    expect(formatToolCall('bash', { command: 'ls -la' })).toBe('$ ls -la');
  });

  it('tolerates a bash call with no command', () => {
    expect(formatToolCall('bash', {})).toBe('$ ');
  });

  it('truncates a long command to the narrow limit and widens when expanded', () => {
    const command = 'x'.repeat(300);
    expect(formatToolCall('bash', { command })).toBe(`$ ${'x'.repeat(60)}...`);
    expect(formatToolCall('bash', { command }, true)).toBe(`$ ${'x'.repeat(240)}...`);
  });

  it('does not append an ellipsis at exactly the limit', () => {
    const command = 'x'.repeat(60);
    expect(formatToolCall('bash', { command })).toBe(`$ ${command}`);
  });

  it('reads the file target from either argument spelling', () => {
    expect(formatToolCall('read', { path: '/a/b.ts' })).toBe('read /a/b.ts');
    expect(formatToolCall('write', { file_path: '/a/b.ts' })).toBe('write /a/b.ts');
    expect(formatToolCall('edit', {})).toBe('edit ');
  });

  it('prefers path over file_path when both are present', () => {
    expect(formatToolCall('read', { path: '/from-path', file_path: '/from-file-path' })).toBe('read /from-path');
  });

  it('ignores a non-string file target', () => {
    expect(formatToolCall('read', { path: 42, file_path: '/fallback' })).toBe('read /fallback');
  });

  it('falls back to serialised args for an unknown tool', () => {
    expect(formatToolCall('grep', {})).toBe('grep {}');
    expect(formatToolCall('grep', { pattern: 'todo' })).toBe('grep {"pattern":"todo"}');
  });

  it('truncates serialised args at the narrow limit and widens when expanded', () => {
    const args = { value: 'y'.repeat(300) };
    const serialised = JSON.stringify(args);
    expect(formatToolCall('grep', args)).toBe(`grep ${serialised.slice(0, 40)}...`);
    expect(formatToolCall('grep', args, true)).toBe(`grep ${serialised.slice(0, 160)}...`);
  });
});

describe('shortenPath', () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('replaces the home prefix', () => {
    process.env.HOME = '/Users/ada';
    expect(shortenPath('/Users/ada/code/app.ts')).toBe('~/code/app.ts');
  });

  it('leaves a path outside home untouched', () => {
    process.env.HOME = '/Users/ada';
    expect(shortenPath('/opt/tool')).toBe('/opt/tool');
  });

  it('leaves the path untouched when HOME is unset', () => {
    delete process.env.HOME;
    expect(shortenPath('/Users/ada/code')).toBe('/Users/ada/code');
  });
});

describe('toModelInfo', () => {
  it('composes the full id from provider and id', () => {
    expect(toModelInfo({ provider: 'anthropic', id: 'claude-opus-5' })).toEqual({
      provider: 'anthropic',
      id: 'claude-opus-5',
      fullId: 'anthropic/claude-opus-5',
      api: undefined,
      reasoning: undefined,
      thinkingLevelMap: undefined,
    });
  });

  it('carries the optional capability fields through', () => {
    const info = toModelInfo({
      provider: 'openai',
      id: 'gpt-5',
      api: 'responses',
      reasoning: true,
      thinkingLevelMap: { high: 'high' },
    });
    expect(info).toMatchObject({ api: 'responses', reasoning: true, thinkingLevelMap: { high: 'high' } });
  });
});

describe('splitKnownThinkingSuffix', () => {
  it('returns the model unchanged when there is no colon', () => {
    expect(splitKnownThinkingSuffix('gpt-5')).toEqual({ baseModel: 'gpt-5', thinkingSuffix: '' });
  });

  it('splits every known level', () => {
    for (const level of THINKING_LEVELS) {
      expect(splitKnownThinkingSuffix(`gpt-5:${level}`)).toEqual({
        baseModel: 'gpt-5',
        thinkingSuffix: `:${level}`,
      });
    }
  });

  it('leaves an unknown suffix attached to the model', () => {
    expect(splitKnownThinkingSuffix('openrouter/vendor:free')).toEqual({
      baseModel: 'openrouter/vendor:free',
      thinkingSuffix: '',
    });
  });

  it('splits on the last colon so a colon in the id survives', () => {
    expect(splitKnownThinkingSuffix('openrouter/vendor:free:high')).toEqual({
      baseModel: 'openrouter/vendor:free',
      thinkingSuffix: ':high',
    });
  });
});

describe('resolveEffectiveThinking', () => {
  it('has nothing to resolve without a model', () => {
    expect(resolveEffectiveThinking(undefined, 'high')).toBeUndefined();
  });

  it('prefers the suffix over the config', () => {
    expect(resolveEffectiveThinking('gpt-5:low', 'high')).toBe('low');
  });

  it('falls back to the config when the model has no suffix', () => {
    expect(resolveEffectiveThinking('gpt-5', 'high')).toBe('high');
  });

  it('treats a disabled or unknown config as no thinking', () => {
    expect(resolveEffectiveThinking('gpt-5', false)).toBeUndefined();
    expect(resolveEffectiveThinking('gpt-5', undefined)).toBeUndefined();
    expect(resolveEffectiveThinking('gpt-5', 'turbo')).toBeUndefined();
  });
});

describe('findModelInfo', () => {
  const models: ModelInfo[] = [
    { provider: 'anthropic', id: 'claude-opus-5', fullId: 'anthropic/claude-opus-5' },
    { provider: 'openai', id: 'gpt-5', fullId: 'openai/gpt-5' },
    { provider: 'azure', id: 'gpt-5', fullId: 'azure/gpt-5' },
    { provider: 'openai', id: 'o3', fullId: 'openai/o3' },
  ];

  it('has nothing to find without a model or a registry', () => {
    expect(findModelInfo(undefined, models)).toBeUndefined();
    expect(findModelInfo('gpt-5', undefined)).toBeUndefined();
    expect(findModelInfo('gpt-5', [])).toBeUndefined();
  });

  it('matches the fully qualified id', () => {
    expect(findModelInfo('openai/gpt-5', models)?.provider).toBe('openai');
  });

  it('strips a thinking suffix before matching', () => {
    expect(findModelInfo('openai/gpt-5:high', models)?.fullId).toBe('openai/gpt-5');
  });

  it('resolves a bare id when exactly one provider offers it', () => {
    expect(findModelInfo('o3', models)?.fullId).toBe('openai/o3');
  });

  it('refuses to guess when a bare id is offered by several providers', () => {
    expect(findModelInfo('gpt-5', models)).toBeUndefined();
  });

  it('uses the preferred provider to break the ambiguity', () => {
    expect(findModelInfo('gpt-5', models, 'azure')?.fullId).toBe('azure/gpt-5');
  });

  it('ignores a preferred provider that does not offer the id', () => {
    // Still ambiguous, so nothing is returned rather than an arbitrary pick.
    expect(findModelInfo('gpt-5', models, 'anthropic')).toBeUndefined();
    expect(findModelInfo('o3', models, 'anthropic')?.fullId).toBe('openai/o3');
  });

  it('returns nothing for an id no provider offers', () => {
    expect(findModelInfo('nonexistent', models)).toBeUndefined();
  });
});

describe('getSupportedThinkingLevels', () => {
  it('offers the standard set when the model is unknown', () => {
    // `max` is opt-in only, so an unknown model must not advertise it.
    expect(getSupportedThinkingLevels(undefined)).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  });

  it('offers only off when the model cannot reason', () => {
    expect(getSupportedThinkingLevels({ provider: 'p', id: 'm', fullId: 'p/m', reasoning: false })).toEqual(['off']);
  });

  it('treats a missing map as unknown rather than as no thinking', () => {
    expect(getSupportedThinkingLevels({ provider: 'p', id: 'm', fullId: 'p/m', reasoning: true })).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });

  it('drops a level the map explicitly nulls out', () => {
    const levels = getSupportedThinkingLevels({
      provider: 'p',
      id: 'm',
      fullId: 'p/m',
      thinkingLevelMap: { off: null, high: 'high' },
    });
    expect(levels).toEqual(['minimal', 'low', 'medium', 'high']);
  });

  it('includes the extended levels only when the map maps them', () => {
    const levels = getSupportedThinkingLevels({
      provider: 'p',
      id: 'm',
      fullId: 'p/m',
      thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
    });
    expect(levels).toContain('xhigh');
    expect(levels).toContain('max');
  });

  it('drops an extended level the map nulls out', () => {
    const levels = getSupportedThinkingLevels({
      provider: 'p',
      id: 'm',
      fullId: 'p/m',
      thinkingLevelMap: { xhigh: null, max: 'max' },
    });
    expect(levels).not.toContain('xhigh');
    expect(levels).toContain('max');
  });
});
