import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildCompletionDetails,
  type CompletionNotifyDetails,
  type CompletionNotifyHost,
  CompletionNotifier,
  formatGroupedCompletion,
  formatSingleCompletion,
  SUBAGENT_NOTIFY_MESSAGE_TYPE,
} from '../../src/adapters/runs/background/notify';
import type { RunResultFile } from '../../src/adapters/resultWatcher';
import type { CompletionBatchConfig } from '../../src/adapters/runs/background/completionBatcher';

/**
 * Exposes the protected `sendMessage` seam, recording every call instead of
 * discarding it (the real default just returns `false`), and lets a test
 * pin a fast, deterministic batch config the same way other tests in this
 * directory pin `pollIntervalMs`/`flushIntervalMs`.
 */
class TestCompletionNotifier extends CompletionNotifier {
  protected override readonly batchConfig: CompletionBatchConfig = {
    debounceMs: 20,
    maxWaitMs: 100,
    stragglerDebounceMs: 10,
    stragglerMaxWaitMs: 40,
    stragglerWindowMs: 200,
  };

  sentMessages: Array<{ content: string; triggerTurn: boolean }> = [];
  /** Set false to simulate a real channel actively rejecting delivery. */
  sendResult = true;

  protected override sendMessage(content: string, options: { triggerTurn: boolean }): boolean {
    this.sentMessages.push({ content, triggerTurn: options.triggerTurn });
    return this.sendResult;
  }
}

function result(overrides: Partial<RunResultFile> & { runId: string }): RunResultFile {
  return { agent: 'worker', success: true, summary: 'done', ...overrides };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildCompletionDetails', () => {
  it('derives "completed" for a successful result', () => {
    expect(buildCompletionDetails(result({ runId: 'r1', success: true })).status).toBe('completed');
  });

  it('derives "failed" for an unsuccessful result with no pause markers', () => {
    expect(buildCompletionDetails(result({ runId: 'r1', success: false })).status).toBe('failed');
  });

  it('derives "paused" for an unsuccessful result whose state is "paused"', () => {
    const details = buildCompletionDetails(result({ runId: 'r1', success: false, state: 'paused' }));
    expect(details.status).toBe('paused');
  });

  it('derives "paused" from the summary prefix when state is absent', () => {
    const details = buildCompletionDetails(
      result({ runId: 'r1', success: false, summary: 'Paused after interrupt. resume with...' }),
    );
    expect(details.status).toBe('paused');
  });

  it('falls back to "unknown" for a missing agent name', () => {
    expect(buildCompletionDetails({ runId: 'r1' }).agent).toBe('unknown');
  });

  it('formats taskInfo as a 1-based "(n/total)" suffix when both fields are present', () => {
    const details = buildCompletionDetails(result({ runId: 'r1', taskIndex: 1, totalTasks: 3 }));
    expect(details.taskInfo).toBe(' (2/3)');
  });

  it('prefers shareUrl, then shareError, then sessionFile for the session line', () => {
    expect(buildCompletionDetails(result({ runId: 'r1', shareUrl: 'https://x' }))).toMatchObject({
      sessionLabel: 'Session',
      sessionValue: 'https://x',
    });
    expect(buildCompletionDetails(result({ runId: 'r1', shareError: 'boom' }))).toMatchObject({
      sessionLabel: 'Session share error',
      sessionValue: 'boom',
    });
    expect(buildCompletionDetails(result({ runId: 'r1', sessionFile: '/tmp/s.json' }))).toMatchObject({
      sessionLabel: 'Session file',
      sessionValue: '/tmp/s.json',
    });
  });

  it('reads the parallel handoff path out of an opaque parallelHandoff object', () => {
    const details = buildCompletionDetails(result({ runId: 'r1', parallelHandoff: { path: '/tmp/handoff.json' } }));
    expect(details.handoffPath).toBe('/tmp/handoff.json');
  });
});

