import { Buffer } from 'node:buffer';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CHILD_TRANSCRIPT_ARTIFACT_VERSION,
  type ChildTranscriptEvent,
  type ChildTranscriptWriter,
  type ChildTranscriptWriterInput,
  createChildTranscriptWriter,
  formatToolActivity,
  getMessageActivity,
  getMessageUsageTokens,
} from '../../src/adapters/process/childTranscript';

const temporaryDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-transcript-'));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeWriter(overrides: Partial<ChildTranscriptWriterInput> = {}): {
  writer: ChildTranscriptWriter;
  transcriptPath: string;
} {
  const transcriptPath = overrides.transcriptPath ?? path.join(makeTempDir(), 'nested', 'run.jsonl');
  const writer = createChildTranscriptWriter({
    transcriptPath,
    source: 'async',
    runId: 'run-1',
    agent: 'reviewer',
    cwd: '/repo',
    ...overrides,
  });
  return { writer, transcriptPath };
}

/** Every record in the file, in write order. */
function readRecords(transcriptPath: string): Record<string, unknown>[] {
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('child transcript writer setup', () => {
  it('creates the parent directory so the parent can record before the child starts', () => {
    const { writer, transcriptPath } = makeWriter();
    expect(fs.existsSync(transcriptPath)).toBe(true);
    expect(writer.getError()).toBeUndefined();
    expect(writer.path).toBe(transcriptPath);
  });

  it('truncates an existing file rather than appending to a previous run', () => {
    const dir = makeTempDir();
    const transcriptPath = path.join(dir, 'run.jsonl');
    fs.writeFileSync(transcriptPath, '{"stale":true}\n');

    const { writer } = makeWriter({ transcriptPath });
    writer.writeStdoutLine('fresh');

    const records = readRecords(transcriptPath);
    expect(records).toHaveLength(1);
    expect(records[0]?.text).toBe('fresh');
  });

  it('reports an unwritable path instead of throwing', () => {
    // A run must not die because its evidence file could not be opened.
    const dir = makeTempDir();
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');

    const { writer } = makeWriter({ transcriptPath: path.join(blocker, 'run.jsonl') });
    expect(writer.getError()).toMatch(/Failed to initialize child transcript/);

    // Every method must stay safe once the writer has latched an error.
    expect(() => {
      writer.writeInitialUserMessage('hello');
      writer.writeStdoutLine('out');
      writer.writeStderrText('a\nb');
      writer.writeChildEvent({ type: 'tool_execution_end', toolCallId: 't1' });
    }).not.toThrow();
  });
});

describe('record envelope', () => {
  it('stamps identity and a version on every record', () => {
    const { writer, transcriptPath } = makeWriter({ childIndex: 2 });
    writer.writeInitialUserMessage('do the thing');

    const record = readRecords(transcriptPath)[0];
    expect(record).toMatchObject({
      version: CHILD_TRANSCRIPT_ARTIFACT_VERSION,
      recordType: 'message',
      source: 'async',
      runId: 'run-1',
      agent: 'reviewer',
      childIndex: 2,
      cwd: '/repo',
      role: 'user',
      sourceEventType: 'initial_prompt',
      text: 'do the thing',
    });
    expect(typeof record?.ts).toBe('number');
    expect(String(record?.timestamp)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('omits childIndex entirely when the run has no sibling index', () => {
    const { writer, transcriptPath } = makeWriter();
    writer.writeInitialUserMessage('solo');
    expect(readRecords(transcriptPath)[0]).not.toHaveProperty('childIndex');
  });
});

describe('stdout and stderr records', () => {
  it('records non-blank lines on their own stream', () => {
    const { writer, transcriptPath } = makeWriter();
    writer.writeStdoutLine('out line');
    writer.writeStderrLine('err line');

    const records = readRecords(transcriptPath);
    expect(records.map((record) => [record.recordType, record.text])).toEqual([
      ['stdout', 'out line'],
      ['stderr', 'err line'],
    ]);
  });

  it('drops blank lines so keepalive newlines do not fill the file', () => {
    const { writer, transcriptPath } = makeWriter();
    writer.writeStdoutLine('');
    writer.writeStdoutLine('   ');
    writer.writeStderrLine('\t');
    expect(readRecords(transcriptPath)).toHaveLength(0);
  });

  it('splits stderr text on both newline conventions', () => {
    const { writer, transcriptPath } = makeWriter();
    writer.writeStderrText('first\r\nsecond\n\nthird');

    expect(readRecords(transcriptPath).map((record) => record.text)).toEqual(['first', 'second', 'third']);
  });
});

describe('message usage metrics', () => {
  it('uses the provider total instead of reconstructing message size from buckets', () => {
    expect(
      getMessageUsageTokens({
        role: 'assistant',
        usage: { totalTokens: 7, input: 100, output: 200, cacheRead: 300, cacheWrite: 400 },
      }),
    ).toBe(7);
  });

  it('falls back to summing token buckets for older usage payloads', () => {
    expect(
      getMessageUsageTokens({ role: 'assistant', usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }),
    ).toBe(10);
  });

  it('returns zero for an observed usage object with zero buckets', () => {
    expect(getMessageUsageTokens({ role: 'assistant', usage: {} })).toBe(0);
  });

  it('ignores tool-result usage because it is not part of model token accounting', () => {
    expect(getMessageUsageTokens({ role: 'toolResult', usage: { totalTokens: 99 } })).toBeUndefined();
  });

  it('returns undefined when usage is absent', () => {
    expect(getMessageUsageTokens({ role: 'assistant' })).toBeUndefined();
  });
});

describe('live activity summaries', () => {
  it('shows a bounded tail of the latest streamed assistant work', () => {
    const activity = getMessageActivity({
      role: 'assistant',
      content: [{ type: 'thinking', thinking: `Starting context ${'x'.repeat(100)} final detail` }],
    });

    expect(activity).toMatch(/^working: …/);
    expect(activity).toContain('final detail');
    expect(activity).not.toContain('Starting context');
  });

  it('ignores non-assistant message content', () => {
    expect(
      getMessageActivity({ role: 'toolResult', content: [{ type: 'text', text: 'large result' }] }),
    ).toBeUndefined();
  });

  it('adds the most useful tool argument preview to the activity', () => {
    expect(formatToolActivity('read', { path: 'src/task.ts' })).toBe('read (src/task.ts)');
    expect(formatToolActivity('wait', undefined)).toBe('wait');
  });
});

describe('message records', () => {
  it('flattens array content into text and keeps the raw message', () => {
    const { writer, transcriptPath } = makeWriter();
    writer.writeChildEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'line one' },
          { type: 'text', text: 'line two' },
        ],
        model: 'some-model',
        stopReason: 'end_turn',
      },
    });

    const record = readRecords(transcriptPath)[0];
    expect(record).toMatchObject({
      recordType: 'message',
      role: 'assistant',
      text: 'line one\nline two',
      model: 'some-model',
      stopReason: 'end_turn',
    });
    expect(record?.message).toBeTypeOf('object');
  });

  it('ignores content shapes it does not recognise instead of stringifying them', () => {
    // Stringifying would put "[object Object]" into the transcript.
    const { writer, transcriptPath } = makeWriter();
    writer.writeChildEvent({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'image', data: 'xxx' }, null, 42] },
    });

    expect(readRecords(transcriptPath)[0]).not.toHaveProperty('text');
  });

  it('reads nested tool_result content', () => {
    const { writer, transcriptPath } = makeWriter();
    writer.writeChildEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_result', content: [{ type: 'text', text: 'inner' }] }],
      },
    });

    expect(readRecords(transcriptPath)[0]?.text).toBe('inner');
  });

  it('accepts a plain string as content', () => {
    const { writer, transcriptPath } = makeWriter();
    writer.writeChildEvent({ type: 'message_end', message: { role: 'assistant', content: 'plain' } });
    expect(readRecords(transcriptPath)[0]?.text).toBe('plain');
  });

  it('normalizes usage across both field namings', () => {
    const { writer, transcriptPath } = makeWriter();
    writer.writeChildEvent({
      type: 'message_end',
      message: { role: 'assistant', content: 'x', usage: { inputTokens: 10, outputTokens: 3, cost: { total: 0.5 } } },
    });

    expect(readRecords(transcriptPath)[0]?.usage).toEqual({
      input: 10,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.5,
    });
  });

  it('treats unreadable usage numbers as zero rather than dropping the record', () => {
    const { writer, transcriptPath } = makeWriter();
    writer.writeChildEvent({
      type: 'message_end',
      message: { role: 'assistant', content: 'x', usage: { input: Number.NaN, output: 'lots', cost: 'free' } },
    });

    expect(readRecords(transcriptPath)[0]?.usage).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    });
  });

  it('records a tool result under its own shape', () => {
    const { writer, transcriptPath } = makeWriter();
    writer.writeChildEvent({
      type: 'tool_result_end',
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'Read',
        isError: true,
        content: [{ type: 'text', text: 'boom' }],
      },
    });

    const record = readRecords(transcriptPath)[0];
    expect(record).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'Read',
      isError: true,
      text: 'boom',
      outputTruncated: false,
    });
  });

  it('emits an empty content array for a tool result with nothing to say', () => {
    const { writer, transcriptPath } = makeWriter();
    writer.writeChildEvent({
      type: 'tool_result_end',
      message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'Read', content: [] },
    });

    const record = readRecords(transcriptPath)[0];
    expect(record).not.toHaveProperty('text');
    expect(record?.message).toMatchObject({ content: [] });
  });

  it('ignores an event that declares no message', () => {
    const { writer, transcriptPath } = makeWriter();
    writer.writeChildEvent({ type: 'message_end' });
    writer.writeChildEvent({ type: 'unknown_event' });
    expect(readRecords(transcriptPath)).toHaveLength(0);
  });
});

