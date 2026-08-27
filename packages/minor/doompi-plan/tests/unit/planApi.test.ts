import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDeclaredApi, mountPackageApi } from '@agimon-ai/doompi-extension-contracts/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createPlanApi, api, MAX_PLAN_BYTES } from '../../src/adapters/planApi.ts';
import {
  API_BASE_PATH,
  contentPath,
  contentUrl,
  currentPath,
  currentUrl,
  formatPlanStatus,
  parsePlanStatus,
  type PlanDetailView,
  type PlanPointerRecord,
  SESSION_QUERY_PARAM,
} from '../../src/types/planApi.ts';
import type { PlanPointerPort } from '../../src/types/planPointer.ts';

const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

/**
 * The routes over a real plan file, because what they promise is about a file:
 * that a reader sees what is on disk, and that a save which was not looking at
 * that content is refused rather than applied.
 */

const temporaries: string[] = [];

function planFile(content: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-plan-api-'));
  temporaries.push(directory);
  const file = path.join(directory, 'a-plan--1.md');
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}

/** A pointer holding one record, standing in for what write_plan left behind. */
function pointing(record: PlanPointerRecord | undefined): PlanPointerPort {
  let held = record;
  return {
    read: () => held,
    write: (_sessionId, next) => {
      held = next;
    },
    clear: () => {
      held = undefined;
    },
  };
}

function recordFor(file: string): PlanPointerRecord {
  return { path: file, title: 'a-plan', writtenAt: '2026-08-27T00:00:00.000Z', planId: '1' };
}

function hashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function save(app: ReturnType<typeof createPlanApi>, body: unknown): Promise<Response> {
  return await app.fetch(
    new Request(`http://host${contentPath()}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

afterEach(() => {
  while (temporaries.length > 0) fs.rmSync(temporaries.pop()!, { recursive: true, force: true });
});

describe('reading the session plan', () => {
  it('answers the plan as it stands on disk, with the hash a save proves itself by', async () => {
    const file = planFile('# A plan\n\nstep one\n');
    const app = createPlanApi({ sessionId: 's1', pointers: pointing(recordFor(file)) });

    const response = await app.fetch(new Request(`http://host${currentPath()}`));

    expect(response.status).toBe(200);
    const detail = (await response.json()) as PlanDetailView;
    expect(detail).toMatchObject({
      path: file,
      title: 'a-plan',
      planId: '1',
      content: '# A plan\n\nstep one\n',
      unavailable: false,
    });
    expect(detail.hash).toBe(hashOf('# A plan\n\nstep one\n'));
  });

  it('reports no plan for a session that has written none', async () => {
    const app = createPlanApi({ sessionId: 's1', pointers: pointing(undefined) });

    expect((await app.fetch(new Request(`http://host${currentPath()}`))).status).toBe(404);
  });

  it('reports a plan whose file has gone rather than answering an empty one', async () => {
    const file = planFile('# A plan\n');
    fs.rmSync(file);
    const app = createPlanApi({ sessionId: 's1', pointers: pointing(recordFor(file)) });

    const detail = (await (await app.fetch(new Request(`http://host${currentPath()}`))).json()) as PlanDetailView;

    expect(detail.unavailable).toBe(true);
    expect(detail.reason).toContain('no longer exists');
  });

  it('reports a plan past the size cap rather than carrying it', async () => {
    const file = planFile('#'.repeat(MAX_PLAN_BYTES + 1));
    const app = createPlanApi({ sessionId: 's1', pointers: pointing(recordFor(file)) });

    const detail = (await (await app.fetch(new Request(`http://host${currentPath()}`))).json()) as PlanDetailView;

    expect(detail).toMatchObject({ unavailable: true, content: '' });
  });

  it('reports no plan when the host is the hub, which serves no session', async () => {
    const file = planFile('# A plan\n');

    const response = await createPlanApi({ pointers: pointing(recordFor(file)) }).fetch(
      new Request(`http://host${currentPath()}`),
    );

    expect(response.status).toBe(404);
  });
});

