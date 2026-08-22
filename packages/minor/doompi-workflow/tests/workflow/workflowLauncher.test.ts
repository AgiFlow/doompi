import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { type EmbeddedWorkflowFeature, type Workflow } from '@agimon-ai/workflow-mcp';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectWorkflowInputs,
  loadWorkflowCatalog,
  launchWorkflowEntry,
  summarizeWorkflowFile,
  parseWorkflowCatalogPage,
  type WorkflowLauncherUi,
} from '../../src/adapters/pi/workflow/workflowLauncher';
import { createWorkflowLaunchExecutor, type WorkflowLaunchInput } from '../../src/adapters/pi/workflow/piTools';

const CWD = '/repo';
const SESSION_ID = 'session-1';

function textResult(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError };
}

function workflow(value: Record<string, unknown>): Workflow {
  return value as unknown as Workflow;
}

function context(): ExtensionContext {
  return { sessionManager: { getSessionId: () => SESSION_ID } } as unknown as ExtensionContext;
}

function ui(overrides: Partial<WorkflowLauncherUi> = {}): WorkflowLauncherUi {
  return {
    editor: vi.fn().mockResolvedValue('prompt text'),
    input: vi.fn().mockResolvedValue('value'),
    notify: vi.fn(),
    select: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('workflow catalog loading', () => {
  beforeEach(() => vi.clearAllMocks());

  it('paginates the catalog and resolves relative paths from each page directory', async () => {
    const results = [
      textResult({
        directory: CWD,
        hasNextPage: true,
        page: 1,
        pageSize: 100,
        workflows: [{ path: 'automations/one.workflow.yml', name: 'One', description: 'one', tags: [] }],
      }),
      textResult({
        directory: CWD,
        hasNextPage: false,
        page: 2,
        pageSize: 100,
        workflows: [{ path: 'automations/two.workflow.yml', name: 'Two', description: 'two', tags: ['fast'] }],
      }),
    ];
    const execute = vi.fn(async () => results.shift() ?? textResult({}));
    const tool = { execute, getInputSchema: vi.fn() } as unknown as EmbeddedWorkflowFeature['listWorkflowsTool'];

    const entries = await loadWorkflowCatalog(tool, CWD);

    expect(entries.map((entry) => entry.path)).toEqual([
      '/repo/automations/one.workflow.yml',
      '/repo/automations/two.workflow.yml',
    ]);
    expect(execute).toHaveBeenNthCalledWith(1, { directory: CWD, page: 1, pageSize: 100 });
    expect(execute).toHaveBeenNthCalledWith(2, { directory: CWD, page: 2, pageSize: 100 });
  });

  it('rejects malformed catalog output and tool errors', () => {
    expect(() => parseWorkflowCatalogPage(textResult({ directory: CWD }))).toThrow(
      'Workflow catalog response was invalid',
    );
    expect(() => parseWorkflowCatalogPage(textResult({ message: 'failed' }, true))).toThrow('failed');
  });
});

describe('workflow trigger input collection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('collects a required prompt and dispatch inputs in declaration order', async () => {
    const promptEditor = vi.fn().mockResolvedValue('  make a short video  ');
    const input = vi.fn().mockResolvedValueOnce('').mockResolvedValueOnce('asset-7');
    const promptUi = ui({ editor: promptEditor, input });
    const value = await collectWorkflowInputs(
      workflow({
        on: {
          user_prompt: {},
          workflow_dispatch: {
            inputs: {
              purpose: { required: true, default: 'conversion' },
              asset_id: { required: true },
            },
          },
        },
      }),
      promptUi,
    );

    expect(value).toEqual({ prompt: 'make a short video', inputs: { purpose: 'conversion', asset_id: 'asset-7' } });
    expect(input).toHaveBeenNthCalledWith(1, 'Workflow input: purpose', 'conversion');
    expect(input).toHaveBeenNthCalledWith(2, 'Workflow input: asset_id', undefined);
  });

  it('uses option and boolean pickers without requiring an agent decision prompt', async () => {
    const select = vi.fn().mockResolvedValueOnce('conversion').mockResolvedValueOnce('true');
    const value = await collectWorkflowInputs(
      workflow({
        on: {
          agent_decision: { steps: [] },
          workflow_dispatch: {
            inputs: {
              purpose: { options: ['conversion', 'awareness'] },
              enabled: { type: 'boolean', required: true },
            },
          },
        },
      }),
      ui({ select }),
    );

    expect(value).toEqual({ inputs: { purpose: 'conversion', enabled: 'true' } });
    expect(select).toHaveBeenNthCalledWith(1, 'Workflow input: purpose', ['conversion', 'awareness']);
    expect(select).toHaveBeenNthCalledWith(2, 'Workflow input: enabled', ['true', 'false']);
  });

  it('returns undefined on prompt or required dispatch cancellation', async () => {
    const promptCancelled = await collectWorkflowInputs(
      workflow({ on: { user_prompt: {} } }),
      ui({ editor: vi.fn().mockResolvedValue(undefined) }),
    );
    const dispatchCancelled = await collectWorkflowInputs(
      workflow({ on: { workflow_dispatch: { inputs: { asset: { required: true } } } } }),
      ui({ input: vi.fn().mockResolvedValue(undefined) }),
    );

    expect(promptCancelled).toBeUndefined();
    expect(dispatchCancelled).toBeUndefined();
  });
});

