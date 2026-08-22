import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BashRunResult, IBashRunService } from '../../src/types/bashRunService';
import { registerBashTool } from '../../src/exports/tool/bashTool';
import type { BashParams } from '../../src/exports/tool/schema';

interface RegisteredTool {
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  renderShell?: 'default' | 'self';
  execute(
    toolCallId: string,
    params: BashParams,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: unknown,
  ): Promise<unknown>;
  renderResult?(
    result: { content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> },
    options: { expanded: boolean; isPartial: boolean },
    theme: Theme,
    context: { isError: boolean },
  ): { render(width: number): string[] };
}

const theme = {
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

function captureTool(result: BashRunResult | Error, onRunnerStarted: (id: string) => void): RegisteredTool {
  let registered: RegisteredTool | undefined;
  const pi = {
    registerTool: (tool: unknown) => {
      registered = tool as RegisteredTool;
    },
  } as unknown as ExtensionAPI;
  const bashRunService: IBashRunService = {
    run: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };

  registerBashTool(pi, {
    bashRunService,
    getSessionId: () => 'session-a',
    onRunnerStarted,
  });

  if (!registered) throw new Error('bash tool was not registered');
  return registered;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerBashTool', () => {
  it('keeps model guidance concise and prevents unchanged retries', () => {
    const tool = captureTool(
      {
        kind: 'completed',
        id: 'runner-guidance',
        name: 'echo',
        output: 'done',
        exitCode: 0,
        signal: null,
        logPath: '/tmp/guidance.log',
        backend: 'native',
      },
      vi.fn(),
    );
    const guidelines = tool.promptGuidelines?.join('\n') ?? '';

    expect(tool.description).toContain('Execute one Bash command');
    expect(tool.description).toContain('Do not rerun a command merely to recover output');
    expect(tool.promptSnippet).toContain('bounded foreground output');
    expect(guidelines).toContain('use the returned output first');
    expect(guidelines).toContain('Inspect the saved log only when');
    expect(guidelines).toContain('Never retry an unchanged command');
    expect(guidelines).not.toContain('retry once');
  });

  it('returns one guarded instruction when execution fails before a result', async () => {
    const tool = captureTool(new Error('working directory missing'), vi.fn());
    let message = '';

    try {
      await tool.execute('call-failed', { command: 'pwd' }, undefined, undefined, {});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe(
      'Could not execute command: working directory missing\nNext: verify the command, runtime, and working directory. Retry only after correcting the cause.',
    );
  });

  it('owns its render shell so Pi does not apply the global success background', () => {
    const tool = captureTool(
      {
        kind: 'completed',
        id: 'runner-shell',
        name: 'echo',
        output: 'done',
        exitCode: 0,
        signal: null,
        logPath: '/tmp/echo.log',
        backend: 'native',
      },
      vi.fn(),
    );

    expect(tool.renderShell).toBe('self');
  });

  it('renders thrown command failures from the render context instead of reporting success', () => {
    const tool = captureTool(
      {
        kind: 'completed',
        id: 'runner-error',
        name: 'failed-command',
        output: 'boom',
        exitCode: 1,
        signal: null,
        logPath: '/tmp/failed-command.log',
        backend: 'native',
      },
      vi.fn(),
    );

    const rendered = tool
      .renderResult?.(
        { content: [{ type: 'text', text: 'boom' }], details: {} },
        { expanded: false, isPartial: false },
        theme,
        { isError: true },
      )
      .render(80)
      .join('\n');

    expect(rendered).toContain('boom');
    expect(rendered).toContain('✗ failed');
    expect(rendered).not.toContain('✓ done');
  });

  it('passes the promoted runner ID to the refresh callback', async () => {
    const onRunnerStarted = vi.fn();
    const tool = captureTool(
      {
        kind: 'promoted',
        id: 'runner-a',
        name: 'api',
        pid: 42,
        logPath: '/tmp/api.log',
        backend: 'native',
        reason: 'requested',
      },
      onRunnerStarted,
    );

    await tool.execute('call-a', { command: 'sleep 60', background: true }, undefined, undefined, {});

    expect(onRunnerStarted).toHaveBeenCalledOnce();
    expect(onRunnerStarted).toHaveBeenCalledWith('runner-a');
  });

  it('does not monitor a runner that completed in the foreground', async () => {
    const onRunnerStarted = vi.fn();
    const tool = captureTool(
      {
        kind: 'completed',
        id: 'runner-b',
        name: 'echo',
        output: 'done',
        exitCode: 0,
        signal: null,
        logPath: '/tmp/echo.log',
        backend: 'native',
      },
      onRunnerStarted,
    );

    await tool.execute('call-b', { command: 'echo done' }, undefined, undefined, {});

    expect(onRunnerStarted).not.toHaveBeenCalled();
  });
});
