import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_RETAINED_EVENTS,
  readFleetTranscript,
  readFleetTranscriptTail,
  renderFleetTranscript,
  type FleetTranscriptEvent,
  type FleetTranscriptRenderable,
} from '../../src/adapters/pi/tui/fleetTranscript';

let tempDir: string;
let transcriptPath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-fleet-transcript-'));
  transcriptPath = path.join(tempDir, 'transcript.jsonl');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function serialize(records: Record<string, unknown>[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

function writeLines(records: Record<string, unknown>[]): void {
  fs.writeFileSync(transcriptPath, serialize(records), 'utf-8');
}

function appendLines(records: Record<string, unknown>[]): void {
  fs.appendFileSync(transcriptPath, serialize(records), 'utf-8');
}

/** An assistant turn as the writer records it: raw content parts, thinking included. */
function assistantRecord(parts: Record<string, unknown>[], ts: number): Record<string, unknown> {
  return { recordType: 'message', role: 'assistant', ts, message: { role: 'assistant', content: parts } };
}

describe('readFleetTranscript', () => {
  it('reports a warning instead of throwing when the file does not exist', () => {
    const result = readFleetTranscript(path.join(tempDir, 'missing.jsonl'));
    expect(result.events).toEqual([]);
    expect(result.warning).toBeDefined();
  });

  it('reads user and assistant messages in write order', () => {
    writeLines([
      { recordType: 'message', role: 'user', text: 'do the thing', ts: 1 },
      { recordType: 'message', role: 'assistant', text: 'done', ts: 2 },
    ]);
    const result = readFleetTranscript(transcriptPath);
    expect(result.events).toEqual([
      { kind: 'user', at: 1, text: 'do the thing' },
      { kind: 'assistant', at: 2, text: 'done' },
    ]);
  });

  it('folds a tool_start/tool_end pair sharing a toolCallId into one event', () => {
    writeLines([
      { recordType: 'tool_start', toolCallId: 'call-1', toolName: 'bash', argsPreview: 'ls', ts: 1 },
      { recordType: 'tool_end', toolCallId: 'call-1', isError: false, ts: 2 },
    ]);
    const result = readFleetTranscript(transcriptPath);
    expect(result.events).toEqual([{ kind: 'tool', at: 1, text: 'ls', name: 'bash', status: 'ok', endedAt: 2 }]);
  });

  it('renders a tool_end with no matching start as its own event rather than dropping it', () => {
    writeLines([{ recordType: 'tool_end', toolCallId: 'call-orphan', toolName: 'bash', isError: true, ts: 5 }]);
    const result = readFleetTranscript(transcriptPath);
    expect(result.events).toEqual([{ kind: 'tool', at: 5, text: '', name: 'bash', status: 'error' }]);
  });

  it('drops a line that fails to parse (a partial write mid-flush) rather than failing the whole read', () => {
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({ recordType: 'message', role: 'user', text: 'ok', ts: 1 })}\n{"recordType": "message", "rol`,
      'utf-8',
    );
    const result = readFleetTranscript(transcriptPath);
    expect(result.events).toEqual([{ kind: 'user', at: 1, text: 'ok' }]);
  });

  it('still reads a final complete record that has no newline after it', () => {
    // A whole-file writer that does not terminate its last line must not have
    // that line withheld; only an unparseable remainder is deferred.
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ recordType: 'message', role: 'user', text: 'first', ts: 1 }),
        JSON.stringify({ recordType: 'message', role: 'user', text: 'last', ts: 2 }),
      ].join('\n'),
      'utf-8',
    );
    const result = readFleetTranscript(transcriptPath);
    expect(result.events.map((event) => event.text)).toEqual(['first', 'last']);
  });

  it('reads stdout and stderr lines', () => {
    writeLines([
      { recordType: 'stdout', text: 'building...', ts: 1 },
      { recordType: 'stderr', text: 'warning: x', ts: 2 },
    ]);
    const result = readFleetTranscript(transcriptPath);
    expect(result.events).toEqual([
      { kind: 'stdout', at: 1, text: 'building...' },
      { kind: 'stderr', at: 2, text: 'warning: x' },
    ]);
  });

  it('extracts thinking from an assistant turn as its own event', () => {
    writeLines([
      assistantRecord(
        [
          { type: 'thinking', thinking: 'weighing options' },
          { type: 'text', text: 'here is why' },
        ],
        1,
      ),
    ]);
    const result = readFleetTranscript(transcriptPath);
    expect(result.events).toEqual([
      { kind: 'thinking', at: 1, text: 'weighing options' },
      { kind: 'assistant', at: 1, text: 'here is why' },
    ]);
  });

  it('emits no assistant event for a turn that only thought and called tools', () => {
    // The bare header rows this replaces were the whole reason the pane looked
    // like it was doing nothing.
    writeLines([
      assistantRecord(
        [
          { type: 'thinking', thinking: 'need to look' },
          { type: 'toolCall', name: 'read', arguments: {} },
        ],
        1,
      ),
    ]);
    const result = readFleetTranscript(transcriptPath);
    expect(result.events).toEqual([{ kind: 'thinking', at: 1, text: 'need to look' }]);
  });

  it('folds a toolResult into the call it answers', () => {
    writeLines([
      { recordType: 'tool_start', toolCallId: 'c1', toolName: 'find', argsPreview: 'x', ts: 1 },
      { recordType: 'tool_end', toolCallId: 'c1', isError: false, ts: 2 },
      { recordType: 'message', role: 'toolResult', toolCallId: 'c1', text: 'a/b.ts', ts: 3 },
    ]);
    const result = readFleetTranscript(transcriptPath);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ kind: 'tool', name: 'find', status: 'ok', result: 'a/b.ts' });
  });

  it('skips a toolResult whose call is not in the retained window', () => {
    writeLines([{ recordType: 'message', role: 'toolResult', toolCallId: 'gone', text: 'output', ts: 1 }]);
    const result = readFleetTranscript(transcriptPath);
    expect(result.events).toEqual([]);
  });

  it('treats an error reported by either half of a call as the call failing', () => {
    writeLines([
      { recordType: 'tool_start', toolCallId: 'c1', toolName: 'bash', ts: 1 },
      { recordType: 'message', role: 'toolResult', toolCallId: 'c1', text: 'boom', isError: true, ts: 2 },
      { recordType: 'tool_end', toolCallId: 'c1', isError: false, ts: 3 },
    ]);
    expect(readFleetTranscript(transcriptPath).events[0]).toMatchObject({ status: 'error' });
  });

  it('parses argsPayload into structured arguments', () => {
    writeLines([
      {
        recordType: 'tool_start',
        toolCallId: 'c1',
        toolName: 'grep',
        argsPreview: '/repo',
        argsPayload: JSON.stringify({ pattern: 'needle', path: '/repo/src' }),
        ts: 1,
      },
    ]);
    expect(readFleetTranscript(transcriptPath).events[0].args).toEqual({ pattern: 'needle', path: '/repo/src' });
  });

  it('keeps the preview when argsPayload was truncated into invalid JSON', () => {
    writeLines([
      {
        recordType: 'tool_start',
        toolCallId: 'c1',
        toolName: 'grep',
        argsPreview: 'needle',
        argsPayload: '{"pat',
        ts: 1,
      },
    ]);
    const event = readFleetTranscript(transcriptPath).events[0];
    expect(event.args).toBeUndefined();
    expect(event.text).toBe('needle');
  });

  it('surfaces a custom host notice rather than dropping it', () => {
    writeLines([{ recordType: 'message', role: 'custom', text: 'Suggested skill: cli-usage', ts: 1 }]);
    expect(readFleetTranscript(transcriptPath).events).toEqual([
      { kind: 'notice', at: 1, text: 'Suggested skill: cli-usage' },
    ]);
  });
});

