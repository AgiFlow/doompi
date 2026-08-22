import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BuildSystemPromptOptions, Skill } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPromptWithDeferredSkills,
  DeferredSkillLoader,
  expandDeferredSkillCommand,
} from '../../src/adapters/deferredSkills';

function writeSkill(root: string, name = 'demo'): string {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, 'SKILL.md');
  fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: Does ${name}.\n---\n\nFollow the ${name} workflow.\n`);
  return filePath;
}

function skill(filePath: string, name = 'demo'): Skill {
  return {
    name,
    description: `Does ${name}.`,
    filePath,
    baseDir: path.dirname(filePath),
    sourceInfo: { source: 'local', scope: 'project', path: filePath },
    disableModelInvocation: false,
  } as Skill;
}

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('DeferredSkillLoader', () => {
  it('schedules discovery instead of running it during construction or start', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-skills-'));
    roots.push(root);
    const filePath = writeSkill(root);
    let scheduled: (() => void) | undefined;
    const loader = new DeferredSkillLoader({
      cwd: root,
      skillPaths: [filePath],
      schedule: (load) => (scheduled = load),
    });

    const pending = loader.start();

    expect(scheduled).toBeTypeOf('function');
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    scheduled?.();
    await expect(pending).resolves.toMatchObject({ skills: [{ name: 'demo' }], diagnostics: [] });
  });

  it('shares exactly one promise across background start and first-input readiness', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-skills-'));
    roots.push(root);
    writeSkill(root);
    const scheduled: Array<() => void> = [];
    const loader = new DeferredSkillLoader({ cwd: root, skillPaths: [root], schedule: (load) => scheduled.push(load) });

    const background = loader.start();
    const firstInput = loader.ready();

    expect(firstInput).toBe(background);
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    await expect(firstInput).resolves.toMatchObject({ skills: [{ name: 'demo' }] });
  });

  it('turns discovery failure into diagnostics so first submission is not rejected', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-skills-'));
    roots.push(root);
    const loader = new DeferredSkillLoader({
      cwd: root,
      skillPaths: [root],
      schedule: (load) => load(),
      load: () => {
        throw new Error('unreadable');
      },
    });

    await expect(loader.ready()).resolves.toEqual({ skills: [], diagnostics: [`${root}: unreadable`] });
  });

  it('uses deferred scheduling by default and anchors pathless diagnostics to the working directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-skills-'));
    roots.push(root);
    const loader = new DeferredSkillLoader({
      cwd: root,
      skillPaths: [],
      load: () => ({ skills: [], diagnostics: [{ message: 'discovery warning' }] }),
    });

    await expect(loader.ready()).resolves.toEqual({
      skills: [],
      diagnostics: [`${root}: discovery warning`],
    });
  });

  it('loads default skill discovery in a worker', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-skills-'));
    roots.push(root);
    writeSkill(root);
    const loader = new DeferredSkillLoader({ cwd: root, skillPaths: [root] });

    await expect(loader.ready()).resolves.toMatchObject({ skills: [{ name: 'demo' }], diagnostics: [] });
  });

  it('imports the worker dependency from the resolved module URL instead of the session cwd', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-skills-'));
    roots.push(root);
    const piModuleUrl = `data:text/javascript,${encodeURIComponent(
      "export function loadSkills() { return { skills: [], diagnostics: [{ message: 'resolved module' }] }; }",
    )}`;
    const loader = new DeferredSkillLoader({ cwd: root, skillPaths: [], piModuleUrl });

    await expect(loader.ready()).resolves.toEqual({
      skills: [],
      diagnostics: [`${root}: resolved module`],
    });
  });
});

describe('deferred skill prompt integration', () => {
  it('expands a deferred skill before Pi sees the input', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-skills-'));
    roots.push(root);
    const filePath = writeSkill(root);
    const skillBlock = `<skill name="demo" location="${filePath}">\nReferences are relative to ${path.dirname(filePath)}.\n\nFollow the demo workflow.\n</skill>`;

    expect(expandDeferredSkillCommand('/skill:demo extra context', [skill(filePath)])).toBe(
      `${skillBlock}\n\nextra context`,
    );
    expect(expandDeferredSkillCommand('/skill:demo', [skill(filePath)])).toBe(skillBlock);
  });

  it('leaves ordinary, unknown, and disappeared skill input unchanged', () => {
    expect(expandDeferredSkillCommand('hello', [])).toBe('hello');
    expect(expandDeferredSkillCommand('/skill:missing', [])).toBe('/skill:missing');
    expect(expandDeferredSkillCommand('/skill:gone', [skill('/missing/SKILL.md', 'gone')])).toBe('/skill:gone');
  });

  it('appends the deferred inventory only when read is active', () => {
    const filePath = '/repo/demo/SKILL.md';
    const options = { cwd: '/repo', selectedTools: ['read'] } satisfies BuildSystemPromptOptions;

    expect(buildPromptWithDeferredSkills('base', options, [skill(filePath)])).toContain('<available_skills>');
    expect(buildPromptWithDeferredSkills('base', { ...options, selectedTools: ['bash'] }, [skill(filePath)])).toBe(
      'base',
    );
  });
});
