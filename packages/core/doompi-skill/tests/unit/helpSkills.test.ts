import {
  createDoomHelpService,
  type DoomHelpSkill,
  type DoomHelpService,
  type DoomHelpSnapshot,
} from '@agimon-ai/doompi-extension-contracts/help';
import { createSyntheticSourceInfo, type Skill } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { createActiveHelpSkillView, mergeActiveHelpSkills } from '../../src/adapters/helpSkills.ts';

function skill(name: string, source = 'normal'): Skill {
  const filePath = `/tmp/${source}/${name}/SKILL.md`;
  return {
    name,
    description: `${name} guidance.`,
    filePath,
    baseDir: `/tmp/${source}/${name}`,
    sourceInfo: createSyntheticSourceInfo(filePath, { source }),
    disableModelInvocation: false,
  };
}

function helpSkill(name: string, source: string): DoomHelpSkill {
  return {
    name,
    source,
    description: `${name} package guidance.`,
    filePath: `/tmp/help/${source}/${name}/SKILL.md`,
    baseDir: `/tmp/help/${source}/${name}`,
  };
}

function snapshot(
  skills: readonly DoomHelpSkill[],
  activation: DoomHelpSnapshot['activation'] = 'active',
): DoomHelpSnapshot {
  return {
    hostGeneration: 'help-host:1',
    revision: 3,
    activation,
    skills: [...skills],
    diagnostics: [],
  };
}

function activeViewFixture(): {
  service: DoomHelpService;
  view: ReturnType<typeof createActiveHelpSkillView>;
  unbind(): void;
} {
  const service = createDoomHelpService('help-host:1');
  const view = createActiveHelpSkillView();
  return { service, view, unbind: view.bind(service) };
}

describe('mergeActiveHelpSkills', () => {
  it('places accepted Help wrappers after normal and deferred skills', () => {
    const normal = skill('normal');
    const deferred = skill('deferred');
    const result = mergeActiveHelpSkills(
      { normalSkills: [normal], deferredSkills: [deferred] },
      snapshot([helpSkill('doompi-help', '@agimon-ai/doompi-help')]),
    );

    expect(result.skills.map(({ name }) => name)).toEqual(['normal', 'deferred', 'doompi-help']);
    expect(result.additionalSkills.map(({ name }) => name)).toEqual(['deferred', 'doompi-help']);
    expect(result.helpSkills[0]).toMatchObject({
      name: 'doompi-help',
      sourceInfo: { source: '@agimon-ai/doompi-help', scope: 'temporary', origin: 'package' },
    });
  });

  it('does not append deferred skills already loaded by Pi', () => {
    const native = skill('shared', 'native');
    const result = mergeActiveHelpSkills(
      {
        normalSkills: [native],
        normalSkillNames: ['command-only'],
        deferredSkills: [skill('shared', 'deferred'), skill('command-only', 'deferred'), skill('unique', 'deferred')],
      },
      snapshot([]),
    );

    expect(result.skills).toEqual([native, expect.objectContaining({ name: 'unique' })]);
    expect(result.additionalSkills.map(({ name }) => name)).toEqual(['unique']);
  });

  it('gives normal and deferred skills collision precedence', () => {
    const result = mergeActiveHelpSkills(
      {
        normalSkills: [skill('shared', 'static')],
        deferredSkills: [skill('later', 'deferred')],
        normalSkillNames: ['manual'],
      },
      snapshot([
        helpSkill('shared', '@agimon-ai/a-help'),
        helpSkill('later', '@agimon-ai/b-help'),
        helpSkill('manual', '@agimon-ai/c-help'),
        helpSkill('unique', '@agimon-ai/d-help'),
      ]),
    );

    expect(result.helpSkills.map(({ name }) => name)).toEqual(['unique']);
    expect(result.diagnostics).toEqual([
      expect.stringContaining("@agimon-ai/a-help [HELP_SKILL_COLLISION]: 'shared'"),
      expect.stringContaining("@agimon-ai/b-help [HELP_SKILL_COLLISION]: 'later'"),
      expect.stringContaining("@agimon-ai/c-help [HELP_SKILL_COLLISION]: 'manual'"),
    ]);
  });

  it('resolves duplicate Help names deterministically by package source', () => {
    const result = mergeActiveHelpSkills(
      { normalSkills: [], deferredSkills: [] },
      snapshot([helpSkill('shared', '@agimon-ai/z-help'), helpSkill('shared', '@agimon-ai/a-help')]),
    );

    expect(result.helpSkills).toMatchObject([{ name: 'shared', sourceInfo: { source: '@agimon-ai/a-help' } }]);
    expect(result.diagnostics[0]).toContain('@agimon-ai/z-help');
  });

  it('orders same-source snapshots by name and file path', () => {
    const later = helpSkill('zeta', '@agimon-ai/shared-help');
    const earlier = helpSkill('alpha', '@agimon-ai/shared-help');
    const duplicate = { ...earlier, filePath: '/tmp/help/shared/alpha-later/SKILL.md' };
    const result = mergeActiveHelpSkills(
      { normalSkills: [], deferredSkills: [] },
      snapshot([later, duplicate, earlier]),
    );

    expect(result.helpSkills.map(({ name }) => name)).toEqual(['alpha', 'zeta']);
    expect(result.helpSkills[0]?.filePath).toBe(earlier.filePath);
  });

  it('keeps the published generation during reconciliation but hides inactive skills', () => {
    const candidate = helpSkill('doompi-help', '@agimon-ai/doompi-help');

    expect(
      mergeActiveHelpSkills({ normalSkills: [], deferredSkills: [] }, snapshot([candidate], 'activating')).helpSkills,
    ).toHaveLength(1);
    expect(
      mergeActiveHelpSkills({ normalSkills: [], deferredSkills: [] }, snapshot([candidate], 'inactive')).helpSkills,
    ).toEqual([]);
  });

  it('includes bounded host and client diagnostics in the diagnostic key', () => {
    const active = snapshot([]);
    active.diagnostics = [
      { source: '@agimon-ai/doompi-help', code: 'HELP_FAILED', message: 'host failure' },
      { code: 'HELP_HOST_FAILED', message: 'host diagnostic' },
    ];
    const result = mergeActiveHelpSkills({ normalSkills: [], deferredSkills: [] }, active, ['client failure']);

    expect(result.diagnostics).toEqual([
      'Help @agimon-ai/doompi-help [HELP_FAILED]: host failure',
      'Help host [HELP_HOST_FAILED]: host diagnostic',
      'client failure',
    ]);
    expect(result.diagnosticKey).toContain('help-host:1:3');
  });
});

