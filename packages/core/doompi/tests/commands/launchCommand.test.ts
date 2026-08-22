import { describe, expect, it } from 'vitest';
import {
  buildVibeLintPiArgs,
  ensureElicitationSessionId,
  formatVibeLintResponse,
  overridePiThemes,
  parseVibeLintInvocation,
} from '../../src/commands/launchCommand.ts';

describe('doompi launch identity', () => {
  it('creates one stable elicitation session ID when the caller did not provide one', () => {
    const environment: NodeJS.ProcessEnv = {};

    const generated = ensureElicitationSessionId(environment);

    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    expect(environment.ELICITATION_SESSION_ID).toBe(generated);
    expect(ensureElicitationSessionId(environment)).toBe(generated);
  });

  it('preserves an elicitation session ID supplied by the caller', () => {
    const environment: NodeJS.ProcessEnv = { ELICITATION_SESSION_ID: 'upstream-session' };

    expect(ensureElicitationSessionId(environment)).toBe('upstream-session');
    expect(environment.ELICITATION_SESSION_ID).toBe('upstream-session');
  });
});

describe('vibe-lint launch protocol', () => {
  it('parses the script-provider invocation envelope', () => {
    expect(
      parseVibeLintInvocation(
        JSON.stringify({
          prompt: 'Review this file',
          systemPrompt: 'Return violations as JSON',
          maxTokens: 4000,
          screenshotPaths: ['/tmp/screenshot.png'],
        }),
      ),
    ).toEqual({
      prompt: 'Review this file',
      systemPrompt: 'Return violations as JSON',
      maxTokens: 4000,
      screenshotPaths: ['/tmp/screenshot.png'],
    });
  });

  it('rejects invalid invocation envelopes', () => {
    expect(() => parseVibeLintInvocation('not json')).toThrow('Expected a JSON vibe-lint invocation on stdin');
    expect(() => parseVibeLintInvocation(JSON.stringify({ prompt: 'review' }))).toThrow(
      'requires string prompt and systemPrompt fields',
    );
    expect(() =>
      parseVibeLintInvocation(JSON.stringify({ prompt: 'review', systemPrompt: 'format', screenshotPaths: [42] })),
    ).toThrow('screenshotPaths field must be an array of strings');
  });

  it('builds a one-shot Pi invocation with images and an ephemeral session', () => {
    expect(
      buildVibeLintPiArgs(['--thinking', 'minimal'], {
        prompt: 'Review this file',
        systemPrompt: 'Return violations as JSON',
        screenshotPaths: ['/tmp/screenshot.png'],
      }),
    ).toEqual([
      '--thinking',
      'minimal',
      '--print',
      '--approve',
      '--no-session',
      '--system-prompt',
      'Return violations as JSON',
      '@/tmp/screenshot.png',
      'Review this file',
    ]);
  });

  it('preserves an explicit project distrust override', () => {
    expect(
      buildVibeLintPiArgs(['--no-approve'], {
        prompt: 'Review this file',
        systemPrompt: 'Return violations as JSON',
      }),
    ).toEqual([
      '--no-approve',
      '--print',
      '--no-session',
      '--system-prompt',
      'Return violations as JSON',
      'Review this file',
    ]);
  });

  it('wraps the final Pi response in the vibe-lint response envelope', () => {
    expect(formatVibeLintResponse('  {"violations":[]}\n')).toBe('{"content":"{\\"violations\\":[]}"}\n');
  });
});

describe('theme launch arguments', () => {
  it('disables configured themes before loading the Doom theme', () => {
    expect(overridePiThemes(['--thinking', 'minimal'], '/tmp/doom-pi-dark.json')).toEqual([
      '--no-themes',
      '--theme',
      '/tmp/doom-pi-dark.json',
      '--thinking',
      'minimal',
    ]);
  });

  it('keeps explicit themes while giving the Doom theme collision precedence', () => {
    expect(overridePiThemes(['--theme', '/tmp/custom.json'], '/tmp/doom-pi-dark.json')).toEqual([
      '--no-themes',
      '--theme',
      '/tmp/doom-pi-dark.json',
      '--theme',
      '/tmp/custom.json',
    ]);
  });
});
