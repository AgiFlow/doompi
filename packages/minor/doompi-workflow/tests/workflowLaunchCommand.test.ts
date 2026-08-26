import { describe, expect, it } from 'vitest';
import {
  isLaunchParseFailure,
  parseWorkflowLaunchCommand,
  resolveWorkflowEntry,
  validateWorkflowLaunch,
  workflowLaunchCommand,
} from '../src/services/workflowLaunchCommand.ts';
import { WORKFLOW_LAUNCH_VERB, workflowLaunchLine } from '../web/launchLine.ts';

describe('parseWorkflowLaunchCommand', () => {
  it('reads the workflow, the runner, the inputs and the prompt', () => {
    const parsed = parseWorkflowLaunchCommand(
      'dev-feature runner=cmux branch=feat/web-cockpit-plugins Give the cockpit a workflows catalog.',
    );
    expect(parsed).toEqual({
      workflow: 'dev-feature',
      runner: 'cmux',
      inputs: { branch: 'feat/web-cockpit-plugins' },
      prompt: 'Give the cockpit a workflows catalog.',
    });
  });

  it('keeps a quoted value together', () => {
    const parsed = parseWorkflowLaunchCommand('blog-writing brief="a post about context budgets"');
    expect(isLaunchParseFailure(parsed)).toBe(false);
    if (isLaunchParseFailure(parsed)) return;
    expect(parsed.inputs.brief).toBe('a post about context budgets');
  });

  // Pairs stop at the first token that is not one, so a prompt keeps its own
  // punctuation instead of being read as another input.
  it('takes the rest of the line as the prompt, equals signs and all', () => {
    const parsed = parseWorkflowLaunchCommand('dev-fix Fix the parser so a=b in prose survives.');
    expect(isLaunchParseFailure(parsed)).toBe(false);
    if (isLaunchParseFailure(parsed)) return;
    expect(parsed.prompt).toBe('Fix the parser so a=b in prose survives.');
    expect(parsed.inputs).toEqual({});
  });

  it('accepts a workflow with no inputs and no prompt', () => {
    expect(parseWorkflowLaunchCommand('dev-fix')).toEqual({ workflow: 'dev-fix', inputs: {} });
  });

  it('refuses an empty line with the usage', () => {
    const parsed = parseWorkflowLaunchCommand('   ');
    expect(isLaunchParseFailure(parsed)).toBe(true);
    if (!isLaunchParseFailure(parsed)) return;
    expect(parsed.error).toContain('Usage: /workflow-launch');
  });
});

describe('workflowLaunchCommand', () => {
  it('builds a line the parser reads back unchanged', () => {
    const request = {
      workflow: 'blog-writing',
      runner: 'tmux',
      inputs: { brief: 'a post about context budgets' },
      prompt: 'Draft it for the blog.',
    };
    const line = workflowLaunchCommand(request);
    expect(line).toBe(
      '/workflow-launch blog-writing runner=tmux brief="a post about context budgets" Draft it for the blog.',
    );
    expect(parseWorkflowLaunchCommand(line.replace('/workflow-launch ', ''))).toEqual(request);
  });

  it('leaves out what the dialog collected nothing for', () => {
    expect(workflowLaunchCommand({ workflow: 'dev-fix', inputs: {} })).toBe('/workflow-launch dev-fix');
  });
});

describe('resolveWorkflowEntry', () => {
  const entries = [
    {
      name: 'Blog Writing',
      path: '/repo/automations/blog.workflow.yml',
      relativePath: 'automations/blog.workflow.yml',
    },
    {
      name: 'Dev Feature',
      path: '/repo/automations/dev-feature.workflow.yml',
      relativePath: 'automations/dev-feature.workflow.yml',
    },
  ];

  // The catalog shows names as their author capitalised them, and nobody types
  // that back exactly.
  it('matches a name whatever its case', () => {
    expect(resolveWorkflowEntry(entries, 'blog writing')?.name).toBe('Blog Writing');
  });

  it('matches a repository path and its tail', () => {
    expect(resolveWorkflowEntry(entries, 'automations/dev-feature.workflow.yml')?.name).toBe('Dev Feature');
    expect(resolveWorkflowEntry(entries, 'dev-feature.workflow.yml')?.name).toBe('Dev Feature');
  });

  it('answers nothing when the token names no workflow', () => {
    expect(resolveWorkflowEntry(entries, 'release-cut')).toBeUndefined();
  });
});

describe('validateWorkflowLaunch', () => {
  // A prompt-triggered workflow launched without one starts and then waits for
  // terminal input forever, which reads as the launch having worked.
  it('requires a prompt for a prompt-triggered workflow', () => {
    const problems = validateWorkflowLaunch({ triggers: ['user_prompt'], inputs: [] }, { inputs: {} });
    expect(problems).toEqual(['This workflow is triggered by a prompt, so it needs one.']);
  });

  it('names every required input that is missing', () => {
    const problems = validateWorkflowLaunch(
      { triggers: [], inputs: [{ name: 'brief', required: true }, { name: 'tone' }] },
      { inputs: {} },
    );
    expect(problems).toEqual(['Missing required input: brief.']);
  });

  it('holds a value to the options the workflow declared', () => {
    const problems = validateWorkflowLaunch(
      { triggers: [], inputs: [{ name: 'tone', options: ['practical', 'playful'] }] },
      { inputs: { tone: 'silly' } },
    );
    expect(problems).toEqual(['Input tone must be one of: practical, playful.']);
  });

  it('refuses a runner the workflow never declared', () => {
    const problems = validateWorkflowLaunch(
      { triggers: [], inputs: [], runners: ['tmux'] },
      { inputs: {}, runner: 'cmux' },
    );
    expect(problems).toEqual(['Runner cmux is not one this workflow declares: tmux.']);
  });

  // No runner map at all means the steps take any runner, which is not the
  // same as a map they all disagree on.
  it('accepts any runner when the workflow declares no runner map', () => {
    expect(validateWorkflowLaunch({ triggers: [], inputs: [] }, { inputs: {}, runner: 'cmux' })).toEqual([]);
  });
});

// The cockpit builds this line and the session parses it, in two halves that
// cannot import each other: the bundle may not reach into src/services. This
// is the only thing keeping them in step.
describe('the line the cockpit builds and the session parses', () => {
  it('survives the trip with every field intact', () => {
    const request = {
      workflow: 'Blog Writing',
      runner: 'tmux',
      inputs: { brief: 'a post about context budgets', tone: 'practical' },
      prompt: 'Draft it, and keep a=b in the prose.',
    };
    const line = workflowLaunchLine(request);
    const parsed = parseWorkflowLaunchCommand(line.slice(`${WORKFLOW_LAUNCH_VERB} `.length));
    expect(parsed).toEqual(request);
  });

  it('drops an empty input rather than sending a blank value', () => {
    const line = workflowLaunchLine({ workflow: 'dev-fix', inputs: { branch: '' } });
    expect(line).toBe('/workflow-launch dev-fix');
  });
});
