import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CHILD_TOOL_DIAGNOSTIC_PATH_ENV,
  INHERIT_PROJECT_CONTEXT_ENV,
  INHERIT_SKILLS_ENV,
  MCP_DIRECT_CHILD_TOOLS_ENV,
  REQUIRED_CHILD_TOOLS_ENV,
  STRUCTURED_OUTPUT_CAPTURE_ENV,
  STRUCTURED_OUTPUT_SCHEMA_ENV,
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_FANOUT_CHILD_ENV,
  SUBAGENT_INTERCOM_SESSION_NAME_ENV,
  SUBAGENT_RUN_ID_ENV,
  SUBAGENT_STEER_INBOX_ENV,
  TOOL_BUDGET_ENV,
} from '../../src/exports/env';
import {
  CHILD_FANOUT_BOUNDARY_INSTRUCTIONS,
  createPromptRuntimeDiagnostics,
  installSubagentPromptRuntime,
} from '../../src/adapters/pi/extensions/subagentPromptRuntime';

type RuntimeHandler = (event: unknown, context: ExtensionContext) => unknown;

interface RuntimeTool {
  readonly name: string;
  readonly execute: (id: string, params: { value: unknown }) => Promise<unknown>;
}

interface RuntimeHost {
  readonly pi: ExtensionAPI;
  readonly registeredTools: Map<string, RuntimeTool>;
  readonly sessionNames: string[];
  readonly trigger: (event: string, payload?: unknown, context?: ExtensionContext) => Promise<unknown[]>;
}

interface CordisEffects {
  readonly cordis: Context;
  readonly dispose: () => void;
}

const managedEnvironmentNames = [
  CHILD_TOOL_DIAGNOSTIC_PATH_ENV,
  INHERIT_PROJECT_CONTEXT_ENV,
  INHERIT_SKILLS_ENV,
  MCP_DIRECT_CHILD_TOOLS_ENV,
  REQUIRED_CHILD_TOOLS_ENV,
  STRUCTURED_OUTPUT_CAPTURE_ENV,
  STRUCTURED_OUTPUT_SCHEMA_ENV,
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_FANOUT_CHILD_ENV,
  SUBAGENT_INTERCOM_SESSION_NAME_ENV,
  SUBAGENT_RUN_ID_ENV,
  SUBAGENT_STEER_INBOX_ENV,
  TOOL_BUDGET_ENV,
] as const;

const savedEnvironment = new Map<string, string | undefined>();
const temporaryDirectories: string[] = [];

function fakeCordis(): CordisEffects {
  const cleanups: Array<() => void> = [];
  const cordis = {
    effect(setup: () => void | (() => void)) {
      const cleanup = setup();
      if (cleanup) cleanups.push(cleanup);
    },
  } as unknown as Context;
  return {
    cordis,
    dispose: () => {
      for (const cleanup of cleanups.toReversed()) cleanup();
    },
  };
}

function fakeHost(
  options: {
    readonly availableTools?: readonly string[];
    readonly sendUserMessage?: (content: string, options: { deliverAs: 'steer' }) => unknown;
    readonly setSessionName?: boolean;
  } = {},
): RuntimeHost {
  const handlers = new Map<string, RuntimeHandler[]>();
  const registeredTools = new Map<string, RuntimeTool>();
  const sessionNames: string[] = [];
  const pi = {
    on(event: string, handler: RuntimeHandler) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
    getAllTools: () => (options.availableTools ?? []).map((name) => ({ name })),
    registerTool: (tool: RuntimeTool) => registeredTools.set(tool.name, tool),
    ...(options.sendUserMessage ? { sendUserMessage: options.sendUserMessage } : {}),
    ...(options.setSessionName === false ? {} : { setSessionName: (name: string) => sessionNames.push(name) }),
  } as unknown as ExtensionAPI;
  const defaultContext = { model: { api: 'openai-responses' } } as unknown as ExtensionContext;
  return {
    pi,
    registeredTools,
    sessionNames,
    trigger: async (event, payload = {}, context = defaultContext) => {
      const results: unknown[] = [];
      for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, context));
      return results;
    },
  };
}

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-prompt-runtime-'));
  temporaryDirectories.push(directory);
  return directory;
}

