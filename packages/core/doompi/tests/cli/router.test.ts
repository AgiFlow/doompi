import { describe, expect, it } from 'vitest';
import { informationalRequest, KNOWN_COMMANDS, routeCommand, wantsHelp } from '../../src/commands/cli/router.ts';

describe('routeCommand', () => {
  it.each([...KNOWN_COMMANDS])('routes %s when it leads the line', (command) => {
    expect(routeCommand([command])).toBe(command);
  });

  it('routes a subcommand that carries its own flags', () => {
    expect(routeCommand(['init', '--force'])).toBe('init');
  });

  // The regression this guards: a command name appearing as a flag VALUE. Under
  // a permissive parse `--profile sync` yields `sync` as the first positional,
  // which would route a Pi run into the sync pipeline.
  it.each([
    ['a flag value', ['--profile', 'sync']],
    ['a flag value for an undeclared flag', ['--major-mode', 'doctor']],
    ['prompt text', ['explain the doctor command']],
    ['an unknown flag bound for Pi', ['--foo']],
    ['nothing at all', []],
  ])('does not route %s', (_name, args) => {
    expect(routeCommand(args)).toBeUndefined();
  });
});

describe('informationalRequest', () => {
  it.each([
    ['--help', 'help'],
    ['-h', 'help'],
    ['--version', 'version'],
    ['-v', 'version'],
  ])('recognises %s', (flag, expected) => {
    expect(informationalRequest([flag])).toBe(expected);
  });

  it('finds the flag after other arguments', () => {
    expect(informationalRequest(['--profile', 'work', '--help'])).toBe('help');
  });

  // A provider flag must reach the provider rather than printing doompi's help.
  it('stops at the passthrough separator', () => {
    expect(informationalRequest(['--', '--help'])).toBeUndefined();
    expect(informationalRequest(['codex', '--', '--version'])).toBeUndefined();
  });

  it('returns undefined when neither is asked for', () => {
    expect(informationalRequest(['sync', '--check'])).toBeUndefined();
  });

  it('reports the first of the two that appears', () => {
    expect(informationalRequest(['--version', '--help'])).toBe('version');
  });
});

describe('wantsHelp', () => {
  it('is true only for help', () => {
    expect(wantsHelp(['--help'])).toBe(true);
    expect(wantsHelp(['--version'])).toBe(false);
    expect(wantsHelp(['--', '--help'])).toBe(false);
  });
});
