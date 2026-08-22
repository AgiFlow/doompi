import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import {
  finishedRunSummary,
  isSessionRun,
  launchedRunSummary,
  launchHandoffSummary,
  launchNotice,
  PI_SESSION_ENV,
  resolveMaxConcurrent,
  runsForSession,
  toAgentToolResult,
  toolResultText,
  withOptions,
} from '../../src/adapters/pi/workflow/piToolBridge';
import type { WorkflowRunRecord } from '@agimon-ai/workflow-mcp';

function runRecord(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    displayName: 'auth-run',
    dryRun: false,
    runKey: 'auth-run',
    stage: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    workflowPath: '/repo/automations/auth.workflow.yml',
    workspace: 'agiflow',
    ...overrides,
  };
}

describe('resolveMaxConcurrent', () => {
  it('defaults to 5 when unset', () => {
    expect(resolveMaxConcurrent({})).toBe(5);
  });

  it('reads a positive integer override', () => {
    expect(resolveMaxConcurrent({ WORKFLOW_MCP_MAX_CONCURRENT: '2' })).toBe(2);
  });

  it.each(['0', '-1', '1.5', 'many', ''])('falls back to the default for %j', (value) => {
    expect(resolveMaxConcurrent({ WORKFLOW_MCP_MAX_CONCURRENT: value })).toBe(5);
  });
});

describe('isSessionRun', () => {
  it('recognises a run this session launched', () => {
    expect(isSessionRun(runRecord({ env: { [PI_SESSION_ENV]: 'session-a' } }), 'session-a')).toBe(true);
  });

  it('rejects a run another session launched', () => {
    expect(isSessionRun(runRecord({ env: { [PI_SESSION_ENV]: 'session-b' } }), 'session-a')).toBe(false);
  });

  // A run started from the command line carries no stamp. It belongs to nobody
  // here, and the CLI is where it is managed.
  it('rejects an unstamped run', () => {
    expect(isSessionRun(runRecord(), 'session-a')).toBe(false);
    expect(isSessionRun(runRecord({ env: { AGIFLOW_JOB_ID: 'job-1' } }), 'session-a')).toBe(false);
  });

  // The whole registry is shared, so an unknown session id matching unstamped
  // records would hand every CLI run to whichever session asked first.
  it('matches nothing when the session is unknown', () => {
    expect(isSessionRun(runRecord(), undefined)).toBe(false);
    expect(isSessionRun(runRecord({ env: { [PI_SESSION_ENV]: 'session-a' } }), undefined)).toBe(false);
  });
});

describe('runsForSession', () => {
  const records = [
    runRecord({ runKey: 'mine-running', env: { [PI_SESSION_ENV]: 'session-a' } }),
    runRecord({ runKey: 'mine-finished', stage: 'completed', env: { [PI_SESSION_ENV]: 'session-a' } }),
    runRecord({ runKey: 'theirs', env: { [PI_SESSION_ENV]: 'session-b' } }),
    runRecord({ runKey: 'unstamped' }),
  ];

  it('keeps only running runs stamped with this session', () => {
    expect(runsForSession(records, 'session-a').map((record) => record.runKey)).toEqual(['mine-running']);
  });

  it('ignores runs launched outside Pi', () => {
    expect(runsForSession(records, 'session-c')).toEqual([]);
  });
});

describe('toolResultText', () => {
  it('joins text parts and drops non-text content', () => {
    const result = {
      content: [
        { type: 'text', text: 'first' },
        { type: 'image', data: 'ignored', mimeType: 'image/png' },
        { type: 'text', text: 'second' },
      ],
    } as CallToolResult;
    expect(toolResultText(result)).toBe('first\nsecond');
  });

  it('returns an empty string when there is no text', () => {
    expect(toolResultText({ content: [] } as unknown as CallToolResult)).toBe('');
  });
});