describe('launchWorkflowEntry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks for a runner and trigger values for the given entry, then launches it', async () => {
    const select = vi.fn().mockResolvedValueOnce('codex');
    const launch = vi.fn().mockResolvedValue(textResult({ runKey: 'started' }));
    const selectedWorkflow = workflow({ workspace: 'agiflow', on: { user_prompt: {} } });
    const parseWorkflow = vi.fn(() => selectedWorkflow);

    await launchWorkflowEntry(
      {
        compatibleRunners: vi.fn(() => ['codex']),
        launch,
        parseWorkflow,
        ui: ui({ editor: vi.fn().mockResolvedValue('prompt'), select }),
      },
      { path: '/repo/automations/video.workflow.yml' },
      context(),
    );

    expect(parseWorkflow).toHaveBeenCalledWith('/repo/automations/video.workflow.yml');
    expect(launch).toHaveBeenCalledWith(
      { workflowPath: '/repo/automations/video.workflow.yml', runner: 'codex', workspace: 'agiflow', prompt: 'prompt' },
      expect.anything(),
    );
  });

  it('does not launch when the runner choice is cancelled', async () => {
    const launch = vi.fn();

    await launchWorkflowEntry(
      {
        compatibleRunners: vi.fn(() => ['codex', 'claude']),
        launch,
        parseWorkflow: vi.fn(() => workflow({})),
        ui: ui({ select: vi.fn().mockResolvedValue(undefined) }),
      },
      { path: '/repo/one.workflow.yml' },
      context(),
    );

    expect(launch).not.toHaveBeenCalled();
  });

  it('refuses a workflow no available runner can run', async () => {
    await expect(
      launchWorkflowEntry(
        {
          compatibleRunners: vi.fn(() => []),
          launch: vi.fn(),
          parseWorkflow: vi.fn(() => workflow({})),
          ui: ui(),
        },
        { path: '/repo/one.workflow.yml' },
        context(),
      ),
    ).rejects.toThrow('No compatible runner is available for this workflow.');
  });
});

describe('summarizeWorkflowFile', () => {
  it('summarizes triggers, dispatch inputs, jobs, and compatible runners', () => {
    const detail = summarizeWorkflowFile('/repo/one.workflow.yml', {
      compatibleRunners: () => ['codex'],
      parseWorkflow: () =>
        workflow({
          on: {
            user_prompt: {},
            workflow_dispatch: { inputs: { asset: { description: 'Asset id', required: true, default: 'latest' } } },
          },
          jobs: {
            build: { 'runs-on': 'codex', steps: [{ name: 'compile' }, { uses: 'agiflow/publish' }, { run: 'ls' }] },
          },
        }),
    });

    expect(detail.triggers).toEqual(['user_prompt', 'workflow_dispatch']);
    expect(detail.inputs).toEqual([{ name: 'asset', description: 'Asset id', required: true, default: 'latest' }]);
    // A `run:` step with no name is placed, not quoted: a shell line does not
    // belong in a summary pane.
    expect(detail.jobs).toEqual([{ name: 'build', runsOn: 'codex', steps: ['compile', 'agiflow/publish', 'step 3'] }]);
    expect(detail.runners).toEqual(['codex']);
    expect(detail.error).toBeUndefined();
  });

  it('reports a parse failure as detail rather than throwing, so one bad file does not empty the board', () => {
    const detail = summarizeWorkflowFile('/repo/broken.workflow.yml', {
      compatibleRunners: () => undefined,
      parseWorkflow: () => {
        throw new Error('workflow yaml is invalid');
      },
    });

    expect(detail.error).toBe('workflow yaml is invalid');
    expect(detail.jobs).toEqual([]);
  });

  it('leaves runners undefined when the workflow names no runner map', () => {
    const detail = summarizeWorkflowFile('/repo/one.workflow.yml', {
      compatibleRunners: () => undefined,
      parseWorkflow: () => workflow({}),
    });

    expect(detail.runners).toBeUndefined();
  });
});

