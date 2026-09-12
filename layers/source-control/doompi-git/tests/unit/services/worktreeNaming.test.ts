import { describe, expect, it } from 'vitest';
import {
  branchSlug,
  planPrune,
  reconcile,
  refuseClose,
  refuseSpawn,
  worktreeDirectory,
} from '../../../src/services/worktreeNaming';
import { WORKTREE_RECORD_VERSION, type WorktreeRecord } from '../../../src/types/worktreeRegistry';

function record(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    version: WORKTREE_RECORD_VERSION,
    id: 'w1',
    branch: 'wt/fix-auth',
    baseRef: 'main',
    path: '/root/repo--abc/wt-fix-auth--1234',
    repositoryRoot: '/repo',
    sessionId: 's1',
    parentSessionId: 'p1',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('branchSlug', () => {
  it('flattens a branch into one path segment', () => {
    // The slash is the whole reason this exists: wt/fix-auth is a fine branch
    // and a directory nesting the worktree somewhere it does not live.
    expect(branchSlug('wt/fix-auth')).toBe('wt-fix-auth');
    expect(branchSlug('Feature/Add_Tests')).toBe('feature-add-tests');
  });

  it('never yields an empty or trailing-dash segment', () => {
    expect(branchSlug('///')).toBe('worktree');
    expect(branchSlug('')).toBe('worktree');
    expect(branchSlug('trailing---')).toBe('trailing');
    expect(branchSlug('x'.repeat(200)).length).toBeLessThanOrEqual(64);
  });
});

describe('worktreeDirectory', () => {
  it('keeps two colliding slugs apart by short id', () => {
    const base = { worktreesRoot: '/wt', repositoryLabel: 'doompi', repositoryId: 'abc' };
    const first = worktreeDirectory({ ...base, branch: 'feature/x', shortId: '1111' });
    const second = worktreeDirectory({ ...base, branch: 'feature_x', shortId: '2222' });
    expect(first).toBe('/wt/doompi--abc/feature-x--1111');
    expect(second).toBe('/wt/doompi--abc/feature-x--2222');
    expect(first).not.toBe(second);
  });
});

describe('refuseSpawn', () => {
  it('allows a fresh branch and refuses a blank one', () => {
    expect(refuseSpawn({ branch: 'wt/new', existing: [] })).toBeUndefined();
    expect(refuseSpawn({ branch: '   ', existing: [] })).toContain('branch name is required');
  });

  it('refuses a branch that already has a live worktree, naming the id', () => {
    const refusal = refuseSpawn({ branch: 'wt/fix-auth', existing: [record()] });
    expect(refusal).toContain('wt/fix-auth');
    expect(refusal).toContain('w1');
  });

  it('allows reusing a branch whose only worktree is orphaned', () => {
    // The orphan is exactly the case a reader is trying to recover from, so
    // refusing here would leave them stuck behind their own dead process.
    expect(refuseSpawn({ branch: 'wt/fix-auth', existing: [record({ status: 'orphaned' })] })).toBeUndefined();
  });
});

describe('refuseClose', () => {
  it('refuses an unknown id', () => {
    expect(refuseClose({ record: undefined, dirtyFiles: [], force: false })).toContain('No worktree with that id');
  });

  it('allows a clean tree and refuses a dirty one by name', () => {
    expect(refuseClose({ record: record(), dirtyFiles: [], force: false })).toBeUndefined();
    const refusal = refuseClose({ record: record(), dirtyFiles: ['src/a.ts', 'src/b.ts'], force: false });
    expect(refusal).toContain('src/a.ts');
    expect(refusal).toContain('src/b.ts');
    expect(refusal).toContain('force: true');
  });

  it('caps the named files so a huge diff stays readable', () => {
    const files = Array.from({ length: 15 }, (_, index) => `f${String(index)}.ts`);
    const refusal = refuseClose({ record: record(), dirtyFiles: files, force: false });
    expect(refusal).toContain('and 5 more');
  });

  it('lets force through a dirty tree, because that is what force means', () => {
    expect(refuseClose({ record: record(), dirtyFiles: ['a.ts'], force: true })).toBeUndefined();
  });
});

describe('reconcile', () => {
  const alwaysThere = { alive: () => true, exists: () => true };

  it('leaves a live record alone', () => {
    const { records, changed } = reconcile([record()], alwaysThere);
    expect(records[0].status).toBe('running');
    expect(changed).toEqual([]);
  });

  it('orphans a record whose process died, and one whose directory vanished', () => {
    const dead = reconcile([record()], { alive: () => false, exists: () => true });
    expect(dead.records[0].status).toBe('orphaned');
    expect(dead.changed).toEqual(['w1']);

    const gone = reconcile([record()], { alive: () => true, exists: () => false });
    expect(gone.records[0].status).toBe('orphaned');
  });

  it('never drops a record, because the directory may still hold work', () => {
    const { records } = reconcile([record(), record({ id: 'w2' })], {
      alive: () => false,
      exists: () => false,
    });
    expect(records).toHaveLength(2);
  });

  it('reports an already-orphaned record as unchanged, so repeats stay quiet', () => {
    const { changed } = reconcile([record({ status: 'orphaned' })], { alive: () => false, exists: () => false });
    expect(changed).toEqual([]);
  });
});

describe('planPrune', () => {
  const worktreesRoot = '/wt';

  it('removes an orphan git still lists and forgets one it does not', () => {
    const listed = record({ id: 'listed', status: 'orphaned', path: '/wt/a' });
    const vanished = record({ id: 'vanished', status: 'orphaned', path: '/wt/b' });
    const plan = planPrune({
      records: [listed, vanished],
      gitPaths: ['/wt/a'],
      worktreesRoot,
      dirtyByPath: new Map(),
    });
    expect(plan.remove.map((entry) => entry.id)).toEqual(['listed']);
    expect(plan.forget.map((entry) => entry.id)).toEqual(['vanished']);
  });

  it('keeps a dirty orphan rather than destroying uncommitted work', () => {
    const dirty = record({ id: 'dirty', status: 'orphaned', path: '/wt/a' });
    const plan = planPrune({
      records: [dirty],
      gitPaths: ['/wt/a'],
      worktreesRoot,
      dirtyByPath: new Map([['/wt/a', ['src/x.ts']]]),
    });
    expect(plan.remove).toEqual([]);
    expect(plan.keptDirty.map((entry) => entry.id)).toEqual(['dirty']);
  });

  it('never touches a live record', () => {
    const plan = planPrune({
      records: [record({ path: '/wt/a' })],
      gitPaths: ['/wt/a'],
      worktreesRoot,
      dirtyByPath: new Map(),
    });
    expect(plan.remove).toEqual([]);
    expect(plan.forget).toEqual([]);
  });

  it('reports an unknown worktree inside our root and ignores one outside it', () => {
    // A worktree the user made by hand is none of this package's business,
    // which is why only paths under our own root are even considered.
    const plan = planPrune({
      records: [],
      gitPaths: ['/wt/stray', '/somewhere/else', '/repo'],
      worktreesRoot,
      dirtyByPath: new Map(),
    });
    expect(plan.untracked).toEqual(['/wt/stray']);
  });
});