beforeEach(() => {
  for (const name of managedEnvironmentNames) {
    savedEnvironment.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of managedEnvironmentNames) {
    const saved = savedEnvironment.get(name);
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
  savedEnvironment.clear();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('installSubagentPromptRuntime', () => {
  it('wires context filtering, prompt policy, and Cordis-owned cleanup', async () => {
    process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV] = 'review-child';
    process.env[INHERIT_PROJECT_CONTEXT_ENV] = '0';
    process.env[INHERIT_SKILLS_ENV] = '0';
    process.env[SUBAGENT_FANOUT_CHILD_ENV] = '1';
    const host = fakeHost();
    const effects = fakeCordis();

    installSubagentPromptRuntime(effects.cordis, host.pi);

    const unchangedMessages = [{ role: 'user', content: 'continue' }];
    expect(await host.trigger('context', { messages: unchangedMessages })).toContain(undefined);
    expect(
      await host.trigger('context', {
        messages: [{ role: 'custom', customType: 'subagent-notify' }, ...unchangedMessages],
      }),
    ).toContainEqual({ messages: unchangedMessages });

    const originalPrompt = [
      'task',
      '',
      '# Project Context',
      '',
      'Project-specific instructions and guidelines:',
      '',
      'private context',
      '',
      'The following skills provide specialized instructions for specific tasks.',
      'ambient skill',
      'Current date:',
      '2026-08-21',
    ].join('\n');
    const promptResults = await host.trigger('before_agent_start', { systemPrompt: originalPrompt });
    expect(host.sessionNames).toEqual(['review-child']);
    expect(promptResults).toContainEqual({
      systemPrompt: expect.stringContaining(CHILD_FANOUT_BOUNDARY_INSTRUCTIONS),
    });
    expect(JSON.stringify(promptResults)).not.toContain('private context');
    expect(JSON.stringify(promptResults)).not.toContain('ambient skill');

    delete process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV];
    delete process.env[INHERIT_PROJECT_CONTEXT_ENV];
    delete process.env[INHERIT_SKILLS_ENV];
    delete process.env[SUBAGENT_FANOUT_CHILD_ENV];
    expect(await host.trigger('before_agent_start', { systemPrompt: 'plain prompt' })).toContain(undefined);

    expect(() => effects.dispose()).not.toThrow();
  });

  it('reports child tool availability from the child registry and validates its environment handoff', async () => {
    const directory = makeTemporaryDirectory();
    const diagnosticPath = path.join(directory, 'tool-diagnostic.json');
    process.env[CHILD_TOOL_DIAGNOSTIC_PATH_ENV] = diagnosticPath;
    process.env[REQUIRED_CHILD_TOOLS_ENV] = JSON.stringify(['read', 'structured_output', 'mcp_search_web_search']);
    process.env[MCP_DIRECT_CHILD_TOOLS_ENV] = JSON.stringify(['mcp_search_web_search']);
    process.env[SUBAGENT_CHILD_AGENT_ENV] = 'reviewer';
    const host = fakeHost({ availableTools: ['structured_output'] });
    const effects = fakeCordis();
    installSubagentPromptRuntime(effects.cordis, host.pi);

    await host.trigger('agent_start');

    expect(JSON.parse(fs.readFileSync(diagnosticPath, 'utf8'))).toMatchObject({
      agent: 'reviewer',
      required: ['read', 'structured_output', 'mcp_search_web_search'],
      available: ['structured_output'],
      missing: ['mcp_search_web_search'],
      missingMcpDirectTools: ['mcp_search_web_search'],
    });

    process.env[MCP_DIRECT_CHILD_TOOLS_ENV] = 'not-json';
    await host.trigger('agent_start');
    expect(JSON.parse(fs.readFileSync(diagnosticPath, 'utf8'))).not.toHaveProperty('missingMcpDirectTools');

    process.env[MCP_DIRECT_CHILD_TOOLS_ENV] = JSON.stringify([42]);
    await host.trigger('agent_start');
    expect(JSON.parse(fs.readFileSync(diagnosticPath, 'utf8'))).not.toHaveProperty('missingMcpDirectTools');

    delete process.env[CHILD_TOOL_DIAGNOSTIC_PATH_ENV];
    await expect(host.trigger('agent_start')).resolves.toBeDefined();
    process.env[CHILD_TOOL_DIAGNOSTIC_PATH_ENV] = diagnosticPath;
    process.env[REQUIRED_CHILD_TOOLS_ENV] = JSON.stringify(['']);
    await expect(host.trigger('agent_start')).rejects.toThrow(`Invalid ${REQUIRED_CHILD_TOOLS_ENV} payload.`);

    effects.dispose();
  });

  it('nudges at the soft tool limit, records rejected nudges, and blocks only capped tools past hard', async () => {
    process.env[TOOL_BUDGET_ENV] = JSON.stringify({ soft: 1, hard: 2, block: ['read'] });
    const diagnostics = createPromptRuntimeDiagnostics();
    const host = fakeHost({
      sendUserMessage: () => {
        throw new Error('steering unavailable');
      },
    });
    const effects = fakeCordis();
    installSubagentPromptRuntime(effects.cordis, host.pi, diagnostics);

    const first = await host.trigger('tool_call', { toolName: 'grep' });
    const second = await host.trigger('tool_call', { toolName: 'read' });
    const third = await host.trigger('tool_call', { toolName: 'read' });
    const fourth = await host.trigger('tool_call', {});

    expect(first).not.toContainEqual(expect.objectContaining({ block: true }));
    expect(second).not.toContainEqual(expect.objectContaining({ block: true }));
    expect(third).toContainEqual({ block: true, reason: expect.stringContaining("The 'read' tool is blocked") });
    expect(fourth).not.toContainEqual(expect.objectContaining({ block: true }));
    expect(diagnostics).toMatchObject({
      steerNudgeFailures: 1,
      lastError: expect.objectContaining({ message: 'steering unavailable' }),
    });

    effects.dispose();
  });

  it('registers a terminating structured-output tool that rejects invalid values and persists valid ones privately', async () => {
    const directory = makeTemporaryDirectory();
    const schemaPath = path.join(directory, 'schema.json');
    const outputPath = path.join(directory, 'result', 'structured.json');
    fs.writeFileSync(
      schemaPath,
      JSON.stringify({
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      }),
    );
    process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = outputPath;
    process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = schemaPath;
    const host = fakeHost({ setSessionName: false });
    const effects = fakeCordis();

    installSubagentPromptRuntime(effects.cordis, host.pi);

    const tool = host.registeredTools.get('structured_output');
    expect(tool).toBeDefined();
    await expect(tool?.execute('call-invalid', { value: { answer: 42 } })).rejects.toThrow(
      'Structured output validation failed',
    );
    await expect(tool?.execute('call-valid', { value: { answer: 'complete' } })).resolves.toMatchObject({
      terminate: true,
      details: { path: outputPath },
    });
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf8'))).toEqual({ answer: 'complete' });
    expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);

    process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV] = 'ignored-without-host-method';
    expect(await host.trigger('before_agent_start', { systemPrompt: 'unchanged' })).toContain(undefined);
    effects.dispose();
  });
});
