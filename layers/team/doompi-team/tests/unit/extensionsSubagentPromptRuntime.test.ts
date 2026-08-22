import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  decodeProtectedParentProcessIds,
  SUBAGENT_CHILD_INDEX_ENV,
  SUBAGENT_FANOUT_CHILD_ENV,
  SUBAGENT_STEER_ACK_DIR_ENV,
  SUBAGENT_STEER_CAPABILITY_ENV,
  SUBAGENT_STEER_INBOX_ENV,
} from '../../src/exports/env';
import {
  CHILD_CONTEXT_FIRST_INSTRUCTIONS,
  CHILD_FANOUT_BOUNDARY_INSTRUCTIONS,
  CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
  createPromptRuntimeDiagnostics,
  extractAssistantSummaryText,
  formatSteerMessage,
  parentProcessTerminationBlockReason,
  registerParentProcessGuard,
  registerSteeringInbox,
  rewriteSubagentPrompt,
  stripInheritedSkills,
  stripParentOnlySubagentMessages,
  stripProjectContext,
  stripSubagentOrchestrationSkill,
} from '../../src/adapters/pi/extensions/subagentPromptRuntime';

// ============================================================================
// Prompt rewriting: pure string transforms
// ============================================================================

describe('stripProjectContext', () => {
  it('removes the project-context section up to the next known header', () => {
    const prompt =
      'intro\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\nsecret stuff\nCurrent date:\n2026-01-01';
    expect(stripProjectContext(prompt)).toBe('intro\nCurrent date:\n2026-01-01');
  });

  it('leaves a prompt with no project-context header unchanged', () => {
    const prompt = 'just a plain prompt';
    expect(stripProjectContext(prompt)).toBe(prompt);
  });
});

describe('stripInheritedSkills', () => {
  it('removes the skills section up to the date header', () => {
    const prompt =
      'intro\n\nThe following skills provide specialized instructions for specific tasks.\nskill body\nCurrent date:\n2026-01-01';
    expect(stripInheritedSkills(prompt)).toBe('intro\nCurrent date:\n2026-01-01');
  });
});

describe('stripSubagentOrchestrationSkill', () => {
  it('removes a pi-subagents skill block by name, leaving other skill blocks intact', () => {
    const prompt = [
      'before',
      '<skill name="pi-subagents">orchestration instructions</skill>',
      '<skill name="other-skill">keep me</skill>',
      'after',
    ].join('\n');
    const result = stripSubagentOrchestrationSkill(prompt);
    expect(result).not.toContain('orchestration instructions');
    expect(result).toContain('keep me');
  });
});

