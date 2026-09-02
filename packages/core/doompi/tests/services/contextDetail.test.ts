import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SkillEntry } from '@agimon-ai/doompi-skill/catalog';
import type { ToolSource } from '@agimon-ai/doompi-ui/toolInventory';
import { afterEach, describe, expect, it } from 'vitest';
import { buildContextDetail } from '../../src/services/contextDetail.ts';
import {
  contextDetailPath,
  findContextItem,
  readContextDetail,
  removeContextDetail,
  writeContextDetail,
} from '../../src/adapters/contextDetailStore.ts';

const countTokens = (text: string): number => Math.ceil(text.length / 4);

const directories: string[] = [];

function temporaryAgentDirectory(): NodeJS.ProcessEnv {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-context-detail-'));
  directories.push(directory);
  return { PI_CODING_AGENT_DIR: directory };
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function source(overrides: Partial<ToolSource> & Pick<ToolSource, 'key' | 'kind' | 'tools'>): ToolSource {
  return { label: overrides.key, ...overrides } as ToolSource;
}

describe('buildContextDetail', () => {
  it('carries the prose and the schema the projection leaves behind', () => {
    const items = buildContextDetail({
      sources: [
        source({
          key: '/x/pi.mjs',
          kind: 'extension',
          packageName: '@agimon-ai/doompi-read',
          tools: [
            {
              name: 'read',
              description: 'Reads a file',
              parameters: { type: 'object', properties: { path: { type: 'string' } } },
              promptSnippet: 'read files before editing',
              active: true,
            },
          ],
        }),
      ],
      skills: [],
      countTokens,
    });

    expect(items).toHaveLength(1);
    const detail = items[0];
    expect(detail).toMatchObject({
      itemKind: 'tool',
      name: 'read',
      owner: '@agimon-ai/doompi-read',
      source: 'extension',
      description: 'Reads a file',
      promptSnippet: 'read files before editing',
    });
    expect(detail?.itemKind === 'tool' ? detail.parameters : undefined).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
    });
  });

  // A tool is sent twice over and the halves are cut differently, so the split
  // is what tells a reader whether it is the schema or the prose that is dear.
  it('splits a tool cost into schema and prompt', () => {
    const items = buildContextDetail({
      sources: [
        source({
          key: '/x/pi.mjs',
          kind: 'extension',
          packageName: '@agimon-ai/doompi-read',
          tools: [{ name: 'read', description: 'Reads a file', active: true }],
        }),
      ],
      skills: [],
      countTokens,
    });

    const detail = items[0];
    const tokens = detail?.itemKind === 'tool' ? detail.tokens : undefined;
    expect(tokens?.schemaTokens).toBeGreaterThan(0);
    expect(tokens?.totalTokens).toBe((tokens?.schemaTokens ?? 0) + (tokens?.promptTokens ?? 0));
  });

  it('describes a skill by where it lives, because it has no schema', () => {
    const skill: SkillEntry = {
      name: 'playwriter',
      description: 'Drives a browser',
      filePath: '/repo/.agents/skills/playwriter/SKILL.md',
      baseDir: '/repo/.agents/skills/playwriter',
      group: 'plugins',
      owner: 'testing',
      modelInvocable: true,
      promptTokens: 42,
    };

    const items = buildContextDetail({ sources: [], skills: [skill], countTokens });

    expect(items[0]).toEqual({
      itemKind: 'skill',
      name: 'playwriter',
      owner: 'testing',
      source: 'plugin',
      active: true,
      tokens: 42,
      description: 'Drives a browser',
      filePath: '/repo/.agents/skills/playwriter/SKILL.md',
      modelInvocable: true,
    });
  });
});

describe('the detail store', () => {
  it('round-trips what the agent wrote', () => {
    const environment = temporaryAgentDirectory();
    const items = buildContextDetail({
      sources: [
        source({ key: '/x/pi.mjs', kind: 'core', tools: [{ name: 'bash', description: 'Runs', active: true }] }),
      ],
      skills: [],
      countTokens,
    });

    expect(writeContextDetail('s1', 3, items, environment)).toBe(true);
    const file = readContextDetail('s1', environment);
    expect(file?.revision).toBe(3);
    expect(findContextItem(file!, 'tool', 'bash')?.name).toBe('bash');
    expect(findContextItem(file!, 'skill', 'bash')).toBeUndefined();
  });

  it('says nothing rather than throwing when no session has written', () => {
    expect(readContextDetail('never', temporaryAgentDirectory())).toBeUndefined();
  });

  it('leaves nothing behind once a session is gone', () => {
    const environment = temporaryAgentDirectory();
    writeContextDetail('s1', 1, [], environment);

    removeContextDetail('s1', environment);

    expect(fs.existsSync(contextDetailPath('s1', environment))).toBe(false);
    expect(readContextDetail('s1', environment)).toBeUndefined();
  });

  // The id reaches the reading end from a query string, so it must never be
  // able to name a file outside the store.
  it('keeps a hostile session id inside the store directory', () => {
    const environment = temporaryAgentDirectory();
    const target = contextDetailPath('../../escape', environment);

    expect(path.dirname(target)).toBe(path.join(environment.PI_CODING_AGENT_DIR!, 'doom-context'));
  });
});
