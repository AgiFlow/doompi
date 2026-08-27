import { describe, expect, it } from 'vitest';
import { describeStranded, planSessionMigration } from '../../src/services/sessionMigration.ts';

describe('planSessionMigration', () => {
  const sessions = [
    { id: 'a', cwd: '/home/me/repo', name: 'api' },
    { id: 'b', cwd: '/home/me/repo/web' },
    { id: 'c', cwd: '/etc' },
  ];

  it('splits by whether the container could reach the directory', () => {
    const plan = planSessionMigration(sessions, ['/home/me/repo']);
    expect(plan.migrate.map((session) => session.id)).toEqual(['a', 'b']);
    expect(plan.stranded.map((session) => session.id)).toEqual(['c']);
  });

  it('takes a session that matches any one of several workspaces', () => {
    const plan = planSessionMigration(sessions, ['/nowhere', '/etc']);
    expect(plan.migrate.map((session) => session.id)).toEqual(['c']);
  });

  it('strands everything when nothing is mounted', () => {
    const plan = planSessionMigration(sessions, []);
    expect(plan.migrate).toHaveLength(0);
    expect(plan.stranded).toHaveLength(3);
  });

  it('has nothing to say about a cockpit with no sessions', () => {
    expect(planSessionMigration([], ['/home/me/repo'])).toEqual({ migrate: [], stranded: [] });
  });
});

describe('describeStranded', () => {
  it('says nothing when every session can move', () => {
    expect(describeStranded([])).toEqual([]);
  });

  it('names each directory, because that is what the user has to add', () => {
    const lines = describeStranded([
      { id: 'c', cwd: '/etc' },
      { id: 'd', cwd: '/var/log', name: 'logs' },
    ]);
    expect(lines[0]).toContain('2 session(s)');
    expect(lines.join('\n')).toContain('/etc');
    expect(lines.join('\n')).toContain('logs in /var/log');
  });

  it('falls back to the session id when it has no name', () => {
    expect(describeStranded([{ id: 'c', cwd: '/etc' }]).join('\n')).toContain('c in /etc');
  });
});