describe('toAgentToolResult', () => {
  it('carries text and the tool name through on success', () => {
    const result = toAgentToolResult('launch_workflow', {
      content: [{ type: 'text', text: 'Launched.' }],
    } as CallToolResult);
    expect(result).toEqual({ content: [{ type: 'text', text: 'Launched.' }], details: { tool: 'launch_workflow' } });
  });

  it('substitutes a placeholder when the tool returned nothing', () => {
    const result = toAgentToolResult('stop_workflow', { content: [] } as unknown as CallToolResult);
    expect(result.content).toEqual([{ type: 'text', text: 'No output.' }]);
  });

  it('throws on an error result, because Pi signals tool failure by throwing', () => {
    expect(() =>
      toAgentToolResult('launch_workflow', {
        content: [{ type: 'text', text: 'Workspace is at capacity.' }],
        isError: true,
      } as CallToolResult),
    ).toThrow('Workspace is at capacity.');
  });
});

describe('finishedRunSummary', () => {
  it('reports a completed run without recovery advice', () => {
    const summary = finishedRunSummary(runRecord({ stage: 'completed', workflowId: 'auth' }));
    expect(summary).toContain('auth-run in workspace agiflow completed');
    expect(summary).toContain('Workflow: auth');
    expect(summary).not.toContain('workflow_run {"action":"recover"}');
  });

  it('reports the failed job and points at recovery', () => {
    const summary = finishedRunSummary(runRecord({ stage: 'error', failedJob: 'build', errorMessage: 'exit 1' }));
    expect(summary).toContain('ended in error');
    expect(summary).toContain('Failed job: build');
    expect(summary).toContain('Error: exit 1');
    expect(summary).toContain('workflow_run {"action":"recover","runKey":"auth-run"}');
  });

  it('carries Agiflow job identifiers back to the dispatching agent', () => {
    const summary = finishedRunSummary(
      runRecord({
        stage: 'completed',
        env: { AGIFLOW_JOB_KIND: 'work-unit', AGIFLOW_JOB_ID: '01K' },
      }),
    );
    expect(summary).toContain('Agiflow job: work-unit 01K');
  });

  it('omits the job line when the run carries no Agiflow identifiers', () => {
    expect(finishedRunSummary(runRecord({ stage: 'completed' }))).not.toContain('Agiflow job');
  });

  // The agent is told about this out of band, with no user question in flight,
  // so an error with no routes forward is where it invents one.
  it('offers the user a choice rather than a single instruction', () => {
    const summary = finishedRunSummary(runRecord({ stage: 'error', failedJob: 'build', errorMessage: 'exit 1' }));

    expect(summary).toContain('put these to the user');
    expect(summary).toContain('workflow_run {"action":"tail","runKey":"auth-run"}');
    expect(summary).toContain('workflow_run {"action":"recover","runKey":"auth-run"}');
    expect(summary).toContain('Report the failure and stop');
  });

  // The record names the job; only the progress log knows the step.
  it('names the step the run died on when the progress log has it', () => {
    const summary = finishedRunSummary(runRecord({ stage: 'error', failedJob: 'build' }), [
      { name: 'intake', status: 'completed', steps: [] },
      {
        name: 'build',
        status: 'failed',
        steps: [
          { name: 'install', status: 'completed' },
          { name: 'nx build api', status: 'failed', reason: 'exit code 2' },
        ],
      },
    ]);

    expect(summary).toContain('Failed job: build (step: nx build api)');
    expect(summary).toContain('exit code 2');
  });

  // A run the user stopped is not a defect, so offering to diagnose it wastes
  // a turn on a question with a known answer.
  it('does not offer diagnosis for a run the user stopped', () => {
    const summary = finishedRunSummary(runRecord({ stage: 'error', outcome: 'interrupted' }));

    expect(summary).toContain('workflow_run {"action":"recover","runKey":"auth-run"}');
    expect(summary).toContain('Leave it stopped');
    expect(summary).not.toContain('workflow_run {"action":"tail","runKey":"auth-run"}');
  });

  it('reports claim contention without unlock advice', () => {
    const summary = finishedRunSummary(runRecord({ stage: 'error', errorMessage: 'JOB_ALREADY_CLAIMED' }));

    expect(summary).toContain('another worker owns this job');
    expect(summary).toContain('Do not unlock, release, or retry');
    expect(summary).not.toContain('"action":"recover"');
  });

  it.each(['WORKFLOW_NOT_OWNED', 'Release failed for workflow wf-1'])(
    'requires user approval for ownership failures: %s',
    (errorMessage) => {
      const summary = finishedRunSummary(runRecord({ stage: 'error', errorMessage }));

      expect(summary).toContain('Inspect the current workflow ownership');
      expect(summary).toContain('ask the user before any release or unlock');
      expect(summary).not.toContain('"action":"recover"');
    },
  );

  it('rechecks state when a running workflow is not found', () => {
    const summary = finishedRunSummary(
      runRecord({ stage: 'error', errorMessage: 'Running workflow not found for auth-run' }),
    );

    expect(summary).toContain('workflow_run {"action":"status","runKey":"auth-run"}');
    expect(summary).toContain('re-check current state before retrying');
  });

  it('leaves a completed run free of options', () => {
    expect(finishedRunSummary(runRecord({ stage: 'completed' }))).not.toContain('Options');
  });
});