describe('createActiveHelpSkillView', () => {
  it('tracks direct service snapshots and clears the stable binding on provider loss', () => {
    const fixture = activeViewFixture();
    fixture.service.publish({
      activation: 'active',
      skills: [helpSkill('doompi-help', '@agimon-ai/doompi-help')],
      diagnostics: [],
    });

    expect(fixture.view.merge({ normalSkills: [], deferredSkills: [] }).helpSkills.map(({ name }) => name)).toEqual([
      'doompi-help',
    ]);

    fixture.unbind();
    expect(fixture.view.merge({ normalSkills: [], deferredSkills: [] }).helpSkills).toEqual([]);

    fixture.view.dispose();
    fixture.view.dispose();
    fixture.service.dispose();
  });

  it('rebinds generations idempotently and rejects use after disposal', () => {
    const first = createDoomHelpService('help-host:first');
    const replacement = createDoomHelpService('help-host:replacement');
    const view = createActiveHelpSkillView();
    const disposeFirst = view.bind(first);
    first.publish({
      activation: 'active',
      skills: [helpSkill('first-help', '@agimon-ai/first-help')],
      diagnostics: [],
    });

    const disposeReplacement = view.bind(replacement);
    replacement.publish({
      activation: 'active',
      skills: [helpSkill('replacement-help', '@agimon-ai/replacement-help')],
      diagnostics: [],
    });
    expect(view.merge({ normalSkills: [], deferredSkills: [] }).helpSkills.map(({ name }) => name)).toEqual([
      'replacement-help',
    ]);

    disposeFirst();
    disposeFirst();
    expect(view.merge({ normalSkills: [], deferredSkills: [] }).helpSkills).toHaveLength(1);
    disposeReplacement();
    disposeReplacement();
    expect(view.merge({ normalSkills: [], deferredSkills: [] }).helpSkills).toEqual([]);

    view.dispose();
    view.dispose();
    expect(() => view.bind(first)).toThrow('disposed');
    first.dispose();
    replacement.dispose();
  });
});
