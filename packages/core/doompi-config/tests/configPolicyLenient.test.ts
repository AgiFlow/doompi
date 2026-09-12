import { describe, expect, it } from 'vitest';
import { parseDoomConfig } from '../src/services/configPolicy';

const FILE = '/tmp/doom-config-lenient/config.yaml';

describe('parseDoomConfig lenient mode', () => {
  it('still throws on an unknown root key in the default strict form', () => {
    expect(() => parseDoomConfig('projectTrust: ask\nexperimental: true\n', FILE)).toThrow(
      /unsupported root field\(s\): experimental/,
    );
  });

  it('collects an unknown root key instead of throwing', () => {
    const { config, diagnostics } = parseDoomConfig('projectTrust: always\nexperimental: true\n', FILE, {
      lenient: true,
    });
    expect(config.projectTrust).toBe('always');
    expect(diagnostics).toEqual([{ filePath: FILE, path: 'experimental', message: 'unsupported root field' }]);
  });

  it('reports a nested unknown key with its dotted path', () => {
    const { diagnostics } = parseDoomConfig('voice:\n  engine: auto\n  typoField: 1\n', FILE, { lenient: true });
    expect(diagnostics).toEqual([{ filePath: FILE, path: 'voice.typoField', message: 'unsupported voice field' }]);
  });

  it('keeps the surrounding known values usable when a sibling is unknown', () => {
    const { config } = parseDoomConfig('voice:\n  engine: auto\n  typoField: 1\n', FILE, { lenient: true });
    expect(config.voice?.engine).toBe('auto');
  });

  // The whole point of the split: a build should not break over a key nobody
  // understands, but a value that is actively wrong is still a real fault.
  it('still throws on an invalid value for a known key', () => {
    expect(() => parseDoomConfig('projectTrust: bogus\n', FILE, { lenient: true })).toThrow(
      /projectTrust must be ask, always, or never/,
    );
  });

  it('leaves the strict path unaffected after a lenient parse', () => {
    parseDoomConfig('experimental: true\n', FILE, { lenient: true });
    expect(() => parseDoomConfig('experimental: true\n', FILE)).toThrow(/unsupported root field/);
  });
});
