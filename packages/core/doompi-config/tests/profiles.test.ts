import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyProfileEnvironment,
  buildPersonaPrompt,
  listProfileNames,
  loadProfileCatalog,
  loadProfiles,
  replaceProfileEnvironment,
  resolveProfile,
} from '../src/exports/profiles';

describe('profile configuration', () => {
  let root: string;
  /** Isolated home, so a developer's own ~/.pi/.doom never reaches these tests. */
  let home: string;
  let globalDoom: string;

  const writeProfiles = (body: string): void => {
    fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
    fs.writeFileSync(path.join(root, '.doom', 'profiles.yaml'), body);
  };

  const writeGlobalProfiles = (body: string): void => {
    fs.mkdirSync(globalDoom, { recursive: true });
    fs.writeFileSync(path.join(globalDoom, 'profiles.yaml'), body);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-profiles-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-profiles-home-'));
    globalDoom = path.join(home, '.pi', '.doom');
    fs.mkdirSync(path.join(root, 'agents', 'acme', 'ada'), { recursive: true });
    fs.writeFileSync(path.join(root, 'agents', 'acme', 'ada', 'profile.md'), 'Title: Editor');
    fs.writeFileSync(path.join(root, 'agents', 'acme', 'ada', 'SOUL.md'), 'Never invent metrics.');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('loads sorted profiles and resolves one by name', () => {
    writeProfiles(`profiles:
  writer:
    persona: agents/acme/ada
    env: {}
  editor:
    persona: agents/acme/ada
    env:
      EDITOR_MODE: strict
`);
    expect(loadProfiles(root, home)).toEqual([
      { name: 'editor', persona: 'agents/acme/ada', personaRoot: root, env: { EDITOR_MODE: 'strict' } },
      { name: 'writer', persona: 'agents/acme/ada', personaRoot: root, env: {} },
    ]);
    expect(listProfileNames(root, home)).toEqual(['editor', 'writer']);
    expect(resolveProfile(root, 'editor', home).env).toEqual({ EDITOR_MODE: 'strict' });
  });

  it('discovers only profile roots and their direct-child persona folders', () => {
    const profilesRoot = path.join(root, 'personas');
    fs.mkdirSync(path.join(profilesRoot, 'editor'), { recursive: true });
    fs.mkdirSync(path.join(profilesRoot, 'group', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(profilesRoot, 'editor', 'SOUL.md'), 'Edit precisely.');
    fs.writeFileSync(path.join(profilesRoot, 'group', 'nested', 'profile.md'), 'Too deep.');
    writeProfiles('profiles:\n  roots: [personas]\n  entries: {}\n');

    expect(loadProfiles(root, home)).toEqual([
      { name: 'editor', persona: 'personas/editor', personaRoot: root, env: {} },
    ]);
  });

  it('treats a configured root containing persona files as one profile', () => {
    const profileRoot = path.join(root, 'personas', 'solo');
    fs.mkdirSync(path.join(profileRoot, 'ignored-child'), { recursive: true });
    fs.writeFileSync(path.join(profileRoot, 'AGENTS.md'), 'Work independently.');
    fs.writeFileSync(path.join(profileRoot, 'ignored-child', 'profile.md'), 'Do not discover this child.');
    writeProfiles('profiles:\n  roots: [personas/solo]\n  entries: {}\n');

    expect(loadProfiles(root, home)).toEqual([{ name: 'solo', persona: 'personas/solo', personaRoot: root, env: {} }]);
  });

  it('lets an explicit entry override an automatically discovered profile', () => {
    const profileRoot = path.join(root, 'personas', 'writer');
    fs.mkdirSync(profileRoot, { recursive: true });
    fs.writeFileSync(path.join(profileRoot, 'profile.md'), 'Write clearly.');
    writeProfiles(`profiles:
  roots: [personas]
  entries:
    writer:
      persona: personas/writer
      env:
        TONE: concise
`);

    expect(resolveProfile(root, 'writer', home)).toEqual({
      name: 'writer',
      persona: 'personas/writer',
      personaRoot: root,
      env: { TONE: 'concise' },
    });
  });

  it('layers home roots before repository roots and lets the repository discovery win', () => {
    const globalProfilesRoot = path.join(globalDoom, 'personas');
    const repositoryProfilesRoot = path.join(root, 'personas');
    fs.mkdirSync(path.join(globalProfilesRoot, 'home-only'), { recursive: true });
    fs.mkdirSync(path.join(globalProfilesRoot, 'shared'), { recursive: true });
    fs.mkdirSync(path.join(repositoryProfilesRoot, 'repo-only'), { recursive: true });
    fs.mkdirSync(path.join(repositoryProfilesRoot, 'shared'), { recursive: true });
    fs.writeFileSync(path.join(globalProfilesRoot, 'home-only', 'profile.md'), 'Home only.');
    fs.writeFileSync(path.join(globalProfilesRoot, 'shared', 'profile.md'), 'Home shared.');
    fs.writeFileSync(path.join(repositoryProfilesRoot, 'repo-only', 'profile.md'), 'Repository only.');
    fs.writeFileSync(path.join(repositoryProfilesRoot, 'shared', 'profile.md'), 'Repository shared.');
    writeGlobalProfiles('profiles:\n  roots: [personas]\n  entries: {}\n');
    writeProfiles('profiles:\n  roots: [personas]\n  entries: {}\n');

    const profiles = loadProfiles(root, home);

    expect(profiles.map((profile) => profile.name)).toEqual(['home-only', 'repo-only', 'shared']);
    expect(profiles.find((profile) => profile.name === 'home-only')?.personaRoot).toBe(globalDoom);
    expect(profiles.find((profile) => profile.name === 'shared')?.personaRoot).toBe(root);
  });

  it('ignores unsafe and unreadable automatic candidates', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-discovered-profile-'));
    try {
      const profilesRoot = path.join(root, 'personas');
      fs.mkdirSync(path.join(profilesRoot, 'safe'), { recursive: true });
      fs.mkdirSync(path.join(profilesRoot, 'unsafe-file'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'profile.md'), 'Outside.');
      fs.writeFileSync(path.join(profilesRoot, 'safe', 'profile.md'), 'Inside.');
      fs.writeFileSync(path.join(profilesRoot, 'unsafe-file', 'profile.md'), 'Starts safe.');
      fs.symlinkSync(outside, path.join(profilesRoot, 'linked'), 'dir');
      fs.symlinkSync(path.join(outside, 'profile.md'), path.join(profilesRoot, 'unsafe-file', 'AGENTS.md'));
      writeProfiles('profiles:\n  roots: [personas]\n  entries: {}\n');

      expect(listProfileNames(root, home)).toEqual(['safe']);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('handles an absent file and unknown profile', () => {
    expect(loadProfiles(root, home)).toEqual([]);
    expect(() => resolveProfile(root, 'missing', home)).toThrow('Unknown profile: missing');
  });

  it('validates the root mapping, profile fields, and environment values', () => {
    writeProfiles('profiles: []\n');
    expect(() => loadProfiles(root, home)).toThrow('must contain a profiles mapping');
    writeProfiles('profiles: {}\nunexpected: true\n');
    expect(() => loadProfiles(root, home)).toThrow('may only contain profiles');
    writeProfiles('profiles:\n  editor:\n    persona: agents/acme/ada\n    domains: [development]\n');
    expect(() => loadProfiles(root, home)).toThrow('may only set persona and env');
    writeProfiles('profiles:\n  editor:\n    persona: agents/acme/ada\n    env: nope\n');
    expect(() => loadProfiles(root, home)).toThrow('env must be a string mapping');
    writeProfiles('profiles:\n  editor:\n    persona: agents/acme/ada\n    env:\n      RETRIES: 2\n');
    expect(() => loadProfiles(root, home)).toThrow('env.RETRIES must be a string');
    writeProfiles('profiles:\n  roots: nope\n  entries: {}\n');
    expect(() => loadProfiles(root, home)).toThrow('profiles.roots');
    writeProfiles('profiles:\n  roots: []\n  entries: []\n');
    expect(() => loadProfiles(root, home)).toThrow('profiles.entries');
    writeProfiles('profiles:\n  roots: []\n  entries: {}\n  unexpected: true\n');
    expect(() => loadProfiles(root, home)).toThrow('may only contain roots, entries and defaultProfile');
    writeProfiles('profiles:\n  roots: [missing]\n  entries: {}\n');
    expect(() => loadProfiles(root, home)).toThrow('Configured profile root is not a directory');
  });

  it('requires a safe repository-local persona with readable files', () => {
    writeProfiles('profiles:\n  editor:\n    env: {}\n');
    expect(() => loadProfiles(root, home)).toThrow('must set a persona');
    writeProfiles('profiles:\n  editor:\n    persona: /tmp/persona\n');
    expect(() => loadProfiles(root, home)).toThrow('relative to the config that declares it');
    writeProfiles('profiles:\n  editor:\n    persona: ../outside\n');
    expect(() => loadProfiles(root, home)).toThrow('inside agents/');
    writeProfiles('profiles:\n  editor:\n    persona: agents/acme/missing\n');
    expect(() => loadProfiles(root, home)).toThrow('missing persona');

    fs.mkdirSync(path.join(root, 'agents', 'acme', 'empty'));
    writeProfiles('profiles:\n  editor:\n    persona: agents/acme/empty\n');
    expect(() => loadProfiles(root, home)).toThrow('no readable persona files');
  });

  it('rejects persona directories and files that escape through symlinks', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-persona-'));
    try {
      fs.writeFileSync(path.join(outside, 'profile.md'), '# Outside');
      fs.symlinkSync(outside, path.join(root, 'agents', 'acme', 'linked'), 'dir');
      writeProfiles('profiles:\n  editor:\n    persona: agents/acme/linked\n');
      expect(() => loadProfiles(root, home)).toThrow('inside agents/');

      const linkedFilePersona = path.join(root, 'agents', 'acme', 'linked-file');
      fs.mkdirSync(linkedFilePersona);
      fs.symlinkSync(path.join(outside, 'profile.md'), path.join(linkedFilePersona, 'profile.md'));
      writeProfiles('profiles:\n  editor:\n    persona: agents/acme/linked-file\n');
      expect(() => loadProfiles(root, home)).toThrow('Persona file must stay inside');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reads a global profile against its own agents/ directory', () => {
    const globalPersona = path.join(globalDoom, 'agents', 'house');
    fs.mkdirSync(globalPersona, { recursive: true });
    fs.writeFileSync(path.join(globalPersona, 'profile.md'), 'Title: House');
    writeGlobalProfiles('profiles:\n  house:\n    persona: agents/house\n');
    writeProfiles('profiles:\n  editor:\n    persona: agents/acme/ada\n');

    const profiles = loadProfiles(root, home);

    expect(profiles.map((profile) => profile.name)).toEqual(['editor', 'house']);
    // The global persona resolves beside the global config, not in the repo.
    expect(profiles.find((profile) => profile.name === 'house')?.personaRoot).toBe(globalDoom);
    expect(profiles.find((profile) => profile.name === 'editor')?.personaRoot).toBe(root);
  });

  it('lets a repository profile replace the global one of the same name', () => {
    const globalPersona = path.join(globalDoom, 'agents', 'shared');
    fs.mkdirSync(globalPersona, { recursive: true });
    fs.writeFileSync(path.join(globalPersona, 'profile.md'), 'Title: Global');
    writeGlobalProfiles('profiles:\n  editor:\n    persona: agents/shared\n');
    writeProfiles('profiles:\n  editor:\n    persona: agents/acme/ada\n');

    expect(resolveProfile(root, 'editor', home).personaRoot).toBe(root);
  });

  it('builds a prompt from present persona files', () => {
    const prompt = buildPersonaPrompt(root, 'agents/acme/ada');
    expect(prompt).toContain('Title: Editor');
    expect(prompt).toContain('Never invent metrics.');
    expect(prompt).toContain('agents/acme/ada');
    fs.mkdirSync(path.join(root, 'agents', 'acme', 'empty'));
    expect(buildPersonaPrompt(root, 'agents/acme/empty')).toBeUndefined();
  });

  it('applies defaults and replaces only prior profile contributions', () => {
    const initial = { EXISTING: 'caller' };
    expect(applyProfileEnvironment(initial, { EXISTING: 'profile', ADDED: 'profile' })).toEqual({ ADDED: 'profile' });
    expect(initial).toEqual({ EXISTING: 'caller', ADDED: 'profile' });

    const replacement = { OLD: 'old-profile', CALLER: 'caller' };
    expect(
      replaceProfileEnvironment(
        replacement,
        { OLD: 'old-profile' },
        { OLD: 'new-profile', CALLER: 'new-profile', ADDED: 'new-profile' },
      ),
    ).toEqual({ OLD: 'new-profile', ADDED: 'new-profile' });
    expect(replacement).toEqual({ OLD: 'new-profile', CALLER: 'caller', ADDED: 'new-profile' });
  });

  describe('persona identity front-matter', () => {
    const PNG = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
      'hex',
    );

    const writePersona = (name: string, body: string): string => {
      const directory = path.join(root, 'agents', 'acme', name);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'profile.md'), body);
      return directory;
    };

    it('reads name, icon, and voice, and keeps them out of the prompt', () => {
      const directory = writePersona(
        'rhea',
        '---\nname: Rhea\nicon: avatar.png\nvoice:\n  voice: Karen\n  rate: 175\n---\nBe blunt.\n',
      );
      fs.writeFileSync(path.join(directory, 'avatar.png'), PNG);
      writeProfiles('profiles:\n  entries:\n    rhea:\n      persona: agents/acme/rhea\n');

      const [profile] = loadProfiles(root, home);
      expect(profile?.identity?.name).toBe('Rhea');
      expect(profile?.identity?.icon).toMatch(/^data:image\/png;base64,/u);
      expect(profile?.voice).toEqual({ voice: 'Karen', rate: 175 });

      const prompt = buildPersonaPrompt(root, 'agents/acme/rhea');
      expect(prompt).toContain('Be blunt.');
      expect(prompt).not.toContain('Rhea');
      expect(prompt).not.toContain('avatar.png');
    });

    it('leaves a persona without front-matter byte-identical', () => {
      writePersona('plain', 'Just prose.\n');
      writeProfiles('profiles:\n  entries:\n    plain:\n      persona: agents/acme/plain\n');

      const [profile] = loadProfiles(root, home);
      expect(profile).toEqual({ name: 'plain', persona: 'agents/acme/plain', personaRoot: root, env: {} });
      expect(buildPersonaPrompt(root, 'agents/acme/plain')).toContain('Just prose.');
    });

    it('preserves a leading rule that is not an identity block', () => {
      writePersona('ruled', '---\nsome: yaml\n---\nBody.\n');
      writePersona('prose', '---\nnot yaml at all\nBody.\n');
      writeProfiles(
        'profiles:\n  entries:\n    ruled:\n      persona: agents/acme/ruled\n    prose:\n      persona: agents/acme/prose\n',
      );

      const profiles = loadProfiles(root, home);
      expect(profiles.every((profile) => profile.identity === undefined)).toBe(true);
      expect(buildPersonaPrompt(root, 'agents/acme/ruled')).toContain('some: yaml');
      expect(buildPersonaPrompt(root, 'agents/acme/prose')).toContain('not yaml at all');
    });

    it('never strips SOUL.md or AGENTS.md', () => {
      const directory = writePersona('layered', 'Head.\n');
      fs.writeFileSync(path.join(directory, 'SOUL.md'), '---\nname: NotStripped\n---\nSoul body.\n');
      writeProfiles('profiles:\n  entries:\n    layered:\n      persona: agents/acme/layered\n');

      const prompt = buildPersonaPrompt(root, 'agents/acme/layered');
      expect(prompt).toContain('name: NotStripped');
      expect(loadProfiles(root, home)[0]?.identity).toBeUndefined();
    });

    it('drops an icon that is missing, not an image, or escapes the persona directory', () => {
      const outside = path.join(root, 'secret.png');
      fs.writeFileSync(outside, PNG);

      writePersona('gone', '---\nname: Gone\nicon: avatar.png\n---\nBody.\n');
      const fake = writePersona('fake', '---\nname: Fake\nicon: avatar.png\n---\nBody.\n');
      fs.writeFileSync(path.join(fake, 'avatar.png'), 'not an image');
      const escaped = writePersona('escaped', '---\nname: Escaped\nicon: avatar.png\n---\nBody.\n');
      fs.symlinkSync(outside, path.join(escaped, 'avatar.png'));

      writeProfiles(
        'profiles:\n  entries:\n    gone:\n      persona: agents/acme/gone\n    fake:\n      persona: agents/acme/fake\n    escaped:\n      persona: agents/acme/escaped\n',
      );

      for (const profile of loadProfiles(root, home)) {
        expect(profile.identity?.icon, profile.name).toBeUndefined();
        expect(profile.identity?.name, profile.name).toBeDefined();
      }
    });

    it('carries identity onto profiles found by root discovery', () => {
      const directory = path.join(root, 'personas', 'scout');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'profile.md'), '---\nname: Scout\n---\nRecon.\n');
      writeProfiles('profiles:\n  roots: [personas]\n  entries: {}\n');

      expect(loadProfiles(root, home)[0]?.identity).toEqual({ name: 'Scout' });
    });

    it('says so when a persona declares identity but no persona text', () => {
      writePersona('hollow', '---\nname: Hollow\n---\n');
      writeProfiles('profiles:\n  entries:\n    hollow:\n      persona: agents/acme/hollow\n');

      expect(() => loadProfiles(root, home)).toThrow(/declares identity front-matter but no persona text/u);
    });

    it('keeps a front-matter-only profile.md valid when another persona file carries the text', () => {
      const directory = writePersona('split', '---\nname: Split\n---\n');
      fs.writeFileSync(path.join(directory, 'SOUL.md'), 'All the prose lives here.');
      writeProfiles('profiles:\n  entries:\n    split:\n      persona: agents/acme/split\n');

      const [profile] = loadProfiles(root, home);
      expect(profile?.identity).toEqual({ name: 'Split' });
      expect(buildPersonaPrompt(root, 'agents/acme/split')).toContain('All the prose lives here.');
    });
  });

  describe('defaultProfile', () => {
    const writePersona = (name: string, body = '# persona'): void => {
      const directory = path.join(root, 'agents', 'acme', name);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'profile.md'), body);
    };

    it('is absent when no catalog declares one', () => {
      writePersona('writer');
      writeProfiles('profiles:\n  entries:\n    writer:\n      persona: agents/acme/writer\n');

      const catalog = loadProfileCatalog(root, home);
      expect(catalog.defaultProfile).toBeUndefined();
      expect(catalog.profiles.map((profile) => profile.name)).toEqual(['writer']);
    });

    it('names the profile a run starts on', () => {
      writePersona('writer');
      writePersona('rhea');
      writeProfiles(
        'profiles:\n  entries:\n    writer:\n      persona: agents/acme/writer\n    rhea:\n      persona: agents/acme/rhea\n  defaultProfile: rhea\n',
      );

      expect(loadProfileCatalog(root, home).defaultProfile).toBe('rhea');
    });

    it('lets the repository replace a personal default', () => {
      writePersona('writer');
      writePersona('rhea');
      const globalPersona = path.join(globalDoom, 'agents', 'writer');
      fs.mkdirSync(globalPersona, { recursive: true });
      fs.writeFileSync(path.join(globalPersona, 'profile.md'), '# global');
      writeGlobalProfiles(
        'profiles:\n  entries:\n    writer:\n      persona: agents/writer\n  defaultProfile: writer\n',
      );
      writeProfiles(
        'profiles:\n  entries:\n    writer:\n      persona: agents/acme/writer\n    rhea:\n      persona: agents/acme/rhea\n  defaultProfile: rhea\n',
      );

      expect(loadProfileCatalog(root, home).defaultProfile).toBe('rhea');
    });

    it('refuses an unknown name rather than starting with no persona', () => {
      writePersona('writer');
      writeProfiles('profiles:\n  entries:\n    writer:\n      persona: agents/acme/writer\n  defaultProfile: ghost\n');

      expect(() => loadProfileCatalog(root, home)).toThrow(/defaultProfile names an unknown profile: ghost/u);
    });

    it('refuses a non-string default', () => {
      writePersona('writer');
      writeProfiles('profiles:\n  roots: []\n  defaultProfile: 3\n');

      expect(() => loadProfileCatalog(root, home)).toThrow(/defaultProfile.*must be a non-empty string/u);
    });
  });
});