describe('tool records', () => {
  it('records a tool start with a preview and the full payload', () => {
    const { writer, transcriptPath } = makeWriter();
    writer.writeChildEvent({
      type: 'tool_execution_start',
      toolCallId: 'call-9',
      toolName: 'Bash',
      args: { command: 'ls -la' },
    });

    expect(readRecords(transcriptPath)[0]).toMatchObject({
      recordType: 'tool_start',
      toolCallId: 'call-9',
      toolName: 'Bash',
      argsPreview: 'ls -la',
    });
  });

  it('omits the preview when a tool was called with no arguments', () => {
    const { writer, transcriptPath } = makeWriter();
    writer.writeChildEvent({ type: 'tool_execution_start', toolName: 'Noop', args: {} });

    const record = readRecords(transcriptPath)[0];
    expect(record).not.toHaveProperty('argsPreview');
    expect(record).not.toHaveProperty('toolCallId');
  });

  it('needs a tool name to record a start', () => {
    const { writer, transcriptPath } = makeWriter();
    writer.writeChildEvent({ type: 'tool_execution_start', args: { command: 'ls' } });
    expect(readRecords(transcriptPath)).toHaveLength(0);
  });

  it('records a tool end with only the fields it was given', () => {
    const { writer, transcriptPath } = makeWriter();
    writer.writeChildEvent({ type: 'tool_execution_end', toolCallId: 'call-9', isError: false });

    const record = readRecords(transcriptPath)[0];
    expect(record).toMatchObject({ recordType: 'tool_end', toolCallId: 'call-9', isError: false });
    expect(record).not.toHaveProperty('toolName');
  });

  it('ignores non-object args rather than previewing them', () => {
    const { writer, transcriptPath } = makeWriter();
    writer.writeChildEvent({ type: 'tool_execution_start', toolName: 'Bash', args: ['not', 'a', 'record'] });
    expect(readRecords(transcriptPath)[0]).not.toHaveProperty('argsPreview');
  });
});