describe('withOptions', () => {
  it('returns the problem untouched when there is nothing to offer', () => {
    expect(withOptions('Broken.', [])).toBe('Broken.');
  });

  it('tells the agent to put the choice to the user rather than pick one', () => {
    const text = withOptions('Broken.', ['Do A', 'Do B']);

    expect(text).toContain('Broken.');
    expect(text).toContain('rather than picking one yourself');
    expect(text).toContain('- Do A');
    expect(text).toContain('- Do B');
  });
});

describe('launch summaries', () => {
  it('leads with the run key, since nothing else in an early answer carries it', () => {
    const text = launchedRunSummary(
      runRecord({ displayName: 'Dance Production', runKey: 'dance-run', workspace: 'default' }),
    );

    expect(text).toContain('Run key: dance-run');
    expect(text).toContain('Dance Production');
    expect(text).toContain('workspace default');
  });

  // A slow launcher is common enough that failing here would strand runs that
  // go on to start normally, so the handoff has to read as "wait", not "retry".
  it('tells the caller not to relaunch when no run registered in time', () => {
    const text = launchHandoffSummary('/repo/automations/dance.workflow.yml');

    expect(text).toContain('/repo/automations/dance.workflow.yml');
    expect(text).toContain('Do not launch it again');
    expect(text).toContain('Nothing was cancelled');
  });
});

describe('launchNotice', () => {
  it('keeps a short result whole', () => {
    expect(launchNotice('Started Dance Production.\nRun key: dance-run')).toBe(
      'Started Dance Production.\nRun key: dance-run',
    );
  });

  // The engine log is what a workflow that ran in this process answers with,
  // and notifying it verbatim paints tens of lines over the transcript.
  it('trims an engine log down to a toast and counts what it dropped', () => {
    const log = [
      '\u001B[2m========================\u001B[0m'.replace(/=/g, '\u2550'),
      '   run-workflow - Dance Production-wild-peak',
      '\u2550'.repeat(24),
      '   File:      /repo/automations/dance.workflow.yml',
      '   Run Dir:   /runs/dance',
      '   Trigger:   workflow_dispatch',
      '   Workflow completed successfully',
    ].join('\n');

    const notice = launchNotice(log);

    expect(notice.split('\n')).toHaveLength(4);
    expect(notice).toContain('run-workflow - Dance Production-wild-peak');
    expect(notice).not.toContain('\u2550');
    expect(notice).not.toContain('\u001B');
    expect(notice).toContain('2 more lines');
  });

  // A single line of the engine's delegation echo wraps across three rows of a
  // narrow terminal, which is the same shove to the transcript the line cap is
  // there to stop.
  it('clips a row too wide for a toast', () => {
    const long = `Delegating via launch-command: ${'pnpm exec workflow-mcp launch-process '.repeat(6)}`;

    const notice = launchNotice(long);

    expect(notice.split('\n')).toHaveLength(1);
    expect(notice.length).toBeLessThanOrEqual(100);
    expect(notice.endsWith('\u2026')).toBe(true);
  });

  it('falls back to a plain confirmation when there is nothing to show', () => {
    expect(launchNotice('   \n\u001B[0m\n')).toBe('Workflow started.');
  });
});
