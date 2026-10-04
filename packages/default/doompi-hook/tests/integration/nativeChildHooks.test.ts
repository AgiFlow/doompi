import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  DoomChildSessionHandle,
  DoomChildSessionRequest,
  DoomChildSessionService,
} from '@agimon-ai/doompi-core/childSession';
import { createHeadlessChildSessionService, createTerminalPiChildSessionService } from '@agimon-ai/doompi-core/server';
import type { HeadlessChildSessionServiceOptions } from '@agimon-ai/doompi-core/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHookDocumentReader } from '../../src/services/hookDocuments';
import { createBashHookRunner } from '../../src/services/hookRunner';
import { createHookRuntime } from '../../src/services/hookRuntime';
import type { HookRuntimeBinding } from '../../src/services/hookRuntime/type';
import { piHarness, type PiHarness } from '../helpers/piSession';

type Models = NonNullable<HeadlessChildSessionServiceOptions['models']>;
type Model = ReturnType<Models['getModels']>[number];
type AssistantMessage = Awaited<ReturnType<Models['complete']>>;

const model: Model = {
  id: 'native-hook-test',
  name: 'Native hook test',
  api: 'test',
  provider: 'fixture',
  baseUrl: 'http://localhost',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65536,
  maxTokens: 256,
};

// Only model responses are doubled. Both adapters use their default real direct harness,
// SQLite journal, native bash tool, and HookRuntime.childHooks dispatcher.
function deterministicModels() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const results: string[] = [];
  let requests = 0;
  const models = {
    getModels: () => [model],
    getAvailable: async () => [model],
    getModel: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
    streamSimple: ((_model, context) => {
      requests += 1;
      const userIndex = context.messages.findLastIndex((message) => message.role === 'user');
      const user = context.messages[userIndex];
      const text =
        user?.role === 'user'
          ? typeof user.content === 'string'
            ? user.content
            : user.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('')
          : '';
      const result = context.messages.slice(userIndex + 1).find((message) => message.role === 'toolResult');
      const content: AssistantMessage['content'] = result
        ? [{ type: 'text', text: 'finished' }]
        : [
            {
              type: 'toolCall',
              id: 'fixture-call',
              name: 'bash',
              arguments: { command: text.slice('execute: '.length) },
            },
          ];
      if (result) results.push(JSON.stringify(result));
      const message: AssistantMessage = {
        role: 'assistant',
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: 0,
        stopReason: result ? 'stop' : 'toolUse',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      return {
        async *[Symbol.asyncIterator]() {
          await gate;
          yield { type: 'start', partial: message };
          yield { type: 'done', reason: message.stopReason, message };
        },
        result: async () => message,
      } as unknown as ReturnType<Models['streamSimple']>;
    }) satisfies Models['streamSimple'],
  } as unknown as Models;
  return { models, release, results, requests: () => requests };
}

let root = '';
let home = '';
let parent: PiHarness;
let runtime: HookRuntimeBinding;
const services: DoomChildSessionService[] = [];

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-child-hooks-'));
  home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(root, '.doom'));
  parent = piHarness({ root }, { provideConfig: false });
  await parent.provideConfig({ root });
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await runtime?.dispose();
  await parent.cordis.fiber.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

function hooks() {
  runtime = createHookRuntime(parent.cordis, {
    runner: createBashHookRunner(),
    documents: createHookDocumentReader({ homeDirectory: home, warn: () => undefined }),
  });
  return runtime.childHooks;
}

function request(adapter: string, runId: string, command: string): DoomChildSessionRequest {
  const snapshotJsonl =
    [
      { type: 'session', version: 3, id: 'parent-session', timestamp: '2026-01-01T00:00:00.000Z', cwd: root },
      {
        type: 'message',
        id: 'leaf',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'parent history' }] },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n';
  return {
    runId,
    parentSessionId: 'parent-session',
    scope: { rootSessionId: 'parent-session', scopeKey: 'test' },
    source:
      adapter === 'terminal'
        ? { kind: 'terminal-pi-fork', sourceSessionId: 'parent-session', sourceLeafId: 'leaf', snapshotJsonl }
        : { kind: 'fresh' },
    agent: runId,
    task: `execute: ${command}`,
    cwd: root,
    tools: ['bash'],
    environment: {},
  };
}

