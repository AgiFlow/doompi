import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCompatibilityArgs, parseCompatibilityProvider } from '../../src/exports/cli/compatibilityOptions';

const EMPTY_INLINE_MATRIX_OPTIONS = ['--domain=', '--domains=', '--major-mode='];

describe('compatibility options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes provider-native options and subcommands through unchanged', () => {
    const result = parseCompatibilityArgs(
      ['--help', '--version', '--effort', 'high', '--output-format', 'stream-json', '--cd', '/workspace', 'exec'],
      {},
      '/repo',
    );

    expect(result.options.majorMode).toBe('copilot');
    expect(result.options.domains).toEqual(['default']);
    expect(result.options.providerArgs).toEqual([
      '--help',
      '--version',
      '--effort',
      'high',
      '--output-format',
      'stream-json',
      '--cd',
      '/workspace',
      'exec',
    ]);
  });

  it('does not request a permission bypass unless asked', () => {
    const result = parseCompatibilityArgs(['prompt'], {}, '/repo');

    expect(result.options.skipPermissions).toBe(false);
    expect(result.options.providerArgs).toEqual(['prompt']);
  });

  it('requests the permission bypass on --skip-permissions and keeps it out of provider arguments', () => {
    const result = parseCompatibilityArgs(['--skip-permissions', 'prompt'], {}, '/repo');

    expect(result.options.skipPermissions).toBe(true);
    expect(result.options.providerArgs).toEqual(['prompt']);
  });

  it('rejects a value on --skip-permissions rather than passing it to the provider', () => {
    expect(() => parseCompatibilityArgs(['--skip-permissions=true'], {}, '/repo')).toThrow(
      '--skip-permissions does not take a value',
    );
  });

  it('leaves a provider-native --skip-permissions after the delimiter untouched', () => {
    const result = parseCompatibilityArgs(['--', '--skip-permissions'], {}, '/repo');

    expect(result.options.skipPermissions).toBe(false);
    expect(result.options.providerArgs).toEqual(['--skip-permissions']);
  });

  it('uses the configured default major mode when no stronger selection exists', () => {
    const result = parseCompatibilityArgs([], {}, '/repo', 'marketing');

    expect(result.options.majorMode).toBe('marketing');
    expect(result.options.domains).toEqual(['marketing']);
  });

  it('uses multiple configured default domains after environment and flags', () => {
    const configured = parseCompatibilityArgs([], {}, '/repo', 'marketing', ['development', 'qa']);
    const inherited = parseCompatibilityArgs([], { DOOMPI_DOMAINS: 'marketing' }, '/repo', 'minimal', [
      'development',
      'qa',
    ]);
    const explicit = parseCompatibilityArgs(
      ['--domains', 'product,pm'],
      { DOOMPI_DOMAINS: 'marketing' },
      '/repo',
      'minimal',
      ['development', 'qa'],
    );

    expect(configured.options.domains).toEqual(['development', 'qa']);
    expect(inherited.options.domains).toEqual(['marketing']);
    expect(explicit.options.domains).toEqual(['product', 'pm']);
  });

  it('parses separated matrix options and one named major mode', () => {
    const result = parseCompatibilityArgs(
      ['--profile=product-agiflow', '--domains', 'development,qa', '--domain=pm', '--major-mode', 'dev', 'prompt'],
      {},
      '/repo',
    );

    expect(result.options.profile).toBe('product-agiflow');
    expect(result.options.domains).toEqual(['development', 'qa', 'pm']);
    expect(result.options.majorMode).toBe('dev');
    expect(result.options.providerArgs).toEqual(['prompt']);
  });

  it('uses environment defaults and lets explicit options override them', () => {
    const result = parseCompatibilityArgs(
      ['--profile', 'product-agiflow', '--major-mode=dev'],
      {
        DOOMPI_PROFILE: 'marketing-agiflow',
        DOOMPI_DOMAINS: 'marketing,qa',
        DOOMPI_MAJOR_MODE: 'marketing',
      },
      '/repo',
    );

    const inherited = parseCompatibilityArgs([], { DOOMPI_MAJOR_MODE: 'marketing' }, '/repo');

    expect(result.options.profile).toBe('product-agiflow');
    expect(result.options.domains).toEqual(['marketing', 'qa']);
    expect(result.options.majorMode).toBe('dev');
    expect(inherited.options.majorMode).toBe('marketing');
  });

  it('rejects a leftover variable from the retired AGENT_HARNESS namespace', () => {
    expect(() => parseCompatibilityArgs([], { AGENT_HARNESS_MAJOR_MODE: 'dev' }, '/repo')).toThrow(
      'AGENT_HARNESS_MAJOR_MODE -> DOOMPI_MAJOR_MODE',
    );
  });

  it('derives the default domain from the selected major mode', () => {
    const development = parseCompatibilityArgs(['--major-mode=dev'], {}, '/repo');
    const marketing = parseCompatibilityArgs(['--major-mode=marketing'], {}, '/repo');

    expect(development.options.domains).toEqual(['default']);
    expect(marketing.options.domains).toEqual(['marketing']);
  });

  it('stops matrix parsing at the delimiter', () => {
    const result = parseCompatibilityArgs(
      [
        '--domains',
        'qa',
        '--',
        '--profile',
        'native',
        '--major-mode',
        'native-major-mode',
        '--layers',
        'native-layers',
      ],
      {},
      '/repo',
    );

    expect(result.options.domains).toEqual(['qa']);
    expect(result.options.profile).toBeUndefined();
    expect(result.options.majorMode).toBe('copilot');
    expect(result.options.providerArgs).toEqual([
      '--profile',
      'native',
      '--major-mode',
      'native-major-mode',
      '--layers',
      'native-layers',
    ]);
  });

  it.each(EMPTY_INLINE_MATRIX_OPTIONS)('rejects an empty inline matrix value: %s', (option: string) => {
    const optionName = option.slice(0, option.indexOf('='));
    expect(() => parseCompatibilityArgs([option], {}, '/repo')).toThrow(`${optionName} requires a value`);
  });

  it('rejects repeated, comma-separated, and removed major mode options', () => {
    expect(() => parseCompatibilityArgs(['--major-mode', 'dev', '--major-mode=marketing'], {}, '/repo')).toThrow(
      '--major-mode can only be provided once',
    );
    expect(() => parseCompatibilityArgs(['--major-mode=dev,marketing'], {}, '/repo')).toThrow(
      '--major-mode accepts one major mode name',
    );
    expect(() => parseCompatibilityArgs(['--target=dev'], {}, '/repo')).toThrow(
      '--target was replaced by --major-mode',
    );
    expect(() => parseCompatibilityArgs(['--layers=-goal'], {}, '/repo')).toThrow('--layers was removed');
  });

  it('does not consume the provider delimiter as a matrix value', () => {
    expect(() => parseCompatibilityArgs(['--domains', '--', '--profile', 'native'], {}, '/repo')).toThrow(
      '--domains requires a value',
    );
  });

  it('deduplicates inherited additional directories', () => {
    const delimiter = path.delimiter;
    const result = parseCompatibilityArgs(
      [],
      { DOOMPI_ADDITIONAL_DIRS: `./run${delimiter}/shared${delimiter}./run` },
      '/repo',
    );

    expect(result.options.additionalDirectories).toEqual(['/repo/run', '/shared']);
  });

  it('validates providers, profiles, and required option values', () => {
    expect(parseCompatibilityProvider('codex')).toBe('codex');
    expect(() => parseCompatibilityProvider('pi')).toThrow('compat requires one of');
    expect(() => parseCompatibilityProvider(undefined)).toThrow('compat requires one of');
    expect(() => parseCompatibilityArgs(['--domains'], {}, '/repo')).toThrow('--domains requires a value');
    expect(() => parseCompatibilityArgs(['--domains', ','], {}, '/repo')).toThrow('--domains requires a value');
    expect(() => parseCompatibilityArgs(['--major-mode', ' '], {}, '/repo')).toThrow('--major-mode requires a value');
    expect(() => parseCompatibilityArgs(['--profile', 'one,two'], {}, '/repo')).toThrow(
      '--profile accepts one profile name',
    );
    expect(() => parseCompatibilityArgs(['--profile='], {}, '/repo')).toThrow('--profile requires a value');
    expect(() => parseCompatibilityArgs(['--profile', 'one', '--profile', 'two'], {}, '/repo')).toThrow(
      '--profile can only be provided once',
    );
    expect(() => parseCompatibilityArgs(['--profile=one', '--profile=two'], {}, '/repo')).toThrow(
      '--profile can only be provided once',
    );
    expect(() => parseCompatibilityArgs([], { DOOMPI_PROFILE: 'one,two' }, '/repo')).toThrow(
      'DOOMPI_PROFILE accepts one profile name',
    );
  });
});