describe('createWorkflowLaunchExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('rejects an Agiflow launch without a prompt before starting the workflow', async () => {
    const execute = vi.fn();
    const executor = createWorkflowLaunchExecutor({
      runTool: { execute } as unknown as EmbeddedWorkflowFeature['runTool'],
      trackPendingRun: <T>(run: Promise<T>) => run,
    });

    await expect(
      executor.execute(
        {
          workflowPath: '/repo/workflow.yml',
          env: { AGIFLOW_JOB_KIND: 'work-unit', AGIFLOW_JOB_ID: '01K' },
        },
        context(),
      ),
    ).rejects.toThrow('require a non-empty prompt');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects partial Agiflow job identity before starting the workflow', async () => {
    const execute = vi.fn();
    const executor = createWorkflowLaunchExecutor({
      runTool: { execute } as unknown as EmbeddedWorkflowFeature['runTool'],
      trackPendingRun: <T>(run: Promise<T>) => run,
    });

    await expect(
      executor.execute(
        {
          workflowPath: '/repo/workflow.yml',
          env: { AGIFLOW_JOB_ID: '01K' },
          prompt: 'Execute the selected job.',
        },
        context(),
      ),
    ).rejects.toThrow('AGIFLOW_JOB_KIND and AGIFLOW_JOB_ID together');
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves root session stamping, pending tracking, progress, and onLaunch', async () => {
    const execute = vi.fn().mockResolvedValue(textResult({ runKey: 'started' }));
    const onLaunch = vi.fn();
    const observeSession = vi.fn();
    const trackPendingRunMock = vi.fn();
    const trackPendingRun = <T>(run: Promise<T>): Promise<T> => {
      trackPendingRunMock(run);
      return run;
    };
    const onUpdate = vi.fn();
    const executor = createWorkflowLaunchExecutor({
      activeRunCount: vi.fn().mockResolvedValue(0),
      onLaunch,
      observeSession,
      rejectRunner: vi.fn(),
      runTool: { execute } as unknown as EmbeddedWorkflowFeature['runTool'],
      trackPendingRun,
    });

    const input: WorkflowLaunchInput = { workflowPath: '/repo/workflow.yml' };
    await executor.execute(input, context(), onUpdate);

    const launchCall = execute.mock.calls[0]?.[0] as { env?: { PI_SESSION_ID?: string } };
    expect(observeSession).toHaveBeenCalledWith(launchCall.env?.PI_SESSION_ID);
    expect(trackPendingRunMock).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({ workflowPath: input.workflowPath, env: launchCall.env });
    expect(onLaunch).toHaveBeenCalledOnce();
    expect(onUpdate.mock.calls.map((call) => call[0].content[0].text)).toEqual([
      'Checking workflow capacity...',
      'Launching workflow /repo/workflow.yml...',
    ]);
  });

  it('does not call onLaunch when the run tool reports an error', async () => {
    const onLaunch = vi.fn();
    const executor = createWorkflowLaunchExecutor({
      onLaunch,
      runTool: {
        execute: vi.fn().mockResolvedValue(textResult({ message: 'rejected' }, true)),
      } as unknown as EmbeddedWorkflowFeature['runTool'],
      trackPendingRun: <T>(run: Promise<T>) => run,
    });

    await expect(executor.execute({ workflowPath: '/repo/workflow.yml' }, context())).rejects.toThrow('rejected');
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it('honours capacity before executing runner policy', async () => {
    const execute = vi.fn();
    const rejectRunner = vi.fn().mockReturnValue('runner rejected');
    const executor = createWorkflowLaunchExecutor({
      activeRunCount: vi.fn().mockResolvedValue(5),
      rejectRunner,
      runTool: { execute } as unknown as EmbeddedWorkflowFeature['runTool'],
      trackPendingRun: <T>(run: Promise<T>) => run,
    });

    await expect(executor.execute({ workflowPath: '/repo/workflow.yml', runner: 'codex' }, context())).rejects.toThrow(
      'capacity',
    );
    expect(rejectRunner).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