describe('rewriteSubagentPrompt', () => {
  const originalCapture = process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;

  afterEach(() => {
    if (originalCapture === undefined) delete process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;
    else process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE = originalCapture;
  });

  it('prepends the standard child boundary instructions to the prompt', () => {
    delete process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;
    const rewritten = rewriteSubagentPrompt('do the task', { inheritProjectContext: true, inheritSkills: true });
    expect(rewritten).toContain(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS);
    expect(rewritten).toContain(CHILD_CONTEXT_FIRST_INSTRUCTIONS);
    expect(rewritten).toContain('do the task');
  });

  it('uses the fanout boundary instructions instead when fanoutChild is true', () => {
    const rewritten = rewriteSubagentPrompt('do the task', {
      inheritProjectContext: true,
      inheritSkills: true,
      fanoutChild: true,
    });
    expect(rewritten).toContain(CHILD_FANOUT_BOUNDARY_INSTRUCTIONS);
    expect(rewritten).toContain(CHILD_CONTEXT_FIRST_INSTRUCTIONS);
    expect(rewritten.startsWith(CHILD_FANOUT_BOUNDARY_INSTRUCTIONS)).toBe(true);
  });

  it('makes a supplied parent pack satisfy initial exploration before narrow expansion', () => {
    expect(CHILD_CONTEXT_FIRST_INSTRUCTIONS).toContain('authoritative starting point');
    expect(CHILD_CONTEXT_FIRST_INSTRUCTIONS).toContain('satisfies generic instructions to explore');
    expect(CHILD_CONTEXT_FIRST_INSTRUCTIONS).toContain('Read its listed paths directly before broad discovery');
    expect(CHILD_CONTEXT_FIRST_INSTRUCTIONS).toContain('Do not begin with repository-wide listing, find, or grep');
    expect(CHILD_CONTEXT_FIRST_INSTRUCTIONS).toContain('naming a concrete missing dependency or invalid path');
    expect(CHILD_CONTEXT_FIRST_INSTRUCTIONS).toContain('search narrowly for that item');
  });

  it('keeps context-first and structured-output instructions single-copy when prompt rewriting repeats', () => {
    process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE = '/tmp/structured-output.json';
    const options = { inheritProjectContext: true, inheritSkills: true };
    const once = rewriteSubagentPrompt('do the task', options);
    const twice = rewriteSubagentPrompt(once, options);

    expect(twice).toBe(once);
    expect(twice.split(CHILD_CONTEXT_FIRST_INSTRUCTIONS)).toHaveLength(2);
    expect(twice.split('This subagent step has a strict structured output contract.')).toHaveLength(2);
  });

  it('strips project context and skills when both are declined', () => {
    const prompt =
      'body\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\nsecret\n\nThe following skills provide specialized instructions for specific tasks.\nskill body';
    const rewritten = rewriteSubagentPrompt(prompt, { inheritProjectContext: false, inheritSkills: false });
    expect(rewritten).not.toContain('secret');
    expect(rewritten).not.toContain('skill body');
  });

  it('removes ambient skills and orchestration while preserving separately configured skill metadata', () => {
    const prompt = [
      'body',
      '',
      'The following configured skills are available to this subagent.',
      '<available_skills>',
      '  <skill>',
      '    <name>configured-review</name>',
      '    <description>Configured metadata survives</description>',
      '    <location>/skills/configured-review/SKILL.md</location>',
      '  </skill>',
      '</available_skills>',
      '',
      'The following skills provide specialized instructions for specific tasks.',
      '<skill name="ambient-only">ambient body</skill>',
      '<skill name="pi-subagents">orchestration body</skill>',
      'Current date:',
      '2026-08-08',
    ].join('\n');

    const rewritten = rewriteSubagentPrompt(prompt, { inheritProjectContext: true, inheritSkills: false });

    expect(rewritten).toContain('<name>configured-review</name>');
    expect(rewritten).toContain('/skills/configured-review/SKILL.md');
    expect(rewritten).not.toContain('ambient body');
    expect(rewritten).not.toContain('orchestration body');
  });
});

describe('parent process guard', () => {
  const protectedProcessIds = [4101, 4102];

  it('decodes only safe, positive, unique protected process ids', () => {
    expect(decodeProtectedParentProcessIds('[4101,4102,4101,1,0,-2,"4103",null]')).toEqual([4101, 4102]);
    expect(decodeProtectedParentProcessIds('{"pid":4101}')).toEqual([]);
    expect(decodeProtectedParentProcessIds('not-json')).toEqual([]);
  });

  it.each([
    'kill 4101',
    '/bin/kill -TERM -- 4102',
    'kill -- -4101',
    'kill $PPID',
    'node -e "process.kill(process.ppid, \'SIGHUP\')"',
    'python3 -c "import os; os.kill(os.getppid(), 15)"',
    'python3 -c "import os; os.killpg(4101, 15)"',
    'kill "$worker_pid"',
    'kill $(pgrep -f pi)',
    'ps -Ao pid= | xargs kill',
    'kill -1',
    'pkill -f pi',
    'killall node',
    'tmux kill-session -t workflow',
    'cmux close workspace',
  ])('blocks parent or broad workflow termination through Bash: %s', (command) => {
    expect(parentProcessTerminationBlockReason(command, protectedProcessIds)).toContain(
      'cannot signal parent or workflow processes',
    );
  });

  it.each(['pnpm test', 'kill 9999', 'node scripts/cleanup.js', 'echo process 4101 is still alive'])(
    'keeps non-parent Bash work available: %s',
    (command) => {
      expect(parentProcessTerminationBlockReason(command, protectedProcessIds)).toBeUndefined();
    },
  );

  it('registers a Bash-only tool-call gate without removing the Bash tool', () => {
    let handler: ((event: unknown) => unknown) | undefined;
    const pi = {
      on(event: string, candidate: (event: unknown) => unknown) {
        if (event === 'tool_call') handler = candidate;
      },
    } as unknown as ExtensionAPI;

    registerParentProcessGuard(pi, { protectedProcessIds });

    expect(handler?.({ toolName: 'read', input: { path: 'README.md' } })).toBeUndefined();
    expect(handler?.({ toolName: 'bash', input: { command: 'pnpm test' } })).toBeUndefined();
    expect(handler?.({ toolName: 'bash', input: { command: 'kill 4101' } })).toEqual({
      block: true,
      reason: expect.stringContaining('cannot signal parent or workflow processes'),
    });
    expect('setActiveTools' in (pi as unknown as Record<string, unknown>)).toBe(false);
  });
});