describe('tool argument previews', () => {
  function previewFor(args: Record<string, unknown>): string {
    const { writer, transcriptPath } = makeWriter();
    writer.writeChildEvent({ type: 'tool_execution_start', toolName: 'T', args });
    const preview = readRecords(transcriptPath)[0]?.argsPreview;
    // The preview is always a string when present; anything else is a defect
    // in the writer, so surface it rather than coercing it to "[object Object]".
    expect(preview === undefined || typeof preview === 'string').toBe(true);
    return typeof preview === 'string' ? preview : '';
  }

  it('names an MCP call by server and tool', () => {
    expect(previewFor({ server: 'pencil', tool: 'execute' })).toBe('pencil/execute');
    expect(previewFor({ tool: 'execute' })).toBe('execute');
  });

  it('prefers a query over other keys', () => {
    expect(previewFor({ query: 'needle', path: '/some/file' })).toBe('needle');
  });

  it('summarises an array by its first entry and a remainder count', () => {
    expect(previewFor({ queries: ['first', 'second', 'third'] })).toBe('first (+2 more)');
    expect(previewFor({ queries: ['only'] })).toBe('only');
  });

  it('labels a workflow', () => {
    expect(previewFor({ workflow: 'deploy' })).toBe('workflow=deploy');
  });

  it('falls back to the first stringable argument, keyed', () => {
    expect(previewFor({ somethingElse: 'value' })).toBe('somethingElse=value');
  });

  it('truncates a long preview rather than filling the line', () => {
    const preview = previewFor({ query: 'x'.repeat(200) });
    expect(preview).toHaveLength(60);
    expect(preview.endsWith('...')).toBe(true);
  });

  it('yields an empty preview when nothing is stringable', () => {
    expect(previewFor({ flag: null, nested: { deep: true } })).toBe('');
  });
});

