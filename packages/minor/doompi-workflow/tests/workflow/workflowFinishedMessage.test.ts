import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';

import {
  isWorkflowFinishedRuns,
  registerWorkflowFinishedRenderer,
  renderWorkflowFinished,
  WORKFLOW_FINISHED_MESSAGE,
  type WorkflowFinishedRun,
} from '../../src/tui/workflow/workflowFinishedMessage';

/** Identity theme: assertions are about what text is emitted, not colour codes. */
const theme = {
  fg: (_colour: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function run(overrides: Partial<WorkflowFinishedRun> = {}): WorkflowFinishedRun {
  return {
    runKey: 'development-feature-zinc-lynx',
    workspace: 'default',
    stage: 'completed',
    workflowId: 'dev-feature.workflow',
    ...overrides,
  };
}

describe('renderWorkflowFinished', () => {
  it('renders one finished run as a single line of workflow, identity, and stage', () => {
    const text = renderWorkflowFinished([run()], theme);

    expect(text.split('\n')).toHaveLength(1);
    expect(text).toBe('✔ dev-feature.workflow · development-feature-zinc-lynx/default · completed');
  });

  it('distinguishes completed, held, and failed runs by glyph', () => {
    const glyph = (stage: string): string => renderWorkflowFinished([run({ stage })], theme).slice(0, 1);

    expect(glyph('completed')).toBe('✔');
    expect(glyph('stopped')).toBe('■');
    expect(glyph('error')).toBe('✖');
  });

  it('indents the failed job and error under the run rather than beside it', () => {
    const text = renderWorkflowFinished(
      [run({ stage: 'error', failedJob: 'implement', error: 'step exited 1' })],
      theme,
    );

    expect(text.split('\n')).toHaveLength(3);
    expect(text).toContain('  ⎿  failed job: implement');
    expect(text).toContain('  ⎿  step exited 1');
  });

  it('stays one line per run for a batch of finished runs', () => {
    const runs = [run({ runKey: 'a' }), run({ runKey: 'b' }), run({ runKey: 'c' })];

    expect(renderWorkflowFinished(runs, theme).split('\n')).toHaveLength(runs.length);
  });
});

describe('isWorkflowFinishedRuns', () => {
  it('accepts recorded runs and rejects anything else', () => {
    expect(isWorkflowFinishedRuns([run()])).toBe(true);
    expect(isWorkflowFinishedRuns([])).toBe(false);
    expect(isWorkflowFinishedRuns(undefined)).toBe(false);
    expect(isWorkflowFinishedRuns([{ runIds: ['run-1'] }])).toBe(false);
  });
});

describe('registerWorkflowFinishedRenderer', () => {
  function fakePi(): {
    pi: ExtensionAPI;
    registeredType: () => string | undefined;
    render: (details: unknown, content: string) => { render: (width: number) => string[] };
  } {
    let registered: ((message: unknown, options: unknown, theme: Theme) => unknown) | undefined;
    let registeredType: string | undefined;
    const pi = {
      registerMessageRenderer: (
        customType: string,
        renderer: (message: unknown, options: unknown, theme: Theme) => unknown,
      ) => {
        registeredType = customType;
        registered = renderer;
      },
    } as unknown as ExtensionAPI;
    return {
      pi,
      registeredType: () => registeredType,
      render: (details, content) =>
        registered?.({ content, details }, { outputPad: 0 }, theme) as { render: (width: number) => string[] },
    };
  }

  it('registers under the type the extension sends and renders its runs', () => {
    const host = fakePi();
    registerWorkflowFinishedRenderer(host.pi);

    const component = host.render({ runs: [run()] }, 'Workflow run … completed.');

    expect(host.registeredType()).toBe(WORKFLOW_FINISHED_MESSAGE);
    expect(component.render(120).join('\n')).toContain('✔ dev-feature.workflow');
  });

  it('shows the raw summary for a message recorded before runs were attached', () => {
    const host = fakePi();
    registerWorkflowFinishedRenderer(host.pi);

    const component = host.render({ runIds: ['run-1'] }, 'Workflow run zinc-lynx in workspace default completed.');

    expect(component.render(120).join('\n')).toContain('Workflow run zinc-lynx in workspace default completed.');
  });
});