function service(adapter: string, fixture: ReturnType<typeof deterministicModels>) {
  const options = {
    cwd: root,
    sessionsRoot: path.join(root, 'sessions'),
    models: fixture.models,
    defaultModel: () => ({ provider: model.provider, id: model.id }),
    hooks: () => runtime.childHooks,
  };
  const child =
    adapter === 'terminal'
      ? createTerminalPiChildSessionService(options)
      : createHeadlessChildSessionService({ ...options, parentSessionId: 'parent-session' });
  services.push(child);
  return child;
}
async function completed(handle: DoomChildSessionHandle) {
  await vi.waitFor(() => expect(handle.state()).toBe('completed'), { timeout: 10000 });
}
function registry(rows: string[]) {
  fs.writeFileSync(path.join(root, '.doom', 'hooks.yaml'), `groups:\n  selected:\n    hooks:\n${rows.join('\n')}\n`);
}
function commandRow(event: string, command: string, skip = false) {
  return `      - event: ${event}\n        pi:\n          matcher: Bash\n          command: ${JSON.stringify(command)}${skip ? '\n          skipInSubagent: true' : ''}`;
}

interface Observed {
  label: string;
  payload: {
    session_id: string;
    parent_session_id: string;
    agent_type: string;
    hook_event_name: string;
    tool_name: string;
    cwd: string;
  };
}
function commandHooks() {
  const log = path.join(root, 'hooks.jsonl');
  const recorder = path.join(root, 'record.cjs');
  fs.writeFileSync(
    recorder,
    `const fs = require('node:fs');
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
const label = process.argv[2];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({label, payload}) + '\\n');
if (payload.hook_event_name === 'PostToolUse') console.log(JSON.stringify({hookSpecificOutput: {additionalContext: 'post ' + label}}));
else if (payload.tool_input.command.includes('denied.txt')) console.log(JSON.stringify({decision: 'block', reason: 'native denial'}));
`,
  );
  const script = path.join(root, 'hook.sh');
  fs.writeFileSync(script, `#!/bin/bash\n"${process.execPath}" "${recorder}" "$1"\n`);
  return {
    command: (label: string) => `bash "${script}" ${label}`,
    rows: (): Observed[] =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
  };
}

