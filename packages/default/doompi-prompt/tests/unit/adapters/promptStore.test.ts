import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeSavedPromptStore, resolvePromptsDirectory } from '../../../src/adapters/node/promptStore.ts';

const roots: string[] = [];

async function agentDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'doompi-prompt-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('the prompts directory', () => {
  it('follows the agent directory override Pi itself reads', () => {
    expect(resolvePromptsDirectory({ env: { PI_CODING_AGENT_DIR: '/custom/agent' } })).toBe('/custom/agent/prompts');
  });

  it('falls back to the agent directory under the home directory', () => {
    expect(resolvePromptsDirectory({ env: {}, home: '/home/dev' })).toBe(path.join('/home/dev', '.pi/agent/prompts'));
  });

  it('ignores a blank override', () => {
    expect(resolvePromptsDirectory({ env: { PI_CODING_AGENT_DIR: '  ' }, home: '/home/dev' })).toBe(
      path.join('/home/dev', '.pi/agent/prompts'),
    );
  });
});

describe('the saved prompt store', () => {
  it('reports no prompts before the directory exists', async () => {
    const store = createNodeSavedPromptStore({ env: { PI_CODING_AGENT_DIR: await agentDirectory() } });

    await expect(store.list()).resolves.toEqual([]);
    await expect(store.has('review')).resolves.toBe(false);
  });

  it('writes a private template Pi can discover', async () => {
    const root = await agentDirectory();
    const store = createNodeSavedPromptStore({ env: { PI_CODING_AGENT_DIR: root } });

    const written = await store.save({ name: 'review', description: 'Review the diff', text: 'Review the diff' });

    expect(written.path).toBe(path.join(root, 'prompts', 'review.md'));
    expect(await readFile(written.path, 'utf8')).toBe('---\ndescription: "Review the diff"\n---\nReview the diff\n');
    expect((await stat(written.path)).mode & 0o777).toBe(0o600);
    await expect(store.has('review')).resolves.toBe(true);
  });

  it('lists templates by name and parses them back', async () => {
    const root = await agentDirectory();
    const store = createNodeSavedPromptStore({ env: { PI_CODING_AGENT_DIR: root } });
    await store.save({ name: 'ship', description: 'Ship it', text: 'Ship it' });
    await store.save({ name: 'audit', description: 'Audit it', text: 'Audit it' });
    await writeFile(path.join(root, 'prompts', 'notes.txt'), 'ignored', 'utf8');

    await expect(store.list()).resolves.toEqual([
      { name: 'audit', description: 'Audit it', text: 'Audit it' },
      { name: 'ship', description: 'Ship it', text: 'Ship it' },
    ]);
  });

  it('replaces an existing template in place', async () => {
    const root = await agentDirectory();
    const store = createNodeSavedPromptStore({ env: { PI_CODING_AGENT_DIR: root } });

    await store.save({ name: 'review', description: 'first', text: 'first' });
    await store.save({ name: 'review', description: 'second', text: 'second' });

    await expect(store.list()).resolves.toEqual([{ name: 'review', description: 'second', text: 'second' }]);
  });

  it('deletes a template and reports a name that was not there', async () => {
    const root = await agentDirectory();
    const store = createNodeSavedPromptStore({ env: { PI_CODING_AGENT_DIR: root } });
    await store.save({ name: 'review', description: 'r', text: 'r' });

    await expect(store.remove('review')).resolves.toBe(true);
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.remove('review')).resolves.toBe(false);
  });

  it('skips a directory that looks like a template', async () => {
    const root = await agentDirectory();
    const store = createNodeSavedPromptStore({ env: { PI_CODING_AGENT_DIR: root } });
    await mkdir(path.join(root, 'prompts', 'folder.md'), { recursive: true });

    await expect(store.list()).resolves.toEqual([]);
    await expect(store.has('folder')).resolves.toBe(false);
  });
});