describe('saving the session plan', () => {
  it('writes the edit and answers the hash it now holds', async () => {
    const file = planFile('# A plan\n\nstep one\n');
    const app = createPlanApi({ sessionId: 's1', pointers: pointing(recordFor(file)) });

    const response = await save(app, {
      expectedHash: hashOf('# A plan\n\nstep one\n'),
      content: '# A plan\n\nstep two\n',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hash: hashOf('# A plan\n\nstep two\n') });
    expect(fs.readFileSync(file, 'utf8')).toBe('# A plan\n\nstep two\n');
  });

  it('refuses a save made against content the plan no longer holds', async () => {
    const file = planFile('# A plan\n\nstep one\n');
    const app = createPlanApi({ sessionId: 's1', pointers: pointing(recordFor(file)) });
    // What write_plan does when the agent revises while a tab is open.
    fs.writeFileSync(file, '# A plan\n\nrewritten by the agent\n');

    const response = await save(app, { expectedHash: hashOf('# A plan\n\nstep one\n'), content: 'the reader edit' });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ hash: hashOf('# A plan\n\nrewritten by the agent\n') });
    expect(fs.readFileSync(file, 'utf8')).toBe('# A plan\n\nrewritten by the agent\n');
  });

  it('refuses a save for a session that has written no plan', async () => {
    const app = createPlanApi({ sessionId: 's1', pointers: pointing(undefined) });

    expect((await save(app, { expectedHash: '', content: 'x' })).status).toBe(404);
  });

  it('refuses a body that is not a save', async () => {
    const file = planFile('# A plan\n');
    const app = createPlanApi({ sessionId: 's1', pointers: pointing(recordFor(file)) });

    expect((await save(app, 'not json')).status).toBe(400);
    expect((await save(app, { content: 'x' })).status).toBe(400);
    expect((await save(app, { expectedHash: 'x' })).status).toBe(400);
  });

  it('refuses to write through a plan path that has become a symlink', async () => {
    const file = planFile('# A plan\n');
    const target = path.join(path.dirname(file), 'elsewhere.md');
    fs.writeFileSync(target, '# A plan\n');
    fs.rmSync(file);
    fs.symlinkSync(target, file);
    const app = createPlanApi({ sessionId: 's1', pointers: pointing(recordFor(file)) });

    const response = await save(app, { expectedHash: hashOf('# A plan\n'), content: 'through the link' });

    expect(response.status).toBe(409);
    expect(fs.readFileSync(target, 'utf8')).toBe('# A plan\n');
  });

  it('refuses to write a plan file that gained a second name', async () => {
    const file = planFile('# A plan\n');
    fs.linkSync(file, path.join(path.dirname(file), 'also-here.md'));
    const app = createPlanApi({ sessionId: 's1', pointers: pointing(recordFor(file)) });

    expect((await save(app, { expectedHash: hashOf('# A plan\n'), content: 'x' })).status).toBe(409);
  });
});

/**
 * The status line is the whole signal the cockpit's activity group runs on: it
 * decides whether the group appears, what it says, and, by changing, when an
 * open tab re-reads. It survives a round trip or the dock shows the wrong plan.
 */
describe('the plan status line', () => {
  it('round-trips the title and the stamp', () => {
    expect(parsePlanStatus(formatPlanStatus('a-plan', '10:04:50'))).toEqual({ title: 'a-plan', stamp: '10:04:50' });
  });

  it('keeps a title that contains the separator whole', () => {
    const status = formatPlanStatus('read · write · plan', '10:04:50');

    expect(parsePlanStatus(status)).toEqual({ title: 'read · write · plan', stamp: '10:04:50' });
  });

  it('reads a line the session themed, because statuses reach a plugin raw', () => {
    expect(parsePlanStatus(`[33m${formatPlanStatus('a-plan', '10:04:50')}[0m`)).toEqual({
      title: 'a-plan',
      stamp: '10:04:50',
    });
  });

  it('reports nothing for a session that published nothing', () => {
    expect(parsePlanStatus(undefined)).toBeUndefined();
    expect(parsePlanStatus('')).toBeUndefined();
    expect(parsePlanStatus('   ')).toBeUndefined();
  });

  it('takes a line with no stamp as a title on its own', () => {
    expect(parsePlanStatus('a-plan')).toEqual({ title: 'a-plan', stamp: '' });
  });
});

/**
 * The client builds absolute URLs and the host mounts the app under a prefix it
 * strips, so the two agree only as long as the URL, minus the mount and the
 * query, is a route the app declares.
 */
describe('the plans API as a host mounts it', () => {
  it('builds one query carrying the session the hub should proxy to', () => {
    expect(currentUrl('s1')).toBe(`/api/plugin/${API_BASE_PATH}${currentPath()}?${SESSION_QUERY_PARAM}=s1`);
    expect(contentUrl('s1')).toBe(`/api/plugin/${API_BASE_PATH}${contentPath()}?${SESSION_QUERY_PARAM}=s1`);
    expect(currentUrl('s1').match(/\?/gu)).toHaveLength(1);
  });

  it('answers on the full path, and refuses one outside its mount', async () => {
    const mounted = mountPackageApi(api, { scope: 'session', sessionId: 's1', cwd: '/repo' });

    expect(mounted.mountPath).toBe(`/api/plugin/${API_BASE_PATH}`);
    // No pointer exists for this made-up session, so the route is reached and
    // answers 404 from its own logic rather than from the mount missing it.
    expect((await mounted.fetch(`/api/plugin/${API_BASE_PATH}${currentPath()}`)).status).toBe(404);
    expect((await mounted.fetch('/api/plugin/elsewhere/current')).status).toBe(404);
    mounted.close();
  });

  it('serves the base path the manifest mounts it at', () => {
    // Vibe-Lint reads the manifest statically and cannot see this value, so
    // nothing else compares the two. A rename on one side alone means no
    // client URL ever lands.
    expect(assertDeclaredApi({ packageRoot: PACKAGE_ROOT, api, scope: 'session' })).toMatchObject({
      basePath: API_BASE_PATH,
    });
  });
});
