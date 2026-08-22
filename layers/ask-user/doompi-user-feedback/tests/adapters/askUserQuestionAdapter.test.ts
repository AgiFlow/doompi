import {
  DOOM_ASK_USER_BLOCKED_EVENT,
  DOOM_ASK_USER_PROMPT_EVENT,
} from '@agimon-ai/doompi-extension-contracts/ask-user';
import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import {
  type AskUserQuestionToolDependencies,
  registerAskUserQuestionTool,
} from '../../src/adapters/pi/askUserQuestionAdapter.js';
import type { QuestionParams } from '../../src/schemas/questionnaire.js';
import type { ToolTextResult } from '../../src/types/questionnaire.js';

interface Renderable {
  render(width: number): string[];
}

interface RegisteredTool {
  name: string;
  executionMode?: string;
  renderShell?: string;
  execute(
    callId: string,
    params: QuestionParams,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: ExtensionContext,
  ): Promise<ToolTextResult>;
  renderCall(args: unknown, theme: unknown, context: unknown): Renderable;
  renderResult(result: unknown, options: unknown, theme: unknown, context: unknown): Renderable;
}

const params: QuestionParams = {
  questions: [
    {
      question: 'Which option?',
      header: 'Choice',
      options: [
        { label: 'One', description: 'First option.', preview: 'preview one' },
        { label: 'Two', description: 'Second option.' },
      ],
    },
  ],
};

function createContext(
  overrides: {
    hasUI?: boolean;
    mode?: 'tui' | 'rpc' | 'print';
    select?: ReturnType<typeof vi.fn>;
    input?: ReturnType<typeof vi.fn>;
  } = {},
): ExtensionContext {
  return {
    hasUI: overrides.hasUI ?? true,
    mode: overrides.mode ?? 'tui',
    ui: {
      select: overrides.select ?? vi.fn(),
      input: overrides.input ?? vi.fn(),
    },
  } as unknown as ExtensionContext;
}

function createTool(dependencies: Partial<AskUserQuestionToolDependencies> = {}): {
  tool: RegisteredTool;
  emitted: Array<{ event: string; payload: unknown }>;
} {
  let tool: RegisteredTool | undefined;
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const cordis = new Context();
  cordis.on(DOOM_ASK_USER_PROMPT_EVENT, (payload) => {
    emitted.push({ event: DOOM_ASK_USER_PROMPT_EVENT, payload });
  });
  cordis.on(DOOM_ASK_USER_BLOCKED_EVENT, (payload) => {
    emitted.push({ event: DOOM_ASK_USER_BLOCKED_EVENT, payload });
  });
  const pi = {
    registerTool: (definition: unknown) => {
      tool = definition as RegisteredTool;
    },
  } as unknown as ExtensionAPI;
  const defaults: AskUserQuestionToolDependencies = {
    enqueue: async (runner, signal) =>
      runner({
        signal: signal ?? new AbortController().signal,
        reportProgress: () => undefined,
      }),
    runTui: async () => ({
      answers: [
        {
          questionIndex: 0,
          question: 'Which option?',
          kind: 'option',
          answer: 'One',
          preview: 'preview one',
        },
      ],
      cancelled: false,
    }),
  };
  registerAskUserQuestionTool(pi, cordis, { ...defaults, ...dependencies });
  if (!tool) throw new Error('Tool was not registered');
  return { tool, emitted };
}

async function execute(tool: RegisteredTool, context: ExtensionContext, value = params) {
  return tool.execute('call-1', value, undefined, undefined, context);
}

