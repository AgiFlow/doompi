import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent';
import { type Component, visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { registerWorkflowPiTools, WORKFLOW_PI_TOOL_NAMES } from '../../src/adapters/pi/workflow/piTools.ts';
import {
  renderWorkflowToolCall,
  renderWorkflowToolResult,
  type WorkflowToolName,
} from '../../src/tui/workflow/workflowToolRender.ts';

function plainTheme(): Theme {
  return {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
    inverse: (text: string) => text,
  } as unknown as Theme;
}

interface ToolResult {
  content?: Array<{ text?: string; type: string }>;
  isError?: boolean;
}

interface RegisteredTool {
  name: string;
  renderShell?: 'default' | 'self';
  renderCall?: (args: Record<string, unknown>, theme: Theme) => Component;
  renderResult?: (
    result: ToolResult,
    options: { expanded: boolean; isPartial: boolean },
    theme: Theme,
    context: { args: Record<string, unknown>; isError: boolean },
  ) => Component;
}

function renderToolResult(
  tool: WorkflowToolName,
  args: Record<string, unknown>,
  result: ToolResult,
  options: { expanded: boolean; isError?: boolean; isPartial?: boolean } = { expanded: false },
  width = 100,
): string[] {
  return renderWorkflowToolResult(
    tool,
    args,
    result,
    { expanded: options.expanded, isError: options.isError, isPartial: options.isPartial },
    plainTheme(),
  ).render(width);
}

function jsonResult(value: unknown, extraText?: string): ToolResult {
  return {
    content: [
      { type: 'text', text: JSON.stringify(value, null, 2) },
      ...(extraText ? [{ type: 'text', text: extraText }] : []),
    ],
  };
}

const statusRecord = {
  displayName: 'Release video',
  dryRun: false,
  env: { API_TOKEN: 'do-not-render' },
  executionCursor: { job: 'publish', phase: 'step', stepName: 'Upload assets' },
  executionState: 'paused',
  inputs: { customer: 'also-private' },
  launcher: { sessionName: 'workflow-release', type: 'tmux' },
  prompt: 'private prompt',
  runId: '11111111-1111-4111-8111-111111111111',
  runKey: 'release-video',
  secretFile: '/private/secrets.env',
  stage: 'running',
  startedAt: '2026-08-15T10:11:12.123Z',
  workflowPath: '/repo/release.workflow.yml',
  workspace: 'agiflow',
  worktreeBranch: 'workflow/release-video',
};

describe('workflow tool registration', () => {
  it('gives every workflow tool a self-owned call and result renderer', () => {
    const tools = new Map<string, RegisteredTool>();
    const pi = {
      registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
    } as unknown as ExtensionAPI;

    registerWorkflowPiTools(pi);

    for (const name of WORKFLOW_PI_TOOL_NAMES) {
      expect(tools.get(name)).toMatchObject({
        renderShell: 'self',
        renderCall: expect.any(Function),
        renderResult: expect.any(Function),
      });
    }
  });
});

describe('workflow tool call rendering', () => {
  it.each<{
    args: Record<string, unknown>;
    expected: string[];
    hidden?: string[];
    tool: WorkflowToolName;
  }>([
    {
      tool: 'list_workflows',
      args: { directory: '/repo', filter: 'video', page: 2, pageSize: 20, tags: ['production'] },
      expected: ['WORKFLOW', 'list', '/repo', 'filtered', '1 tag', 'page 2', '20/page'],
      hidden: ['video', 'production'],
    },
    {
      tool: 'launch_workflow',
      args: {
        env: { API_TOKEN: 'do-not-render' },
        inputs: { customer: 'also-private' },
        prompt: 'private prompt',
        runner: 'pi',
        workflowPath: '/repo/video.workflow.yml',
        workspace: 'agiflow',
      },
      expected: [
        'WORKFLOW',
        'launch',
        '/repo/video.workflow.yml',
        'workspace agiflow',
        'runner pi',
        'with prompt',
        '1 input',
        '1 env',
      ],
      hidden: ['do-not-render', 'also-private', 'private prompt'],
    },
    {
      tool: 'workflow_run',
      args: { action: 'recover', dryRun: true, job: 'verify', runKey: 'video-run', workspace: 'agiflow' },
      expected: ['WORKFLOW', 'recover', 'agiflow/video-run', 'job override', 'dry run'],
      hidden: ['verify'],
    },
  ])('renders $tool as compact Doom chrome', ({ tool, args, expected, hidden = [] }) => {
    const lines = renderWorkflowToolCall(tool, args, plainTheme()).render(120);
    const text = lines.join('\n');

    for (const fragment of expected) expect(text).toContain(fragment);
    for (const fragment of hidden) expect(text).not.toContain(fragment);
    expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
  });
});

describe('workflow tool result rendering', () => {
  it('renders workflow catalogs as named rows with pagination instead of JSON', () => {
    const workflows = Array.from({ length: 8 }, (_, index) => ({
      description: `Description ${index + 1}`,
      name: `Workflow ${index + 1}`,
      path: `nested/workflow-${index + 1}.workflow.yml`,
      tags: index === 0 ? ['release', 'video'] : [],
    }));
    const result = jsonResult({
      directory: '/repo/workflows',
      page: 2,
      pageSize: 8,
      tags: [
        { count: 4, tag: 'release' },
        { count: 2, tag: 'video' },
      ],
      total: 18,
      totalPages: 3,
      workflows,
    });

    const collapsedLines = renderToolResult('list_workflows', { directory: '/repo/workflows' }, result);
    const collapsed = collapsedLines.join('\n');
    const expanded = renderToolResult('list_workflows', { directory: '/repo/workflows' }, result, {
      expanded: true,
    }).join('\n');

    expect(collapsedLines[0]).toBe(` ${'─'.repeat(98)}`);
    expect(collapsed).toContain('18 workflows · page 2/3');
    expect(collapsed).toContain('Workflow 1 · nested/workflow-1.workflow.yml');
    expect(collapsed).toContain('Workflow 6');
    expect(collapsed).not.toContain('Workflow 7');
    expect(collapsed).toContain('… 2 more · ctrl+o');
    expect(collapsed).not.toContain('"workflows"');
    expect(expanded).toContain('Workflow 8');
    expect(expanded).toContain('Description 1');
    expect(expanded).toContain('tags release, video');
    expect(expanded).toContain('available tags release (4), video (2)');
    expect(expanded).toContain('directory /repo/workflows');
    expect(collapsedLines.every((line) => visibleWidth(line) <= 100)).toBe(true);
  });

  it('summarizes launch identity and lifecycle state', () => {
    const result = {
      content: [
        {
          type: 'text',
          text: [
            'Started Release video in workspace agiflow.',
            'Run key: release-video',
            'Use workflow_run with action status to inspect it.',
          ].join('\n'),
        },
        { type: 'text', text: 'Next steps for the agent: never claim success yet.' },
      ],
    };
    const args = {
      runner: 'pi',
      workflowPath: '/repo/release.workflow.yml',
      workspace: 'agiflow',
    };

    const collapsed = renderToolResult('launch_workflow', args, result).join('\n');
    const expanded = renderToolResult('launch_workflow', args, result, { expanded: true }).join('\n');

    expect(collapsed).toContain('◐ Release video · agiflow/release-video · started');
    expect(collapsed).toContain('runner pi');
    expect(collapsed).not.toContain('Next steps for the agent');
    expect(expanded).toContain('Run key: release-video');
  });

  it('renders status as a workflow state card and omits private record fields', () => {
    const result = jsonResult(statusRecord);
    const args = { action: 'status', runKey: 'release-video', workspace: 'agiflow' };

    const collapsed = renderToolResult('workflow_run', args, result).join('\n');
    const expanded = renderToolResult('workflow_run', args, result, { expanded: true }).join('\n');

    expect(collapsed).toContain('Ⅱ Release video · agiflow/release-video · paused');
    expect(collapsed).toContain('[publish] Upload assets');
    expect(collapsed).toContain('started 2026-08-15 10:11:12Z');
    expect(expanded).toContain('workflow /repo/release.workflow.yml');
    expect(expanded).toContain('run id 11111111-1111-4111-8111-111111111111');
    expect(expanded).toContain('launcher tmux workflow-release');
    expect(expanded).toContain('worktree workflow/release-video');
    for (const privateValue of ['do-not-render', 'also-private', 'private prompt', '/private/secrets.env']) {
      expect(expanded).not.toContain(privateValue);
    }
    expect(expanded).not.toContain('"displayName"');
  });

  it.each(['pause', 'resume', 'stop'] as const)('renders %s as a lifecycle request, not a JSON blob', (action) => {
    const result = jsonResult(
      {
        action,
        request: { requestedAt: '2026-08-15T10:12:13.000Z' },
        runKey: 'release-video',
        workspace: 'agiflow',
      },
      'Next steps for the agent: call status and inspect the transition.',
    );
    const output = renderToolResult('workflow_run', { action, runKey: 'release-video', workspace: 'agiflow' }, result, {
      expanded: true,
    }).join('\n');

    expect(output).toContain(`◐ ${action} requested · agiflow/release-video`);
    expect(output).toContain('requested 2026-08-15 10:12:13Z');
    expect(output).toContain('verify the transition with workflow_run status');
    expect(output).not.toContain('"request"');
    expect(output).not.toContain('Next steps for the agent');
  });

  it('summarizes durable recovery evidence without dumping run.json', () => {
    const failedRecord = {
      ...statusRecord,
      errorMessage: 'Upload failed',
      executionState: undefined,
      outcome: 'failed',
      stage: 'error',
    };
    const evidence = [
      'Workflow: Release video (agiflow/release-video)',
      '--- run.json ---',
      JSON.stringify(failedRecord, null, 2),
      '--- changelog.md ---',
      'Recorded upload failure.',
      '--- progress.ndjson ---',
      '{"type":"step","status":"failed"}',
    ].join('\n');
    const result = { content: [{ type: 'text', text: evidence }] };
    const args = { action: 'recovery-evidence', runKey: 'release-video', workspace: 'agiflow' };

    const collapsed = renderToolResult('workflow_run', args, result).join('\n');
    const expanded = renderToolResult('workflow_run', args, result, { expanded: true }).join('\n');

    expect(collapsed).toContain('✗ Release video · agiflow/release-video · failed');
    expect(collapsed).toContain('error Upload failed');
    expect(collapsed).toContain('evidence changelog.md, progress.ndjson');
    expect(collapsed).not.toContain('"displayName"');
    expect(expanded).toContain('changelog.md');
    expect(expanded).toContain('Recorded upload failure.');
    expect(expanded).toContain('progress.ndjson');
    expect(expanded).not.toContain('do-not-render');
  });

  it.each<{
    action: 'follow' | 'open' | 'recover' | 'tail';
    expected: string;
    text: string;
  }>([
    { action: 'follow', expected: '✓ following output · agiflow/release-video', text: 'Following workflow output.' },
    { action: 'open', expected: '✓ launcher opened · agiflow/release-video', text: 'Opened workflow launcher.' },
    { action: 'recover', expected: '◐ recovery accepted · agiflow/release-video', text: 'Recovery delegated.' },
    {
      action: 'tail',
      expected: '✓ launcher output checked · agiflow/release-video',
      text: 'Workflow: Release video\nStage: running\nRaw launcher output is intentionally not copied into chat.',
    },
  ])('renders $action with action-aware feedback', ({ action, expected, text }) => {
    const output = renderToolResult(
      'workflow_run',
      { action, runKey: 'release-video', workspace: 'agiflow' },
      { content: [{ type: 'text', text }] },
    ).join('\n');

    expect(output).toContain(expected);
    if (action === 'tail') {
      expect(output).toContain('Workflow: Release video');
      expect(output).toContain('Stage: running');
    }
  });

  it('handles partial updates, errors, and unknown result shapes safely', () => {
    const text = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n');
    const partial = renderToolResult(
      'launch_workflow',
      { workflowPath: '/repo/release.workflow.yml' },
      { content: [{ type: 'text', text }] },
      { expanded: false, isPartial: true },
    ).join('\n');
    const failed = renderToolResult(
      'launch_workflow',
      { workflowPath: '/repo/release.workflow.yml' },
      { content: [{ type: 'text', text: 'Launcher process exited before handoff.' }] },
      { expanded: false, isError: true },
    ).join('\n');
    const fallback = renderToolResult(
      'workflow_run',
      { action: 'future-action', runKey: 'release-video' },
      { content: [{ type: 'text', text }] },
    ).join('\n');

    expect(partial).toContain('◐ launch · /repo/release.workflow.yml');
    expect(partial).toContain('… 8 earlier');
    expect(partial).toContain('line 12');
    expect(partial).not.toContain('line 1\n');
    expect(failed).toContain('✗ launch failed · /repo/release.workflow.yml');
    expect(failed).toContain('Launcher process exited before handoff.');
    expect(fallback).toContain('line 1');
    expect(fallback).toContain('line 8');
    expect(fallback).not.toContain('line 9');
    expect(fallback).toContain('… 4 more · ctrl+o');
  });
});

describe('workflow state glyphs', () => {
  function statusLine(overrides: Record<string, unknown>): string {
    return renderToolResult(
      'workflow_run',
      { action: 'status', runKey: 'release-video', workspace: 'agiflow' },
      jsonResult({ ...statusRecord, executionState: undefined, ...overrides }),
    ).join('\n');
  }

  it.each([
    { expected: '! Release video · agiflow/release-video · interrupted', state: { outcome: 'interrupted' } },
    { expected: '✗ Release video · agiflow/release-video · failed', state: { stage: 'error' } },
    { expected: '✗ Release video · agiflow/release-video · failed', state: { outcome: 'failed' } },
    {
      expected: '○ Release video · agiflow/release-video · skipped',
      state: { outcome: 'skipped', stage: 'completed' },
    },
    { expected: '✓ Release video · agiflow/release-video · completed', state: { stage: 'completed' } },
    {
      expected: 'Ⅱ Release video · agiflow/release-video · paused',
      state: { executionState: 'paused', stage: 'running' },
    },
    {
      expected: '◐ Release video · agiflow/release-video · pause requested',
      state: { executionState: 'pause_requested', stage: 'running' },
    },
    {
      expected: '◐ Release video · agiflow/release-video · resume requested',
      state: { executionState: 'resume_requested', stage: 'running' },
    },
    { expected: '◐ Release video · agiflow/release-video · running', state: { stage: 'running' } },
    { expected: '○ Release video · agiflow/release-video · queued', state: { stage: 'queued' } },
  ])('renders $expected', ({ state, expected }) => {
    expect(statusLine(state)).toContain(expected);
  });

  it('prefers the effective stage and outcome the server resolved', () => {
    expect(statusLine({ effectiveOutcome: 'failed', effectiveStage: 'error', outcome: undefined })).toContain(
      '✗ Release video',
    );
  });

  it('drops the workspace prefix from a run that has none', () => {
    expect(statusLine({ workspace: undefined })).toContain('· release-video ·');
  });

  it('falls back to the run key when the record carries no display name', () => {
    expect(statusLine({ displayName: undefined })).toContain('release-video · agiflow/release-video');
  });

  it('reports a failure reason and a stale reason on their own lines', () => {
    const output = statusLine({ failureReason: 'runner vanished', staleReason: 'no heartbeat for 10m' });

    expect(output).toContain('error runner vanished');
    expect(output).toContain('stale no heartbeat for 10m');
  });

  it('shows the concise metadata a finished run carries', () => {
    const output = statusLine({ dryRun: true, exitCode: 0, runner: 'pi', stage: 'completed' });

    expect(output).toContain('runner pi');
    expect(output).toContain('dry run');
    expect(output).toContain('exit 0');
  });
});

describe('workflow record activity and launcher', () => {
  function statusOutput(overrides: Record<string, unknown>, expanded = false): string {
    return renderToolResult(
      'workflow_run',
      { action: 'status', runKey: 'release-video', workspace: 'agiflow' },
      jsonResult({ ...statusRecord, ...overrides }),
      { expanded },
    ).join('\n');
  }

  it('omits the activity line when nothing is executing', () => {
    const output = statusOutput({ executionCursor: undefined, job: undefined });

    expect(output).toContain('Release video');
    expect(output).not.toContain('[publish]');
  });

  it('names the phase when the cursor has no job or step', () => {
    expect(statusOutput({ executionCursor: { phase: 'setup' } })).toContain('[setup] setup');
  });

  it('falls back to the record job and a generic step', () => {
    expect(statusOutput({ executionCursor: {}, job: 'verify' })).toContain('[verify] running');
  });

  it.each([
    { expected: 'launcher tmux workflow-release', launcher: { sessionName: 'workflow-release', type: 'tmux' } },
    { expected: 'launcher docker abc123', launcher: { type: 'docker', workspaceId: 'abc123' } },
    { expected: 'launcher local', launcher: { type: 'local' } },
  ])('renders $expected', ({ launcher, expected }) => {
    expect(statusOutput({ launcher }, true)).toContain(expected);
  });

  it('omits the launcher line for a launcher with no type', () => {
    expect(statusOutput({ launcher: { sessionName: 'orphan' } }, true)).not.toContain('launcher');
  });

  it('falls back to raw text when the payload is not a workflow record', () => {
    const output = renderToolResult(
      'workflow_run',
      { action: 'status', runKey: 'release-video' },
      jsonResult({ note: 'no run key or stage here' }),
    ).join('\n');

    expect(output).toContain('no run key or stage here');
  });
});

describe('workflow call metadata', () => {
  function callText(tool: WorkflowToolName, args: Record<string, unknown>): string {
    return renderWorkflowToolCall(tool, args, plainTheme()).render(120).join('\n');
  }

  it('lists only the options a list call actually set', () => {
    const text = callText('list_workflows', { directory: '/repo' });

    expect(text).toContain('list');
    expect(text).not.toContain('page');
    expect(text).not.toContain('filtered');
    expect(text).not.toContain('tag');
  });

  it('counts a single tag and a single input in the singular', () => {
    expect(callText('list_workflows', { tags: ['release'] })).toContain('1 tag');
    expect(callText('list_workflows', { tags: ['release', 'video'] })).toContain('2 tags');
    expect(callText('launch_workflow', { inputs: { a: 1, b: 2 } })).toContain('2 inputs');
  });

  it('reports a dry-run launch pinned to one job', () => {
    const text = callText('launch_workflow', { dryRun: true, job: 'verify', workflowPath: '/repo/a.workflow.yml' });

    expect(text).toContain('dry run');
    expect(text).toContain('job verify');
  });

  it('reports the guards a run call set', () => {
    const text = callText('workflow_run', {
      action: 'stop',
      expectedRunId: '11111111-1111-4111-8111-111111111111',
      reason: 'superseded',
      runKey: 'release-video',
      runner: 'pi',
    });

    expect(text).toContain('generation checked');
    expect(text).toContain('with reason');
    expect(text).toContain('runner override');
    // The reason itself is the user's text and stays out of the chrome.
    expect(text).not.toContain('superseded');
  });

  it('defaults the action and drops the target when no run is named', () => {
    const text = callText('workflow_run', {});

    expect(text).toContain('run');
    expect(text).not.toContain('/');
  });
});
