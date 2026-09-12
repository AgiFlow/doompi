import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDoctorReport, type DoctorReportDeps } from '../../src/adapters/pi/commands/slash/doctor.ts';
import {
  createSessionScope,
  scopeRunsDir,
  scopeResultsDir,
  sessionScopeDir,
} from '../../src/adapters/filesystem/paths.ts';

const scopes: ReturnType<typeof createSessionScope>[] = [];
afterEach(() => {
  for (const scope of scopes.splice(0)) fs.rmSync(sessionScopeDir(scope), { recursive: true, force: true });
});

function scope() {
  const result = createSessionScope(`doctor-${randomUUID()}`);
  scopes.push(result);
  return result;
}

function deps(agents: unknown[] = [], skills: unknown[] = []): DoctorReportDeps {
  return {
    discovery: { discover: vi.fn(() => ({ agents })) },
    skills: { discoverAvailableSkills: vi.fn(() => skills) },
  } as unknown as DoctorReportDeps;
}

describe('Team doctor report', () => {
  it('reports present filesystem roots, discovery sources, and session identity', () => {
    const current = scope();
    fs.mkdirSync(scopeRunsDir(current), { recursive: true });
    fs.mkdirSync(scopeResultsDir(current), { recursive: true });
    const report = buildDoctorReport(
      {
        cwd: '/repo',
        agentScope: 'project',
        scope: current,
        currentSessionFile: '/sessions/root.jsonl',
        currentSessionId: 'root',
        sessionError: 'temporary failure',
      },
      deps([{ source: 'plugin' }, { source: 'project' }], [{ source: 'project' }, { source: 'builtin' }]),
    );
    expect(report).toContain('- runs: ok');
    expect(report).toContain('- results: ok');
    expect(report).toContain('- agents: total 2 (plugin 1, project 1)');
    expect(report).toContain('- skills: total 2 (project 1, builtin 1)');
    expect(report).toContain('- current session id: root');
    expect(report).toContain('- session manager: failed - temporary failure');
  });

  it('reports missing roots and handles failed discovery without hiding the other sections', () => {
    const current = scope();
    const failure = new Error('discovery unavailable');
    const report = buildDoctorReport({ cwd: '/repo', agentScope: 'project', scope: current }, {
      discovery: {
        discover: () => {
          throw failure;
        },
      },
      skills: {
        discoverAvailableSkills: () => {
          throw 'skill failure';
        },
      },
    } as unknown as DoctorReportDeps);
    expect(report).toContain('- runs: missing');
    expect(report).toContain('- results: missing');
    expect(report).toContain('- agents: failed - Error: discovery unavailable');
    expect(report).toContain('- skills: failed - skill failure');
    expect(report).toContain('- current session id: not available');
    expect(report).toContain('- agents: failed');
  });

  it('marks a non-directory run root as failed', () => {
    const current = scope();
    fs.mkdirSync(sessionScopeDir(current), { recursive: true });
    fs.writeFileSync(scopeRunsDir(current), 'file');
    const report = buildDoctorReport({ cwd: '/repo', agentScope: 'project', scope: current }, deps());
    expect(report).toContain('- runs: failed');
    expect(report).toContain('- agents: total 0 (none)');
    expect(report).toContain('- skills: total 0 (none)');
  });
});