describe('formatSingleCompletion / formatGroupedCompletion', () => {
  it('renders a single completion with its agent, status and output', () => {
    const content = formatSingleCompletion({
      agent: 'worker',
      runId: 'run-1',
      status: 'completed',
      resultPreview: 'all good',
    });
    expect(content).toContain('Background task completed: **worker**');
    expect(content).toContain('all good');
  });

  it('carries the run id, so a follow-up call has something to address', () => {
    const content = formatSingleCompletion({
      agent: 'worker',
      runId: 'run-1',
      status: 'completed',
      resultPreview: 'all good',
    });
    expect(content).toContain('run id: run-1');
  });

  it('tells the model what to do with a completion rather than leaving it to infer', () => {
    const content = formatSingleCompletion({
      agent: 'worker',
      runId: 'run-1',
      status: 'completed',
      resultPreview: 'all good',
    });
    expect(content).toContain(
      'Handle this result now: incorporate it, reject it with a reason, or mark it irrelevant.',
    );
  });

  it('uses the strict status shape when a completed run produced no summary', () => {
    const content = formatSingleCompletion({
      agent: 'worker',
      runId: 'run-1',
      status: 'completed',
      resultPreview: '   ',
    });
    expect(content).toContain('(no output)');
    expect(content).toContain('{ action: "status", id: "run-1", transcriptLines: 80 }');
    expect(content).not.toContain('view:');
  });

  it('uses a failure summary before recommending transcript recovery', () => {
    const content = formatSingleCompletion({
      agent: 'worker',
      runId: 'run-1',
      status: 'failed',
      resultPreview: 'runtime missing',
    });
    expect(content).toContain('Use the failure summary first. If it does not explain the failure');
    expect(content).toContain('{ action: "status", id: "run-1", transcriptLines: 80 }');
    expect(content).not.toContain('view:');
  });

  it('goes directly to transcript recovery when a failure has no summary', () => {
    const content = formatSingleCompletion({
      agent: 'worker',
      runId: 'run-1',
      status: 'failed',
      resultPreview: '',
    });
    expect(content).toContain('No failure summary was produced.');
    expect(content).toContain('{ action: "status", id: "run-1", transcriptLines: 80 }');
    expect(content).not.toContain('Use the failure summary first');
  });

  it('renders a grouped completion with a count header and one numbered block per item', () => {
    const content = formatGroupedCompletion([
      { agent: 'a', runId: 'run-a', status: 'completed', resultPreview: 'first' },
      { agent: 'b', runId: 'run-b', status: 'completed', resultPreview: 'second' },
    ]);
    expect(content).toContain('Background tasks completed (2): **a**, **b**');
    expect(content).toContain('1. a');
    expect(content).toContain('2. b');
    expect(content.match(/Handle each result now/g)).toHaveLength(1);
    expect(content).not.toContain('Handle this result now');
  });

  it('carries every run id in a grouped completion, not just the first', () => {
    const content = formatGroupedCompletion([
      { agent: 'a', runId: 'run-a', status: 'completed', resultPreview: 'first' },
      { agent: 'b', runId: 'run-b', status: 'completed', resultPreview: 'second' },
    ]);
    expect(content).toContain('run id: run-a');
    expect(content).toContain('run id: run-b');
  });
});

describe('CompletionNotifier batching (fix: N children finishing together must produce one message, not N)', () => {
  it('groups three completions for the same session into a single sendMessage call', async () => {
    const notifier = new TestCompletionNotifier();

    const first = notifier.deliver(result({ runId: 'a', sessionId: 'session-1', agent: 'child-a' }));
    vi.advanceTimersByTime(5);
    const second = notifier.deliver(result({ runId: 'b', sessionId: 'session-1', agent: 'child-b' }));
    vi.advanceTimersByTime(5);
    const third = notifier.deliver(result({ runId: 'c', sessionId: 'session-1', agent: 'child-c' }));
    vi.advanceTimersByTime(20); // let the debounce elapse

    await Promise.all([first, second, third]);

    expect(notifier.sentMessages).toHaveLength(1);
    expect(notifier.sentMessages[0]?.content).toContain('Background tasks completed (3)');
  });

  it('does not group completions from different sessions together', async () => {
    const notifier = new TestCompletionNotifier();

    const first = notifier.deliver(result({ runId: 'a', sessionId: 'session-1' }));
    const second = notifier.deliver(result({ runId: 'b', sessionId: 'session-2' }));
    vi.advanceTimersByTime(20);
    await Promise.all([first, second]);

    expect(notifier.sentMessages).toHaveLength(2);
  });

  it("resolves each item's promise with whatever sendMessage reported for its group", async () => {
    const notifier = new TestCompletionNotifier();
    notifier.sendResult = true;

    const pending = notifier.deliver(result({ runId: 'a' }));
    vi.advanceTimersByTime(20);

    expect(await pending).toBe(true);
  });
});

describe('CompletionNotifier bypass for anything needing attention', () => {
  it('delivers a failed completion immediately, unbatched, rather than waiting out the debounce', async () => {
    const notifier = new TestCompletionNotifier();

    const delivered = await notifier.deliver(result({ runId: 'a', success: false }));

    expect(delivered).toBe(true);
    expect(notifier.sentMessages).toHaveLength(1);
    expect(notifier.sentMessages[0]?.content).toContain('Background task failed');
  });

  it('delivers a paused completion immediately as well', async () => {
    const notifier = new TestCompletionNotifier();

    await notifier.deliver(result({ runId: 'a', success: false, state: 'paused' }));

    expect(notifier.sentMessages[0]?.content).toContain('Background task paused');
  });

  it('flushes an already-held successful group before emitting the bypassing failure, rather than losing it', async () => {
    const notifier = new TestCompletionNotifier();

    const heldSuccess = notifier.deliver(result({ runId: 'a', sessionId: 'session-1', success: true }));
    const bypassingFailure = notifier.deliver(result({ runId: 'b', sessionId: 'session-1', success: false }));
    await Promise.all([heldSuccess, bypassingFailure]);

    // The held success must have been flushed as its own message, separate
    // from the immediately-emitted failure - not silently dropped, and not
    // merged into the failure's message.
    expect(notifier.sentMessages).toHaveLength(2);
    expect(notifier.sentMessages[0]?.content).toContain('completed');
    expect(notifier.sentMessages[1]?.content).toContain('failed');
  });
});