describe('stripParentOnlySubagentMessages', () => {
  it('drops a custom message whose type is parent-only', () => {
    const messages = [
      { role: 'custom', customType: 'subagent-notify' },
      { role: 'user', content: 'hi' },
    ];
    const filtered = stripParentOnlySubagentMessages(messages);
    expect(filtered).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('drops a subagent tool-result message when the fanout child flag is not set', () => {
    delete process.env[SUBAGENT_FANOUT_CHILD_ENV];
    const messages = [{ role: 'toolResult', toolName: 'subagent', content: 'result' }];
    expect(stripParentOnlySubagentMessages(messages)).toEqual([]);
  });

  it('preserves fanout tool-call history when the fanout child flag is set', () => {
    const original = process.env[SUBAGENT_FANOUT_CHILD_ENV];
    process.env[SUBAGENT_FANOUT_CHILD_ENV] = '1';
    try {
      const messages = [{ role: 'toolResult', toolName: 'subagent', content: 'result' }];
      expect(stripParentOnlySubagentMessages(messages)).toBe(messages);
    } finally {
      if (original === undefined) delete process.env[SUBAGENT_FANOUT_CHILD_ENV];
      else process.env[SUBAGENT_FANOUT_CHILD_ENV] = original;
    }
  });

  it('returns the same array reference when nothing needed stripping', () => {
    delete process.env[SUBAGENT_FANOUT_CHILD_ENV];
    const messages = [{ role: 'user', content: 'hi' }];
    expect(stripParentOnlySubagentMessages(messages)).toBe(messages);
  });
});

describe('formatSteerMessage', () => {
  it('wraps the steer request message with orchestrator framing', () => {
    const formatted = formatSteerMessage({ type: 'steer', id: 'req-1', ts: 1000, message: 'wrap up now' });
    expect(formatted).toContain('Mid-run steering from the parent orchestrator');
    expect(formatted).toContain('wrap up now');
  });
});

// ============================================================================
// registerSteeringInbox: FIX - claim-by-rename, not batch-delete-then-dispatch
// ============================================================================

describe('registerSteeringInbox', () => {
  const temporaryDirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  function makeSteerInbox(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-child-steer-'));
    temporaryDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    for (const name of [
      SUBAGENT_STEER_INBOX_ENV,
      SUBAGENT_STEER_CAPABILITY_ENV,
      SUBAGENT_STEER_ACK_DIR_ENV,
      SUBAGENT_CHILD_INDEX_ENV,
    ]) {
      savedEnv[name] = process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    while (temporaryDirs.length > 0) {
      const dir = temporaryDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Minimal ExtensionAPI double: records `on` handlers by event name and simulates `sendUserMessage`. */
  function fakePi(sendUserMessage: (content: string, options: { deliverAs: 'steer' }) => unknown): {
    pi: ExtensionAPI;
    trigger: (event: string, payload?: unknown) => void;
  } {
    const handlers = new Map<string, Array<(event: unknown) => unknown>>();
    const pi = {
      on: (event: string, handler: (event: unknown) => unknown) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      sendUserMessage,
    } as unknown as ExtensionAPI;
    const trigger = (event: string, payload: unknown = {}): void => {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    };
    return { pi, trigger };
  }

  it('does nothing when no steer inbox env var is set', () => {
    delete process.env[SUBAGENT_STEER_INBOX_ENV];
    const { pi, trigger } = fakePi(() => undefined);
    expect(() => {
      registerSteeringInbox(pi, {});
      trigger('session_start');
    }).not.toThrow();
  });

  it('delivers a queued steer request on the next flush and removes it once accepted', () => {
    const steerInbox = makeSteerInbox();
    process.env[SUBAGENT_STEER_INBOX_ENV] = steerInbox;
    delete process.env[SUBAGENT_STEER_CAPABILITY_ENV];
    delete process.env[SUBAGENT_STEER_ACK_DIR_ENV];
    delete process.env[SUBAGENT_CHILD_INDEX_ENV];

    fs.mkdirSync(steerInbox, { recursive: true });
    fs.writeFileSync(
      path.join(steerInbox, '0000000002000-cmVxLTI.json'),
      JSON.stringify({ type: 'steer', id: 'req-2', ts: 2000, message: 'wrap up soon' }),
    );

    const delivered: string[] = [];
    const { pi, trigger } = fakePi((content) => {
      delivered.push(content);
    });

    registerSteeringInbox(pi, {});
    trigger('session_start');
    trigger('turn_end');

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('wrap up soon');
    expect(fs.readdirSync(steerInbox).filter((name) => name.endsWith('.json'))).toEqual([]);
  });

  it('leaves a steer request recoverable on disk when sendUserMessage throws, instead of losing it', () => {
    const steerInbox = makeSteerInbox();
    process.env[SUBAGENT_STEER_INBOX_ENV] = steerInbox;
    const ackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-child-ack-'));
    temporaryDirs.push(ackDir);
    process.env[SUBAGENT_STEER_ACK_DIR_ENV] = ackDir;
    process.env[SUBAGENT_CHILD_INDEX_ENV] = '0';
    delete process.env[SUBAGENT_STEER_CAPABILITY_ENV];

    // Write a steer request straight into the child inbox directory, the
    // same file shape `writeSteerRequestToDir` produces.
    fs.mkdirSync(steerInbox, { recursive: true });
    fs.writeFileSync(
      path.join(steerInbox, '0000000001000-cmVxLTE.json'),
      JSON.stringify({ type: 'steer', id: 'req-1', ts: 1000, message: 'do not lose me' }),
    );
    const entriesBefore = fs.readdirSync(steerInbox).filter((name) => name.endsWith('.json'));
    expect(entriesBefore).toHaveLength(1);

    const { pi, trigger } = fakePi(() => {
      throw new Error('session cannot accept steering right now');
    });

    registerSteeringInbox(pi, {});
    trigger('session_start');
    trigger('turn_end');

    // FIX: the request must still be on disk under its original name,
    // recoverable for the next flush - not deleted just because delivery
    // into this session's `sendUserMessage` failed.
    const entriesAfter = fs.readdirSync(steerInbox).filter((name) => name.endsWith('.json'));
    expect(entriesAfter).toEqual(entriesBefore);
    const recovered = JSON.parse(fs.readFileSync(path.join(steerInbox, entriesAfter[0] ?? ''), 'utf-8')) as {
      message: string;
    };
    expect(recovered.message).toBe('do not lose me');

    // The failure is still acknowledged (the parent learns delivery failed),
    // even though the request itself was not consumed.
    const ackFiles = fs.readdirSync(ackDir);
    expect(ackFiles).toHaveLength(1);
    const ack = JSON.parse(fs.readFileSync(path.join(ackDir, ackFiles[0] ?? ''), 'utf-8')) as {
      state: string;
    };
    expect(ack.state).toBe('failed');
  });

  it('retries and delivers a previously-failed request once sendUserMessage stops throwing', () => {
    const steerInbox = makeSteerInbox();
    process.env[SUBAGENT_STEER_INBOX_ENV] = steerInbox;
    delete process.env[SUBAGENT_STEER_CAPABILITY_ENV];
    delete process.env[SUBAGENT_STEER_ACK_DIR_ENV];
    delete process.env[SUBAGENT_CHILD_INDEX_ENV];

    fs.mkdirSync(steerInbox, { recursive: true });
    fs.writeFileSync(
      path.join(steerInbox, '0000000003000-cmVxLTM.json'),
      JSON.stringify({ type: 'steer', id: 'req-3', ts: 3000, message: 'eventually delivered' }),
    );

    let shouldThrow = true;
    const delivered: string[] = [];
    const { pi, trigger } = fakePi((content) => {
      if (shouldThrow) throw new Error('not yet');
      delivered.push(content);
    });

    registerSteeringInbox(pi, {});
    trigger('session_start');
    trigger('turn_end');
    expect(delivered).toHaveLength(0);
    expect(fs.readdirSync(steerInbox).filter((name) => name.endsWith('.json'))).toHaveLength(1);

    shouldThrow = false;
    trigger('turn_end');

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('eventually delivered');
    expect(fs.readdirSync(steerInbox).filter((name) => name.endsWith('.json'))).toEqual([]);
  });

  it('acknowledges as failed and removes the request when the host has no sendUserMessage at all', () => {
    const steerInbox = makeSteerInbox();
    process.env[SUBAGENT_STEER_INBOX_ENV] = steerInbox;
    const ackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-child-ack-'));
    temporaryDirs.push(ackDir);
    process.env[SUBAGENT_STEER_ACK_DIR_ENV] = ackDir;
    process.env[SUBAGENT_CHILD_INDEX_ENV] = '0';
    delete process.env[SUBAGENT_STEER_CAPABILITY_ENV];

    fs.mkdirSync(steerInbox, { recursive: true });
    fs.writeFileSync(
      path.join(steerInbox, '0000000004000-cmVxLTQ.json'),
      JSON.stringify({ type: 'steer', id: 'req-4', ts: 4000, message: 'nobody can hear this' }),
    );

    const handlers = new Map<string, Array<(event: unknown) => unknown>>();
    // No `sendUserMessage` on this host at all - unsupported, distinct from a
    // host that has one but whose call throws.
    const pi = {
      on: (event: string, handler: (event: unknown) => unknown) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
    } as unknown as ExtensionAPI;

    registerSteeringInbox(pi, {});
    for (const handler of handlers.get('turn_end') ?? []) handler({});

    // Consumed (not left recoverable): an unsupported host will never accept
    // this message no matter how many times it is retried, so this is
    // correctly a terminal failure rather than a transient one.
    expect(fs.readdirSync(steerInbox).filter((name) => name.endsWith('.json'))).toEqual([]);
    const ackFiles = fs.readdirSync(ackDir);
    expect(ackFiles).toHaveLength(1);
    const ack = JSON.parse(fs.readFileSync(path.join(ackDir, ackFiles[0] ?? ''), 'utf-8')) as { state: string };
    expect(ack.state).toBe('failed');
  });

  // ==========================================================================
  // Diagnostics: recorded rather than swallowed, and never module-level state
  // ==========================================================================

  it('records a watch-error on the caller-supplied diagnostics object instead of discarding it', () => {
    const steerInbox = makeSteerInbox();
    process.env[SUBAGENT_STEER_INBOX_ENV] = steerInbox;
    delete process.env[SUBAGENT_STEER_CAPABILITY_ENV];
    delete process.env[SUBAGENT_STEER_ACK_DIR_ENV];
    delete process.env[SUBAGENT_CHILD_INDEX_ENV];

    const { pi, trigger } = fakePi(() => undefined);
    const diagnostics = createPromptRuntimeDiagnostics();
    let watchErrorHandler: ((error: Error) => void) | undefined;
    const failingWatch = ((_target: unknown, _listener: unknown) => {
      const fakeWatcher = {
        on: (event: string, handler: (error: Error) => void) => {
          if (event === 'error') watchErrorHandler = handler;
        },
        close: () => {},
      };
      return fakeWatcher;
    }) as unknown as typeof fs.watch;

    registerSteeringInbox(pi, { watch: failingWatch, diagnostics });
    trigger('session_start');

    expect(diagnostics.watchErrors).toBe(0);
    watchErrorHandler?.(new Error('watch broke'));

    expect(diagnostics.watchErrors).toBe(1);
    expect(diagnostics.lastError).toBeInstanceOf(Error);
    expect((diagnostics.lastError as Error).message).toBe('watch broke');
  });

  it('gives every registration its own diagnostics object, with no shared module-level state', () => {
    const steerInboxA = makeSteerInbox();
    const steerInboxB = makeSteerInbox();

    process.env[SUBAGENT_STEER_INBOX_ENV] = steerInboxA;
    delete process.env[SUBAGENT_STEER_CAPABILITY_ENV];
    delete process.env[SUBAGENT_STEER_ACK_DIR_ENV];
    delete process.env[SUBAGENT_CHILD_INDEX_ENV];
    const diagnosticsA = createPromptRuntimeDiagnostics();
    const { pi: piA } = fakePi(() => undefined);
    registerSteeringInbox(piA, { diagnostics: diagnosticsA });
    diagnosticsA.watchErrors += 5;
    diagnosticsA.steerNudgeFailures += 3;

    process.env[SUBAGENT_STEER_INBOX_ENV] = steerInboxB;
    const diagnosticsB = createPromptRuntimeDiagnostics();
    const { pi: piB } = fakePi(() => undefined);
    registerSteeringInbox(piB, { diagnostics: diagnosticsB });

    // A fresh registration's diagnostics start at zero regardless of how much
    // another registration's object, created earlier in the same process, has
    // already accumulated - proof there is no shared singleton underneath.
    expect(diagnosticsB).toEqual({ steerNudgeFailures: 0, watchErrors: 0, watchCloseFailures: 0 });
    expect(diagnosticsA.watchErrors).toBe(5);
    expect(diagnosticsA.steerNudgeFailures).toBe(3);
  });

  it('defaults to a fresh diagnostics object when the caller supplies none, matching how the host calls it', () => {
    delete process.env[SUBAGENT_STEER_INBOX_ENV];
    const { pi } = fakePi(() => undefined);
    // The `.cts` entry point calls `registerSubagentPromptRuntime(pi)` with a
    // single argument; `registerSteeringInbox(pi, {})` mirrors that here.
    expect(() => registerSteeringInbox(pi, {})).not.toThrow();
  });
});

// ============================================================================
// extractAssistantSummaryText
// ============================================================================

describe('extractAssistantSummaryText', () => {
  it('returns "" for an empty message list', () => {
    expect(extractAssistantSummaryText([])).toBe('');
  });

  it("returns the LAST assistant message's text content, not the first", () => {
    const messages = [
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] },
      { role: 'toolResult', content: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'done, here is the summary' }] },
    ];
    expect(extractAssistantSummaryText(messages)).toBe('done, here is the summary');
  });

  it('joins multiple text blocks within one assistant message with a newline', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'part one' },
          { type: 'text', text: 'part two' },
        ],
      },
    ];
    expect(extractAssistantSummaryText(messages)).toBe('part one\npart two');
  });

  it('ignores non-text content blocks (thinking, tool calls) within an assistant message', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'internal reasoning' },
          { type: 'toolCall', id: 't1', name: 'read', arguments: {} },
          { type: 'text', text: 'the actual summary' },
        ],
      },
    ];
    expect(extractAssistantSummaryText(messages)).toBe('the actual summary');
  });

  it('walks backward past an assistant message with only empty/whitespace text to find an earlier non-empty one', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'text', text: 'earlier real summary' }] },
      { role: 'assistant', content: [{ type: 'text', text: '   ' }] },
    ];
    expect(extractAssistantSummaryText(messages)).toBe('earlier real summary');
  });

  it('returns "" when no assistant message has any text content', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: {} }] },
    ];
    expect(extractAssistantSummaryText(messages)).toBe('');
  });

  it('ignores a non-assistant message even if it happens to carry text-shaped content', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'user text, not a summary' }] }];
    expect(extractAssistantSummaryText(messages)).toBe('');
  });
});

// ============================================================================