describe.each(['headless', 'terminal'])('%s native child hooks with real direct runtime', (adapter) => {
  it.each(['SessionStart', 'PreToolUse'])('blocks native bash when a required %s module is unsynced', async (event) => {
    registry([`      - event: ${event}\n        pi: {module: ./missing.mts}`]);
    hooks();
    const fixture = deterministicModels();
    const children = service(adapter, fixture);
    const handle = await children.start(request(adapter, 'unsynced', 'touch forbidden.txt'));
    fixture.release();
    await completed(handle);
    expect(fs.existsSync(path.join(root, 'forbidden.txt'))).toBe(false);
    expect(fixture.results.join('')).toContain('Run doompi sync');
  });

  it('uses authoritative isolated child identity, registry then plugin order, post appends, and no lifecycle hooks', async () => {
    const recorder = commandHooks();
    registry([
      commandRow('SessionStart', recorder.command('start')),
      commandRow('Stop', recorder.command('stop')),
      commandRow('PreToolUse', recorder.command('registry-pre')),
      commandRow('PreToolUse', recorder.command('skipped'), true),
      commandRow('PostToolUse', recorder.command('registry-post')),
    ]);
    const configPath = path.join(root, 'plugin-hooks.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ command: recorder.command('plugin-pre') }] }],
          PostToolUse: [{ matcher: 'Bash', hooks: [{ command: recorder.command('plugin-post') }] }],
          SessionStart: [{ hooks: [{ command: recorder.command('plugin-start') }] }],
          Stop: [{ hooks: [{ command: recorder.command('plugin-stop') }] }],
          SessionEnd: [{ hooks: [{ command: recorder.command('plugin-end') }] }],
        },
      }),
    );
    await parent.provideConfig({ root, pluginHooks: [{ pluginRoot: root, configPath }] });
    hooks();
    const fixture = deterministicModels();
    const children = service(adapter, fixture);
    const handles = await Promise.all(
      ['alpha', 'beta'].map((id) => children.start(request(adapter, id, `printf ${id} > ${id}.txt; printf ${id}`))),
    );
    await vi.waitFor(() => expect(fixture.requests()).toBe(2));
    fixture.release();
    await Promise.all(handles.map(completed));
    await Promise.all(handles.map((handle) => handle.dispose()));
    const rows = recorder.rows();
    const ids = handles.map((handle) => path.basename(handle.sessionFile!, '.sqlite'));
    expect(new Set(ids).size).toBe(2);
    for (const [index, agent] of ['alpha', 'beta'].entries()) {
      expect(fs.readFileSync(path.join(root, `${agent}.txt`), 'utf8')).toBe(agent);
      const own = rows.filter((row) => row.payload.agent_type === agent);
      expect(own.map((row) => row.label)).toEqual(['registry-pre', 'plugin-pre', 'registry-post', 'plugin-post']);
      for (const row of own)
        expect(row.payload).toMatchObject({
          session_id: ids[index],
          parent_session_id: 'parent-session',
          agent_type: agent,
          cwd: root,
          tool_name: 'Bash',
        });
      expect(own.map((row) => row.payload.hook_event_name)).toEqual([
        'PreToolUse',
        'PreToolUse',
        'PostToolUse',
        'PostToolUse',
      ]);
    }
    expect(rows).toHaveLength(8);
    expect(fixture.results).toHaveLength(2);
    for (const result of fixture.results) {
      expect(result).toContain('post registry-post');
      expect(result).toContain('post plugin-post');
      expect(result.indexOf('post registry-post')).toBeLessThan(result.indexOf('post plugin-post'));
    }
  });

  it('pins module artifacts and isolates setup state after parent runtime disposal', async () => {
    const source = path.join(root, 'stateful.ts');
    const artifact = path.join(root, 'stateful-old.mjs');
    const descriptor = path.join(root, 'modules-old.json');
    const log = path.join(root, 'module.jsonl');
    fs.writeFileSync(
      artifact,
      `import fs from 'node:fs';
export default { setup(owner) {
  let count = 0;
  const record = (phase, ctx = owner) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({phase, count, sessionId: ctx.sessionId, parentSessionId: ctx.parentSessionId, agent: ctx.agent, aborted: owner.signal.aborted}) + '\\n');
  record('setup');
  return {
    tool_call(event, ctx) { count++; record('pre', ctx); },
    async tool_result(event, ctx) {
      count++; record('post', ctx);
      await ctx.appendCustomEntry('child-module-proof', {agent: ctx.agent, count});
      return {content: [...event.content, {type: 'text', text: 'pinned-old-' + ctx.agent + '-' + count}]};
    },
    session_start() { record('unexpected-start'); },
    agent_settled() { record('unexpected-settled'); },
    dispose() { record('dispose'); }
  };
}};`,
    );
    fs.writeFileSync(descriptor, JSON.stringify({ version: 1, modules: [{ source, artifact }] }));
    registry(
      ['PreToolUse', 'PostToolUse', 'SessionStart', 'Stop'].map(
        (event) => `      - event: ${event}\n        pi:\n          module: ${JSON.stringify(source)}`,
      ),
    );
    await parent.provideConfig({ root, hookModules: { file: descriptor } });
    hooks();
    const fixture = deterministicModels();
    const children = service(adapter, fixture);
    const handles = await Promise.all(
      ['alpha', 'beta'].map((id) => children.start(request(adapter, id, `printf ${id}`))),
    );
    await vi.waitFor(() => expect(fixture.requests()).toBe(2));
    const replacement = path.join(root, 'modules-new.json');
    fs.writeFileSync(replacement, JSON.stringify({ version: 1, modules: [] }));
    await parent.provideConfig({ root, hookModules: { file: replacement } });
    await runtime.dispose();
    fixture.release();
    await Promise.all(handles.map(completed));
    await Promise.all(handles.map((handle) => handle.dispose()));
    const rows: Array<{
      phase: string;
      count: number;
      sessionId: string;
      parentSessionId: string;
      agent: string;
      aborted: boolean;
    }> = fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    for (const [index, agent] of ['alpha', 'beta'].entries()) {
      const own = rows.filter((row) => row.agent === agent);
      expect(own.map((row) => [row.phase, row.count])).toEqual([
        ['setup', 0],
        ['pre', 1],
        ['post', 2],
        ['dispose', 2],
      ]);
      for (const row of own)
        expect(row).toMatchObject({
          sessionId: path.basename(handles[index].sessionFile!, '.sqlite'),
          parentSessionId: 'parent-session',
        });
      expect(own.slice(0, 3).every((row) => !row.aborted)).toBe(true);
      expect(own[3].aborted).toBe(true);
      expect(fixture.results.some((result) => result.includes(`pinned-old-${agent}-2`))).toBe(true);
    }
    expect(rows).toHaveLength(8);
    expect(fixture.results).toHaveLength(2);
  });

  it('denies a real bash invocation before its filesystem side effect', async () => {
    const recorder = commandHooks();
    registry([
      commandRow('PreToolUse', recorder.command('deny')),
      commandRow('PreToolUse', recorder.command('unreachable')),
    ]);
    hooks();
    const fixture = deterministicModels();
    const children = service(adapter, fixture);
    const handle = await children.start(request(adapter, 'denied', 'touch denied.txt'));
    fixture.release();
    await completed(handle);
    expect(fs.existsSync(path.join(root, 'denied.txt'))).toBe(false);
    expect(recorder.rows().map((row) => row.label)).toEqual(['deny']);
    expect(fixture.results.join('')).toContain('native denial');
  });
});