describe('readFleetTranscriptTail', () => {
  it('reads only the bytes appended since the previous tail', () => {
    writeLines([{ recordType: 'message', role: 'user', text: 'first', ts: 1 }]);
    const first = readFleetTranscriptTail(transcriptPath);
    const offsetAfterFirst = first.byteOffset;
    expect(first.events).toHaveLength(1);

    appendLines([{ recordType: 'message', role: 'user', text: 'second', ts: 2 }]);
    const second = readFleetTranscriptTail(transcriptPath, first);

    expect(second.events.map((event) => event.text)).toEqual(['first', 'second']);
    expect(second.byteOffset).toBeGreaterThan(offsetAfterFirst);
    expect(second.byteOffset).toBe(fs.statSync(transcriptPath).size);
  });

  it('does no work and reports no new events when nothing was appended', () => {
    writeLines([{ recordType: 'message', role: 'user', text: 'first', ts: 1 }]);
    const first = readFleetTranscriptTail(transcriptPath);
    const second = readFleetTranscriptTail(transcriptPath, first);

    expect(second.events).toHaveLength(1);
    expect(second.firstDirtyIndex).toBeUndefined();
    expect(second.byteOffset).toBe(first.byteOffset);
  });

  it('picks up a partial trailing line whole once the rest of it lands', () => {
    fs.writeFileSync(transcriptPath, `${JSON.stringify({ recordType: 'message', role: 'user', text: 'ok', ts: 1 })}\n`);
    const first = readFleetTranscriptTail(transcriptPath);
    fs.appendFileSync(transcriptPath, '{"recordType":"message","role":"user","te');
    const mid = readFleetTranscriptTail(transcriptPath, first);
    expect(mid.events).toHaveLength(1);

    fs.appendFileSync(transcriptPath, 'xt":"rest","ts":2}\n');
    const done = readFleetTranscriptTail(transcriptPath, mid);
    expect(done.events.map((event) => event.text)).toEqual(['ok', 'rest']);
  });

  it('folds a result that arrives in a later read onto a call from an earlier one', () => {
    writeLines([{ recordType: 'tool_start', toolCallId: 'c1', toolName: 'find', ts: 1 }]);
    const first = readFleetTranscriptTail(transcriptPath);
    expect(first.events[0]).toMatchObject({ status: 'running' });

    appendLines([
      { recordType: 'tool_end', toolCallId: 'c1', isError: false, ts: 2 },
      { recordType: 'message', role: 'toolResult', toolCallId: 'c1', text: 'found it', ts: 3 },
    ]);
    const second = readFleetTranscriptTail(transcriptPath, first);

    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject({ status: 'ok', result: 'found it' });
    // The mutated event sits before anything appended, so the renderer has to
    // be told to go back for it.
    expect(second.firstDirtyIndex).toBe(0);
  });

  it('re-reads from scratch when the file shrank, since it was replaced rather than appended to', () => {
    writeLines([
      { recordType: 'message', role: 'user', text: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa', ts: 1 },
      { recordType: 'message', role: 'user', text: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbb', ts: 2 },
    ]);
    const first = readFleetTranscriptTail(transcriptPath);
    expect(first.events).toHaveLength(2);

    writeLines([{ recordType: 'message', role: 'user', text: 'fresh', ts: 3 }]);
    const second = readFleetTranscriptTail(transcriptPath, first);

    expect(second.events.map((event) => event.text)).toEqual(['fresh']);
  });

  it('does not resume across a different transcript path', () => {
    writeLines([{ recordType: 'message', role: 'user', text: 'first', ts: 1 }]);
    const first = readFleetTranscriptTail(transcriptPath);

    const other = path.join(tempDir, 'other.jsonl');
    fs.writeFileSync(other, serialize([{ recordType: 'message', role: 'user', text: 'other', ts: 1 }]), 'utf-8');
    const second = readFleetTranscriptTail(other, first);

    expect(second.events.map((event) => event.text)).toEqual(['other']);
  });

  it('reaches the same events whether read in one pass or resumed across many', () => {
    // The incremental path is an optimisation; it is only correct if it cannot
    // drift from the whole-file read it replaces.
    const records = [
      { recordType: 'message', role: 'user', text: 'start', ts: 1 },
      { recordType: 'tool_start', toolCallId: 'c1', toolName: 'grep', argsPayload: '{"pattern":"x"}', ts: 2 },
      assistantRecord([{ type: 'thinking', thinking: 'hmm' }], 3),
      { recordType: 'tool_end', toolCallId: 'c1', isError: false, ts: 4 },
      { recordType: 'message', role: 'toolResult', toolCallId: 'c1', text: 'hit', ts: 5 },
      assistantRecord([{ type: 'text', text: 'found it' }], 6),
      { recordType: 'stderr', text: 'a warning', ts: 7 },
    ];
    writeLines(records);
    const wholeFile = readFleetTranscriptTail(transcriptPath);

    const incrementalPath = path.join(tempDir, 'incremental.jsonl');
    fs.writeFileSync(incrementalPath, '', 'utf-8');
    let resumed = readFleetTranscriptTail(incrementalPath);
    for (const record of records) {
      fs.appendFileSync(incrementalPath, serialize([record]), 'utf-8');
      resumed = readFleetTranscriptTail(incrementalPath, resumed);
    }

    expect(resumed.events).toEqual(wholeFile.events);
  });

  it('caps retained events and reports how many it dropped', () => {
    const overflow = MAX_RETAINED_EVENTS + 5;
    writeLines(
      Array.from({ length: overflow }, (_, index) => ({
        recordType: 'message',
        role: 'user',
        text: `line ${index}`,
        ts: index,
      })),
    );
    const tail = readFleetTranscriptTail(transcriptPath);

    expect(tail.events).toHaveLength(MAX_RETAINED_EVENTS);
    expect(tail.droppedEvents).toBe(5);
    expect(tail.events[0].text).toBe('line 5');
  });
});

describe('renderFleetTranscript', () => {
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const options = { verbosity: 'compact' as const };

  function renderable(events: FleetTranscriptEvent[], overrides: Partial<FleetTranscriptRenderable> = {}) {
    return { events, firstDirtyIndex: undefined, droppedEvents: 0, ...overrides };
  }

  it('renders one line per event kind without throwing', () => {
    const render = renderFleetTranscript(
      renderable([
        { kind: 'user', at: 1, text: 'hi' },
        { kind: 'assistant', at: 2, text: 'hello' },
        { kind: 'thinking', at: 3, text: 'pondering' },
        { kind: 'tool', at: 4, text: 'ls', name: 'bash', status: 'ok' },
        { kind: 'notice', at: 5, text: 'heads up' },
        { kind: 'stdout', at: 6, text: 'out' },
        { kind: 'stderr', at: 7, text: 'err' },
      ]),
      80,
      theme,
      undefined,
      options,
    );
    const text = render.lines.join('\n');
    expect(text).toContain('bash');
    expect(text).toContain('hello');
    expect(text).toContain('pondering');
    expect(text).toContain('heads up');
  });

  it('uses the semantic success color for completed tool events', () => {
    const markingTheme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => text,
    };
    const render = renderFleetTranscript(
      renderable([{ kind: 'tool', at: 1, text: '', name: 'find', status: 'ok' }]),
      80,
      markingTheme,
      undefined,
      options,
    );

    expect(render.lines.join('\n')).toContain('<success>✓</success>');
  });

  it('shows a tool result under the call it belongs to', () => {
    const render = renderFleetTranscript(
      renderable([{ kind: 'tool', at: 1, text: '', name: 'find', status: 'ok', result: 'packages/a.ts' }]),
      80,
      theme,
      undefined,
      options,
    );
    expect(render.lines.join('\n')).toContain('packages/a.ts');
  });

  it('renders paths relative to the run cwd, which is what differs between rows', () => {
    const render = renderFleetTranscript(
      renderable([
        {
          kind: 'tool',
          at: 1,
          text: '',
          name: 'read',
          status: 'ok',
          args: { path: '/repo/packages/core/doompi-team/src/tui/fleet.ts' },
        },
      ]),
      120,
      theme,
      undefined,
      { cwd: '/repo', verbosity: 'compact' },
    );
    const text = render.lines.join('\n');
    expect(text).toContain('packages/core/doompi-team/src/tui/fleet.ts');
    expect(text).not.toContain('/repo/packages');
  });

  it('omits a path argument that is just the run cwd, which every row would repeat', () => {
    const render = renderFleetTranscript(
      renderable([
        { kind: 'tool', at: 1, text: '', name: 'find', status: 'ok', args: { pattern: '**/x.ts', path: '/repo' } },
      ]),
      120,
      theme,
      undefined,
      { cwd: '/repo', verbosity: 'compact' },
    );
    const header = render.lines[0];
    expect(header).toContain('**/x.ts');
    expect(header).not.toContain(' · .');
  });

  it('returns the identical render when nothing changed, rather than rebuilding every line', () => {
    const events: FleetTranscriptEvent[] = [
      { kind: 'user', at: 1, text: 'hi' },
      { kind: 'assistant', at: 2, text: 'hello' },
    ];
    const first = renderFleetTranscript(renderable(events), 80, theme, undefined, options);
    const second = renderFleetTranscript(renderable(events), 80, theme, undefined, options, first);
    expect(second).toBe(first);
  });

  it('prefers the distinguishing argument over the shared one', () => {
    const render = renderFleetTranscript(
      renderable([
        { kind: 'tool', at: 1, text: '', name: 'grep', status: 'ok', args: { pattern: 'needle', path: '/repo/src' } },
      ]),
      120,
      theme,
      undefined,
      { cwd: '/repo', verbosity: 'compact' },
    );
    const text = render.lines.join('\n');
    expect(text).toContain('needle');
    expect(text).toContain('src');
  });

  it('caps a long result in compact mode and states how much it hid', () => {
    const result = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
    const render = renderFleetTranscript(
      renderable([{ kind: 'tool', at: 1, text: '', name: 'bash', status: 'ok', result }]),
      80,
      theme,
      undefined,
      options,
    );
    const text = render.lines.join('\n');
    expect(text).toContain('line 0');
    expect(text).not.toContain('line 19');
    expect(text).toContain('+17 lines');
  });

  it('shows the whole result in full verbosity', () => {
    const result = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
    const render = renderFleetTranscript(
      renderable([{ kind: 'tool', at: 1, text: '', name: 'bash', status: 'ok', result }]),
      80,
      theme,
      undefined,
      { verbosity: 'full' },
    );
    expect(render.lines.join('\n')).toContain('line 19');
  });

  it('states that earlier events were dropped rather than passing a tail off as the whole run', () => {
    const render = renderFleetTranscript(
      renderable([{ kind: 'user', at: 1, text: 'hi' }], { droppedEvents: 12 }),
      80,
      theme,
      undefined,
      options,
    );
    expect(render.lines.join('\n')).toContain('12 earlier events not shown');
  });

  it('reuses the blocks of events that did not change when new ones are appended', () => {
    const first = renderFleetTranscript(
      renderable([{ kind: 'user', at: 1, text: 'hi' }]),
      80,
      theme,
      undefined,
      options,
    );
    const second = renderFleetTranscript(
      renderable([
        { kind: 'user', at: 1, text: 'hi' },
        { kind: 'assistant', at: 2, text: 'hello' },
      ]),
      80,
      theme,
      undefined,
      options,
      first,
    );

    expect(second.blocks).toHaveLength(2);
    // Block identity is the assertion: a reused block is the same array, not
    // an equal one that was rendered again.
    expect(second.blocks[0]).toBe(first.blocks[0]);
  });

  it('re-renders a dirty block and everything after it', () => {
    const events: FleetTranscriptEvent[] = [
      { kind: 'tool', at: 1, text: '', name: 'find', status: 'running' },
      { kind: 'user', at: 2, text: 'hi' },
    ];
    const first = renderFleetTranscript(renderable(events), 80, theme, undefined, options);

    const updated: FleetTranscriptEvent[] = [
      { kind: 'tool', at: 1, text: '', name: 'find', status: 'ok', result: 'done' },
      { kind: 'user', at: 2, text: 'hi' },
    ];
    const second = renderFleetTranscript(
      renderable(updated, { firstDirtyIndex: 0 }),
      80,
      theme,
      undefined,
      options,
      first,
    );

    expect(second.blocks[0]).not.toBe(first.blocks[0]);
    expect(second.lines.join('\n')).toContain('done');
  });

  it('re-renders everything when the width changed', () => {
    const events: FleetTranscriptEvent[] = [{ kind: 'user', at: 1, text: 'hi' }];
    const first = renderFleetTranscript(renderable(events), 80, theme, undefined, options);
    const second = renderFleetTranscript(renderable(events), 40, theme, undefined, options, first);
    expect(second.blocks[0]).not.toBe(first.blocks[0]);
  });

  it('re-renders everything when verbosity changed', () => {
    const events: FleetTranscriptEvent[] = [{ kind: 'user', at: 1, text: 'hi' }];
    const first = renderFleetTranscript(renderable(events), 80, theme, undefined, options);
    const second = renderFleetTranscript(renderable(events), 80, theme, undefined, { verbosity: 'full' }, first);
    expect(second.blocks[0]).not.toBe(first.blocks[0]);
  });

  it('realigns reused blocks when retention dropped events off the front', () => {
    const first = renderFleetTranscript(
      renderable([
        { kind: 'user', at: 1, text: 'oldest' },
        { kind: 'user', at: 2, text: 'middle' },
      ]),
      80,
      theme,
      undefined,
      options,
    );
    const second = renderFleetTranscript(
      renderable(
        [
          { kind: 'user', at: 2, text: 'middle' },
          { kind: 'user', at: 3, text: 'newest' },
        ],
        {
          droppedEvents: 1,
        },
      ),
      80,
      theme,
      undefined,
      options,
      first,
    );

    expect(second.blocks).toHaveLength(2);
    expect(second.blocks[0]).toBe(first.blocks[1]);
    expect(second.lines.join('\n')).toContain('newest');
    expect(second.lines.join('\n')).not.toContain('oldest');
  });
});