describe('ask_user_question Pi adapter', () => {
  it('registers a sequential tool and checks hasUI before questionnaire validation', async () => {
    const enqueue = vi.fn();
    const { tool, emitted } = createTool({ enqueue });

    const response = await execute(tool, createContext({ hasUI: false, mode: 'print' }), {
      questions: [],
    } as QuestionParams);

    expect(tool.name).toBe('ask_user_question');
    expect(tool.executionMode).toBe('sequential');
    expect(tool.renderShell).toBe('self');
    expect(response.details.error).toBe('no_ui');
    expect(response.content[0]?.text).toContain('UI not available');
    expect(enqueue).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it('fences tool execution when its session context is stale', async () => {
    const enqueue = vi.fn();
    const { tool, emitted } = createTool({ enqueue, isActive: () => false });

    const response = await execute(tool, createContext());

    expect(response.details).toEqual({ answers: [], cancelled: true });
    expect(response.content[0]?.text).toContain('session is no longer active');
    expect(enqueue).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it('returns validation errors without queueing or emitting events', async () => {
    const enqueue = vi.fn();
    const { tool, emitted } = createTool({ enqueue });
    const invalid: QuestionParams = {
      questions: [
        {
          question: 'Reserved?',
          header: 'Invalid',
          options: [
            { label: 'Other', description: 'Reserved.' },
            { label: 'Valid', description: 'Allowed.' },
          ],
        },
      ],
    };

    const response = await execute(tool, createContext(), invalid);

    expect(response.details.error).toBe('reserved_label');
    expect(enqueue).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it('emits the immutable prompt payload and balanced blocking around active TUI work', async () => {
    const observed: unknown[] = [];
    const runTui = vi.fn(async () => {
      observed.push('run-tui');
      return {
        answers: [
          {
            questionIndex: 0,
            question: 'Which option?',
            kind: 'option' as const,
            answer: 'One',
            preview: 'preview one',
          },
        ],
        cancelled: false,
      };
    });
    const { tool, emitted } = createTool({ runTui });

    const response = await execute(tool, createContext());

    expect(response.content[0]?.text).toContain('User has answered your questions:');
    expect(runTui).toHaveBeenCalledOnce();
    expect(observed).toEqual(['run-tui']);
    expect(emitted).toEqual([
      {
        event: DOOM_ASK_USER_PROMPT_EVENT,
        payload: {
          questions: [
            {
              question: 'Which option?',
              header: 'Choice',
              multiSelect: false,
              options: [
                {
                  label: 'One',
                  description: 'First option.',
                  hasPreview: true,
                },
                {
                  label: 'Two',
                  description: 'Second option.',
                  hasPreview: false,
                },
              ],
            },
          ],
        },
      },
      { event: DOOM_ASK_USER_BLOCKED_EVENT, payload: { active: true } },
      { event: DOOM_ASK_USER_BLOCKED_EVENT, payload: { active: false } },
    ]);
  });

  it('uses RPC select/input without loading TUI and balances blocking', async () => {
    const select = vi.fn(async () => 'One');
    const input = vi.fn();
    const runTui = vi.fn();
    const { tool, emitted } = createTool({ runTui });

    const response = await execute(tool, createContext({ mode: 'rpc', select, input }));

    expect(response.details.answers[0]).toMatchObject({ kind: 'option', answer: 'One' });
    expect(select).toHaveBeenCalledOnce();
    expect(input).not.toHaveBeenCalled();
    expect(runTui).not.toHaveBeenCalled();
    expect(emitted.map((event) => event.event)).toEqual([
      DOOM_ASK_USER_PROMPT_EVENT,
      DOOM_ASK_USER_BLOCKED_EVENT,
      DOOM_ASK_USER_BLOCKED_EVENT,
    ]);
  });

  it('falls back to RPC dialogs when custom TUI resolves unavailable', async () => {
    const select = vi.fn(async () => 'Two');
    const runTui = vi.fn(async () => undefined);
    const { tool } = createTool({ runTui });

    const response = await execute(tool, createContext({ select, input: vi.fn() }));

    expect(runTui).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();
    expect(response.details.answers[0]).toMatchObject({ kind: 'option', answer: 'Two' });
  });

  it('reports no_custom_ui when neither custom nor dialog UI is available', async () => {
    const runTui = vi.fn(async () => undefined);
    const { tool } = createTool({ runTui });
    const context = { hasUI: true, mode: 'tui', ui: {} } as unknown as ExtensionContext;

    const response = await execute(tool, context);

    expect(response.details.error).toBe('no_custom_ui');
    expect(response.content[0]?.text).toContain('user never saw the questions');
  });

  it('hands active autonomous voice off without UI or blocked events', async () => {
    const runTui = vi.fn();
    const tryVoice = vi.fn(() => ({
      answers: [],
      cancelled: false,
      delivery: 'voice' as const,
      awaitingResponse: true,
      voicePrompt: 'Which option?\n  1. One\n  2. Two\n  Type something.',
    }));
    const select = vi.fn(() => {
      throw new Error('select must not run');
    });
    const input = vi.fn(() => {
      throw new Error('input must not run');
    });
    const { tool, emitted } = createTool({ runTui, tryVoice });

    const response = await execute(tool, createContext({ select, input }));

    expect(tryVoice).toHaveBeenCalledExactlyOnceWith(params);
    expect(runTui).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      terminate: true,
      details: {
        answers: [],
        cancelled: false,
        delivery: 'voice',
        awaitingResponse: true,
        voicePrompt: 'Which option?\n  1. One\n  2. Two\n  Type something.',
      },
    });
    expect(response.content[0]?.text).toContain("wait for the user's next message");
    const rendered = tool
      .renderResult(
        response,
        {},
        {
          fg: (_color: string, text: string) => text,
          bg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
        {},
      )
      .render(200)
      .join('\n');
    expect(rendered).toContain('Which option?');
    expect(rendered).toContain('1. One');
    expect(rendered).toContain('2. Two');
    expect(emitted.map((event) => event.event)).toEqual([DOOM_ASK_USER_PROMPT_EVENT]);
  });

  it('falls back to TUI when autonomous voice is inactive', async () => {
    const runTui = vi.fn(async () => ({ answers: [], cancelled: true }));
    const { tool } = createTool({ runTui, tryVoice: () => undefined });

    const response = await execute(tool, createContext());

    expect(runTui).toHaveBeenCalledOnce();
    expect(response.details.cancelled).toBe(true);
    expect(response.terminate).toBeUndefined();
  });

  it('renders compact calls and normal, cancelled, and unstructured results', () => {
    const { tool } = createTool();
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      inverse: (text: string) => text,
    };
    const render = (value: Renderable): string => value.render(200).join('\n');

    expect(render(tool.renderCall(params, theme, {}))).toContain(' ASK  1 question (Choice)');
    expect(
      render(
        tool.renderResult(
          {
            content: [{ type: 'text', text: 'ignored' }],
            details: {
              answers: [
                {
                  questionIndex: 0,
                  question: 'Which option?',
                  kind: 'multi',
                  answer: null,
                  selected: ['One', 'Two'],
                },
              ],
              cancelled: false,
            },
          },
          {},
          theme,
          { isError: false },
        ),
      ),
    ).toContain('Which option?: One, Two');
    expect(
      render(
        tool.renderResult(
          { content: [{ type: 'text', text: 'declined' }], details: { answers: [], cancelled: true } },
          {},
          theme,
          { isError: false },
        ),
      ),
    ).toContain('◐ cancelled');
    expect(
      render(tool.renderResult({ content: [{ type: 'text', text: 'plain result' }] }, {}, theme, { isError: false })),
    ).toContain('plain result');
  });

  it('clears blocked state and returns a structured load error when TUI fails', async () => {
    const { tool, emitted } = createTool({
      runTui: async () => {
        throw new Error('render graph unavailable');
      },
    });

    const response = await execute(tool, createContext());

    expect(response.details.error).toBe('session_load_failed');
    expect(response.content[0]?.text).toContain('render graph unavailable');
    expect(emitted.at(-1)).toEqual({
      event: DOOM_ASK_USER_BLOCKED_EVENT,
      payload: { active: false },
    });
  });

  it('formats non-Error presentation failures without leaking an exception', async () => {
    const { tool } = createTool({
      runTui: async () => Promise.reject('string failure'),
    });

    const response = await execute(tool, createContext());

    expect(response.details.error).toBe('session_load_failed');
    expect(response.content[0]?.text).toContain('string failure');
  });
});
