import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DoomHubSessionCreateRequest } from '@agimon-ai/doompi-core/hubChannel';
import { createEmbeddedWorkflowFeature, readWorkflowProgress, WorkflowRegistryService } from '@agimon-ai/workflow-mcp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createStepExecutor } from '../../src/services/stepExecutor';

const WORKFLOW = `name: Custom run
run-directory:
  description: Step files.
  entries:
    - path: diagnosis.md
      kind: file
      description: Diagnosis.
      produced-by: [diagnose]
jobs:
  diagnose:
    system-prompt: Write the diagnosis.
    steps:
      - name: Diagnose
        artifacts: [diagnosis.md]
        runConfig:
          majorMode: examples
          domains: engineering, review
          minorModes: [plan]
        customRun:
          prompt: |
            \${{ env.JOB_SYSTEM_PROMPT }}
            Issue: \${{ inputs.issue }}
        interactiveRun: doompi --major-mode \${{ runConfig.majorMode }}
on:
  workflow_dispatch:
    inputs:
      issue:
        required: true
`;

let root: string | undefined;

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('an in-process run with a customRun step', () => {
  it('opens a pinned child session, prompts it, and records where it ran', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-workflow-custom-run-'));
    const workflowPath = path.join(root, 'custom.workflow.yml');
    fs.writeFileSync(workflowPath, WORKFLOW);
    const registry = new WorkflowRegistryService(path.join(root, 'home'));
    const created: DoomHubSessionCreateRequest[] = [];
    const prompts: string[] = [];
    const sessionService = {
      create: vi.fn(async (request: DoomHubSessionCreateRequest) => {
        created.push(request);
        return { sessionId: 'step-session', cwd: request.cwd };
      }),
      prompt: vi.fn(async (_sessionId: string, text: string) => {
        prompts.push(text);
        // The agent does its work before it settles: here, writing its artifact.
        const runDir = created[0]?.environment?.WORKFLOW_RUN_DIR;
        if (runDir) fs.writeFileSync(path.join(runDir, 'diagnosis.md'), 'root cause');
        return { settled: Promise.resolve() };
      }),
      abort: vi.fn(async () => undefined),
    };
    const feature = createEmbeddedWorkflowFeature({
      registry,
      stepExecutor: createStepExecutor({
        sessionService,
        parentSessionId: 'launcher',
        hostEnvironment: process.env,
        createId: () => 'id-1',
      }),
    });

    const result = await feature.createRunService().run({
      workflowPath,
      inputs: { issue: 'login fails' },
      workspace: 'custom-run-test',
      skipLaunch: true,
    });

    expect(result.exitCode, result.output).toBe(0);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      parentSessionId: 'launcher',
      sessionProvenance: 'workflow',
      selection: { majorMode: 'examples', domains: ['engineering', 'review'], minorModes: ['plan'] },
    });
    expect(created[0]?.environment?.WORKFLOW_RUN_DIR).toBeTruthy();
    expect(prompts[0]).toContain('Write the diagnosis.');
    expect(prompts[0]).toContain('Issue: login fails');

    const [run] = await registry.listRuns('custom-run-test');
    expect(run?.stage).toBe('completed');
    const events = await readWorkflowProgress(registry.runDirectoryFor(run!));
    expect(events.find((event) => event.ref)?.ref).toEqual({
      kind: 'session',
      id: 'step-session',
      label: expect.stringContaining('Diagnose'),
    });
  });
});

describe('published engine command selection', () => {
  it.each([
    { runner: 'codex', command: undefined, piSteps: 1 },
    { runner: 'codex', command: 'pi', piSteps: 2 },
    { runner: 'pi', command: undefined, piSteps: 2 },
    { runner: 'pi', command: 'claude', piSteps: 0 },
  ])('resolves runner $runner and command $command without provider aliases', async ({ runner, command, piSteps }) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-workflow-command-selection-'));
    const workflowPath = path.join(root, 'templates.workflow.yml');
    fs.writeFileSync(
      workflowPath,
      `name: Command selection
commands:
  pi:
    run: echo pi-template {{ prompt | shell }}
    inProcess: true
  claude:
    run: echo external-template {{ prompt | shell }}
jobs:
  work:
    steps:
      - name: First
        prompt: First task
        interactiveRun:
          - command: pi
          - command: claude
      - name: Second
        prompt: Second task
        interactiveRun:
          - command: claude
          - command: pi
`,
    );
    const feature = createEmbeddedWorkflowFeature({ registry: new WorkflowRegistryService(path.join(root, 'home')) });
    const result = await feature.createRunService().run({
      workflowPath,
      runner,
      ...(command === undefined ? {} : { command }),
      workspace: 'command-selection-test',
      dryRun: true,
      skipLaunch: true,
    });

    expect(result.exitCode, result.output).toBe(0);
    expect(result.output.match(/echo pi-template/g) ?? []).toHaveLength(piSteps);
    expect(result.output.match(/echo external-template/g) ?? []).toHaveLength(2 - piSteps);
  });
});