describe('payload bounding', () => {
  it('truncates an oversized tool result and flags it', () => {
    const { writer, transcriptPath } = makeWriter();
    writer.writeChildEvent({
      type: 'tool_result_end',
      message: {
        role: 'toolResult',
        toolCallId: 'c',
        toolName: 'Read',
        content: [{ type: 'text', text: 'a'.repeat(64 * 1024) }],
      },
    });

    const record = readRecords(transcriptPath)[0];
    expect(record?.outputTruncated).toBe(true);
    expect(String(record?.text)).toContain('payload truncated');
    // The flag is what readers must use; the marker text is not a reliable signal
    // because a payload can legitimately quote that phrase.
    expect(Buffer.byteLength(String(record?.text), 'utf-8')).toBeLessThanOrEqual(32 * 1024);
  });

  it('never cuts a multi-byte character in half', () => {
    const { writer, transcriptPath } = makeWriter();
    writer.writeChildEvent({
      type: 'tool_result_end',
      message: {
        role: 'toolResult',
        toolCallId: 'c',
        toolName: 'Read',
        // Three-byte characters guarantee the naive cut lands mid-character.
        content: [{ type: 'text', text: '世'.repeat(20000) }],
      },
    });

    const text = String(readRecords(transcriptPath)[0]?.text);
    expect(text).not.toContain('�');
  });
});

describe('file byte budget', () => {
  it('stops writing and explains why once the budget is spent', () => {
    const { writer, transcriptPath } = makeWriter({ maxBytes: 900 });

    for (let index = 0; index < 200; index++) writer.writeStdoutLine(`line ${index}`);

    const records = readRecords(transcriptPath);
    const last = records[records.length - 1];
    expect(last?.recordType).toBe('truncated');
    expect(String(last?.message)).toContain('further records were omitted');

    // The reserved room means the marker always fits.
    expect(fs.statSync(transcriptPath).size).toBeLessThanOrEqual(900);
  });

  it('writes nothing further after truncating', () => {
    const { writer, transcriptPath } = makeWriter({ maxBytes: 900 });
    for (let index = 0; index < 200; index++) writer.writeStdoutLine(`line ${index}`);
    const sizeAtTruncation = fs.statSync(transcriptPath).size;

    writer.writeStdoutLine('should not appear');
    writer.writeInitialUserMessage('nor this');

    expect(fs.statSync(transcriptPath).size).toBe(sizeAtTruncation);
    expect(fs.readFileSync(transcriptPath, 'utf-8')).not.toContain('should not appear');
  });

  it('emits exactly one truncation marker', () => {
    const { writer, transcriptPath } = makeWriter({ maxBytes: 900 });
    for (let index = 0; index < 200; index++) writer.writeStdoutLine(`line ${index}`);

    const markers = readRecords(transcriptPath).filter((record) => record.recordType === 'truncated');
    expect(markers).toHaveLength(1);
  });

  it('does not report the budget as a write error', () => {
    // Hitting the cap is expected behaviour, not a failure of the run.
    const { writer } = makeWriter({ maxBytes: 900 });
    for (let index = 0; index < 200; index++) writer.writeStdoutLine(`line ${index}`);
    expect(writer.getError()).toBeUndefined();
  });
});

const events: ChildTranscriptEvent[] = [
  { type: 'message_end', message: { role: 'assistant', content: 'a' } },
  { type: 'tool_execution_start', toolName: 'T', args: { query: 'q' } },
  { type: 'tool_execution_end', toolCallId: 'c' },
];

describe('writer robustness', () => {
  it('handles every event type without throwing', () => {
    const { writer } = makeWriter();
    expect(() => {
      for (const event of events) writer.writeChildEvent(event);
    }).not.toThrow();
    expect(writer.getError()).toBeUndefined();
  });
});