describe('CompletionNotifier.dispose', () => {
  it('resolves every held item false rather than leaving its promise hanging', async () => {
    const notifier = new TestCompletionNotifier();

    const pending = notifier.deliver(result({ runId: 'a' }));
    notifier.dispose();

    await expect(pending).resolves.toBe(false);
  });

  it('rejects further delivery attempts once disposed', async () => {
    const notifier = new TestCompletionNotifier();
    notifier.dispose();

    await expect(notifier.deliver(result({ runId: 'a' }))).resolves.toBe(false);
    expect(notifier.sentMessages).toHaveLength(0);
  });

  it('is safe to call more than once', () => {
    const notifier = new TestCompletionNotifier();
    notifier.dispose();

    expect(() => notifier.dispose()).not.toThrow();
  });
});

describe('CompletionNotifier.sendMessage default (no host attached)', () => {
  it('is inert and reports delivery as not accepted, matching the ResultConsumer retry contract', async () => {
    const notifier = new CompletionNotifier();

    const accepted = await notifier.deliver(result({ runId: 'a', success: false })); // bypasses batching -> resolves immediately

    expect(accepted).toBe(false);
  });
});

describe('CompletionNotifier.attachHost', () => {
  interface RecordedMessage {
    customType: string;
    content: string;
    display: boolean;
    details?: CompletionNotifyDetails[];
  }

  interface RecordedSend {
    message: RecordedMessage;
    options?: { triggerTurn?: boolean; deliverAs?: 'steer' };
  }

  function recordingHost(): { host: CompletionNotifyHost; sent: RecordedSend[] } {
    const sent: RecordedSend[] = [];
    return {
      sent,
      host: {
        sendMessage(message, options) {
          sent.push({ message, options });
        },
      },
    };
  }

  it('renders a completion through the host once attached, and reports it delivered', async () => {
    const { host, sent } = recordingHost();
    const notifier = new CompletionNotifier();
    notifier.attachHost(host);

    const accepted = await notifier.deliver(result({ runId: 'a', success: false, agent: 'porter' }));

    expect(accepted).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message.customType).toBe(SUBAGENT_NOTIFY_MESSAGE_TYPE);
    expect(sent[0]?.message.display).toBe(true);
    expect(sent[0]?.message.content).toContain('porter');
    expect(sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: 'steer' });
  });

  /**
   * The renderer reads `details` structurally and never re-parses `content`
   * (see `tui/completionNotice.ts`'s header). If details ever stopped being
   * attached, the renderer would silently fall back to raw markdown, so this
   * pins the field's presence rather than only its formatted text.
   */
  it('attaches structured details alongside the formatted content', async () => {
    const { host, sent } = recordingHost();
    const notifier = new CompletionNotifier();
    notifier.attachHost(host);

    await notifier.deliver(result({ runId: 'a', success: false, agent: 'porter', summary: 'it broke' }));

    expect(sent[0]?.message.details).toEqual([expect.objectContaining({ agent: 'porter', status: 'failed' })]);
  });

  it('reports non-delivery when the host throws, so the claim is retried rather than lost', async () => {
    const notifier = new CompletionNotifier();
    notifier.attachHost({
      sendMessage() {
        throw new Error('no active session to render into');
      },
    });

    const accepted = await notifier.deliver(result({ runId: 'a', success: false }));

    expect(accepted).toBe(false);
  });

  it('re-attaching replaces the previous host rather than sending to both', async () => {
    const first = recordingHost();
    const second = recordingHost();
    const notifier = new CompletionNotifier();

    notifier.attachHost(first.host);
    notifier.attachHost(second.host);
    await notifier.deliver(result({ runId: 'a', success: false }));

    expect(first.sent).toHaveLength(0);
    expect(second.sent).toHaveLength(1);
  });
});

describe('CompletionNotifier does not dedupe on its own (decision: ResultWatcher already guarantees exactly-once)', () => {
  it('delivers the same runId twice if asked twice, trusting the caller not to', async () => {
    const notifier = new TestCompletionNotifier();

    await notifier.deliver(result({ runId: 'a', success: false }));
    await notifier.deliver(result({ runId: 'a', success: false }));

    // Deliberately NOT deduped here - see the module header. If this ever
    // starts failing because someone added a dedupe map "just in case", that
    // is exactly the two-independently-drifting-copies bug this design
    // avoided; the fix belongs in ResultWatcher, not a second copy here.
    expect(notifier.sentMessages).toHaveLength(2);
  });
});
