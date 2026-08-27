import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDoomConfigLayers } from '../src/adapters/config.ts';
import { setDoomConfigValue, unsetDoomConfigValue } from '../src/adapters/configWriter.ts';
import { configLeafKeys, configScopeOf, mergeDoomConfigs } from '../src/services/configPolicy.ts';

/**
 * Scope, made answerable.
 *
 * The merge has always decided per field which file a key is read from, but it
 * decided it by doing it, so nothing could ask. These pin the answer against
 * the merge itself, so the table cannot drift from the behaviour it describes.
 */

const temporaries: string[] = [];

function workspace(): { home: string; repo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-config-scope-'));
  temporaries.push(root);
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(home, '.pi', '.doom'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.doom'), { recursive: true });
  return { home, repo };
}

function writeGlobal(home: string, yaml: string): void {
  fs.writeFileSync(path.join(home, '.pi', '.doom', 'config.yaml'), yaml);
}

function writeRepository(repo: string, yaml: string): void {
  fs.writeFileSync(path.join(repo, '.doom', 'config.yaml'), yaml);
}

afterEach(() => {
  while (temporaries.length > 0) fs.rmSync(temporaries.pop()!, { recursive: true, force: true });
});

describe('which file a key may be written to', () => {
  it('agrees with the merge about the keys the merge reads from one side only', () => {
    // The merge is the specification. If someone changes it, one of these fails
    // rather than the table quietly describing behaviour that no longer exists.
    const globalConfig = mergeDoomConfigs(
      { projectTrust: 'ask', editor: { command: 'from-global' } },
      { projectTrust: 'never', editor: { command: 'from-repository' } },
    );

    expect(globalConfig.editor?.command).toBe('from-global');
    expect(configScopeOf(['editor', 'command'])).toBe('global');

    expect(globalConfig.projectTrust).toBe('never');
    expect(configScopeOf(['projectTrust'])).toBe('repository');
  });

  it('calls autonomous voice global only, which is the one rule the merge throws over', () => {
    expect(() =>
      mergeDoomConfigs(
        { projectTrust: 'ask' },
        { projectTrust: 'ask', voice: { autoCapture: { model: 'a/b', tts: { engine: 'macos-say' } } } },
      ),
    ).toThrow('global-only');

    expect(configScopeOf(['voice', 'autoCapture'])).toBe('global');
    expect(configScopeOf(['voice', 'autoCapture', 'tts', 'rate'])).toBe('global');
  });

  it('lets a repository override the keys the merge merges', () => {
    expect(configScopeOf(['modes', 'planning', 'main', 'model'])).toBe('both');
    expect(configScopeOf(['modes', 'planning', 'subagents', 'model'])).toBe('both');
    expect(configScopeOf(['selection', 'profile'])).toBe('both');
    expect(configScopeOf(['voice', 'language'])).toBe('both');
  });

  it('answers for a key it has never heard of, leaving rejection to the parser', () => {
    // The parser reports an unsupported key far better than a scope lookup can,
    // so this must not be the thing that refuses it first.
    expect(configScopeOf(['nonsense'])).toBe('both');
    expect(configScopeOf([])).toBe('both');
  });
});

describe('reading the two files apart', () => {
  it('reports the repository as the origin of a key it overrides', () => {
    const { home, repo } = workspace();
    writeGlobal(home, 'modes:\n  planning:\n    main:\n      model: openai/from-global\n');
    writeRepository(repo, 'modes:\n  planning:\n    main:\n      model: openai/from-repository\n');

    const layers = loadDoomConfigLayers(repo, home);

    expect(layers.valueAt(['modes', 'planning', 'main', 'model'])).toBe('openai/from-repository');
    expect(layers.originOf(['modes', 'planning', 'main', 'model'])).toBe('repository');
  });

  it('reports the global file when only it sets the key', () => {
    const { home, repo } = workspace();
    writeGlobal(home, 'modes:\n  planning:\n    main:\n      model: openai/from-global\n');

    const layers = loadDoomConfigLayers(repo, home);

    expect(layers.originOf(['modes', 'planning', 'main', 'model'])).toBe('global');
    expect(layers.repositoryFile.exists).toBe(false);
  });

  it('reports a default when neither file sets the key', () => {
    const { home, repo } = workspace();

    const layers = loadDoomConfigLayers(repo, home);

    expect(layers.originOf(['modes', 'planning', 'main', 'model'])).toBe('default');
    expect(layers.valueAt(['modes', 'planning', 'main', 'model'])).toBeUndefined();
  });

  it('never names a file whose value the merge discards', () => {
    // A repository editor block parses fine and is then dropped by the merge.
    // Reporting it as the origin is the exact confusion this exists to remove.
    const { home, repo } = workspace();
    writeGlobal(home, 'editor:\n  command: vi {file}\n');
    writeRepository(repo, 'editor:\n  command: nano {file}\n');

    const layers = loadDoomConfigLayers(repo, home);

    expect(layers.valueAt(['editor', 'command'])).toBe('vi {file}');
    expect(layers.originOf(['editor', 'command'])).toBe('global');
  });

  it('tells a key the file set from one the parser defaulted', () => {
    // An absent file reads as `{ projectTrust: 'ask' }` and the parser always
    // returns all five root keys, so the parsed object cannot answer this.
    const { home, repo } = workspace();
    writeRepository(repo, 'projectTrust: ask\n');

    const layers = loadDoomConfigLayers(repo, home);

    expect(layers.originOf(['projectTrust'])).toBe('repository');
    expect(loadDoomConfigLayers(repo, workspace().home).globalFile.keys).toEqual([]);
  });

  it('carries a hash of each file, so a writer can prove which bytes it read', () => {
    const { home, repo } = workspace();
    writeGlobal(home, 'editor:\n  command: vi {file}\n');

    const first = loadDoomConfigLayers(repo, home);
    writeGlobal(home, 'editor:\n  command: nano {file}\n');
    const second = loadDoomConfigLayers(repo, home);

    expect(first.globalFile.hash).not.toBe('');
    expect(second.globalFile.hash).not.toBe(first.globalFile.hash);
    expect(second.repositoryFile.hash).toBe('');
  });
});

describe('the raw key walk', () => {
  it('lists the leaves a document sets and nothing else', () => {
    expect(configLeafKeys({ modes: { planning: { main: { model: 'a/b' } } } })).toEqual(['modes.planning.main.model']);
  });

  it('treats a list as a leaf, because a list is replaced whole', () => {
    expect(configLeafKeys({ voice: { autoCapture: { startPhrases: ['go', 'start'] } } })).toEqual([
      'voice.autoCapture.startPhrases',
    ]);
  });

  it('reports an empty record as set, because the file did write it', () => {
    expect(configLeafKeys({ voice: {} })).toEqual(['voice']);
  });
});

describe('writing to the repository file', () => {
  it('creates a committed file the rest of the team can read', async () => {
    // The global file is private in the user's home; the repository file is
    // checked into git, and a 0600 file in a working tree is wrong in a way
    // nobody notices until someone else clones.
    const { repo } = workspace();
    fs.rmSync(path.join(repo, '.doom'), { recursive: true });
    const filePath = path.join(repo, '.doom', 'config.yaml');

    await setDoomConfigValue(filePath, ['modes', 'planning', 'main', 'model'], 'openai/x', { scope: 'repository' });

    expect(fs.statSync(filePath).mode & 0o777).toBe(0o644);
    expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o755);
  });

  it('keeps the global file private', async () => {
    const { home } = workspace();
    fs.rmSync(path.join(home, '.pi'), { recursive: true });
    const filePath = path.join(home, '.pi', '.doom', 'config.yaml');

    await setDoomConfigValue(filePath, ['editor', 'command'], 'vi {file}');

    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
  });

  it('round-trips a repository override and its removal', async () => {
    const { home, repo } = workspace();
    writeGlobal(home, 'modes:\n  planning:\n    main:\n      model: openai/from-global\n');
    const filePath = path.join(repo, '.doom', 'config.yaml');
    const keyPath = ['modes', 'planning', 'main', 'model'];

    await setDoomConfigValue(filePath, keyPath, 'openai/from-repository', { scope: 'repository' });
    expect(loadDoomConfigLayers(repo, home).originOf(keyPath)).toBe('repository');

    await unsetDoomConfigValue(filePath, keyPath, { scope: 'repository' });
    const cleared = loadDoomConfigLayers(repo, home);
    expect(cleared.originOf(keyPath)).toBe('global');
    expect(cleared.valueAt(keyPath)).toBe('openai/from-global');
    // Pruning matters here: an empty `modes.planning` block is not valid config,
    // so the ancestors have to go with the key rather than be left behind.
    expect(cleared.repositoryFile.keys).toEqual([]);
    expect(fs.readFileSync(filePath, 'utf8')).not.toContain('modes');
  });
});
