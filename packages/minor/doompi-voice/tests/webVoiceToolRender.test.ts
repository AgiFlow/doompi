import { describe, expect, it } from 'vitest';
import { VOICE_TOOL_NAMES, voiceCallSummary, voiceResultLines } from '../web/voiceToolRender.ts';

const text = (value: string, details?: unknown) => ({ content: [{ type: 'text', text: value }], details });
const done = { expanded: false, isError: false, isPartial: false };
const expanded = { ...done, expanded: true };
const texts = (lines: Array<{ text: string }>) => lines.map((entry) => entry.text);

describe('voice tool call summaries', () => {
  it('names discover, run, narrate, and handoff calls with what they target', () => {
    expect(VOICE_TOOL_NAMES).toEqual(['describe_voice_tools', 'use_voice_tools', 'narrate', 'transfer_voice']);
    expect(voiceCallSummary('describe_voice_tools', {})).toEqual({
      glyph: '☰',
      action: 'discover',
      detailIsName: false,
    });
    expect(voiceCallSummary('describe_voice_tools', { names: ['minor_mode'] })).toEqual({
      glyph: '☰',
      action: 'discover',
      detail: 'minor_mode',
      detailIsName: true,
    });
    expect(voiceCallSummary('describe_voice_tools', { names: ['a', 'b'] }).detail).toBe('· 2 capabilities');
    expect(voiceCallSummary('use_voice_tools', {})).toEqual({ glyph: '▶', action: 'run', detailIsName: false });
    expect(voiceCallSummary('use_voice_tools', { calls: [{ name: 'major_mode', input: {} }] })).toEqual({
      glyph: '▶',
      action: 'run',
      detail: 'major_mode',
      detailIsName: true,
    });
    expect(voiceCallSummary('use_voice_tools', { calls: [{ input: {} }] })).toEqual({
      glyph: '▶',
      action: 'run',
      detailIsName: false,
    });
    expect(voiceCallSummary('use_voice_tools', { calls: [{}, {}, 'junk'] }).detail).toBe('· 2 capabilities');
    expect(voiceCallSummary('narrate', {})).toEqual({ action: 'narrate', detailIsName: false });
    expect(voiceCallSummary('narrate', { text: 'hello\n  there' }).detail).toBe('hello there');
    expect(voiceCallSummary('narrate', { text: 'x'.repeat(100) }).detail).toBe(`${'x'.repeat(69)}…`);
    expect(voiceCallSummary('transfer_voice', {})).toEqual({
      glyph: '↪',
      action: 'hand off',
      detailIsName: false,
    });
    expect(voiceCallSummary('transfer_voice', { target: 2 }).detail).toBe('target 2');
  });
});

describe('voice tool result lines', () => {
  it('lists the capability catalog, with schemas once expanded', () => {
    const snapshot = {
      catalogRevision: 3,
      tools: [
        {
          name: 'major_mode',
          label: 'Major mode',
          enabled: true,
          description: 'switch modes',
          inputSchema: {
            type: 'object',
            required: ['mode'],
            properties: {
              mode: { enum: ['a', 'b'] },
              force: { type: 'boolean' },
              level: { type: ['number', 'string'] },
              kind: { const: 'x' },
              any: { anyOf: [{ type: 'string' }, { const: 1 }] },
              odd: {},
              raw: 'junk',
            },
          },
        },
        { name: 'off', enabled: false },
        ...Array.from({ length: 6 }, (_, index) => ({ name: `t${index}`, enabled: true })),
      ],
      conflicts: [{ name: 'dup', message: 'twice' }, {}],
      unknownNames: ['ghost'],
    };
    const collapsed = texts(voiceResultLines('describe_voice_tools', text('', snapshot), done));
    expect(collapsed[0]).toBe('8 voice capabilities · catalog rev 3');
    expect(collapsed[1]).toBe('● Major mode · major_mode');
    expect(collapsed[2]).toBe('○ off · off · disabled');
    expect(collapsed).toContain('… 2 more');
    expect(collapsed).toContain('! dup · twice');
    expect(collapsed).toContain('! capability · Conflicting registrations.');
    expect(collapsed.at(-1)).toBe('? Unknown: ghost');

    const full = texts(voiceResultLines('describe_voice_tools', text('', snapshot), expanded));
    expect(full).toContain('switch modes');
    expect(full).toContain(
      'input  mode: a | b, force?: boolean, level?: number | string, kind?: x, any?: string | 1, odd?: value, raw?: value',
    );
    expect(full).not.toContain('… 2 more');

    const empty = texts(voiceResultLines('describe_voice_tools', text(JSON.stringify({ tools: [] })), done));
    expect(empty).toEqual(['0 voice capabilities', 'No voice capabilities are currently registered.']);
    const schemaless = texts(
      voiceResultLines(
        'describe_voice_tools',
        text('', { tools: [{ name: 'x', enabled: true, inputSchema: {} }] }),
        expanded,
      ),
    );
    expect(schemaless).toEqual(['1 voice capability', '● x · x']);
    const bare = voiceResultLines(
      'describe_voice_tools',
      text('', { tools: [{ name: 'x', enabled: true, inputSchema: { properties: {} } }] }),
      expanded,
    );
    expect(texts(bare)).toContain('input  {}');
  });

  it('lists a batch with each call outcome and its result values', () => {
    const batch = {
      status: 'completed',
      results: [
        { name: 'a', status: 'completed', result: 'done' },
        { name: 'b', status: 'completed', result: { count: 2, tags: ['x', 'y'], nested: { deep: true }, empty: [] } },
        { name: 'c', status: 'failed', error: { message: 'boom' } },
        { name: 'd', status: 'weird' },
        { name: 'e', status: 'completed', result: [{ deep: true }] },
        ...Array.from({ length: 5 }, (_, index) => ({ name: `f${index}`, status: 'not_executed' })),
      ],
      errors: [{ message: 'boom' }, { message: 'other' }, {}],
    };
    const collapsed = texts(voiceResultLines('use_voice_tools', text('', batch), done));
    expect(collapsed[0]).toBe('✓ Voice batch completed · 10 calls');
    expect(collapsed).toContain('✓ a · completed');
    expect(collapsed).toContain('done');
    expect(collapsed).toContain('count 2');
    expect(collapsed).toContain('tags x, y');
    expect(collapsed).toContain('empty none');
    expect(collapsed).not.toContain('nested {…}');
    expect(collapsed).toContain('✗ c · failed · boom');
    expect(collapsed).toContain('✗ d · failed');
    expect(collapsed).toContain('… 2 more');
    expect(collapsed.at(-1)).toBe('✗ other');
    const full = texts(voiceResultLines('use_voice_tools', text('', batch), expanded));
    expect(full).toContain('○ f4 · not executed');
    expect(full).not.toContain('… 2 more');
    // A capability-level error wins over the batch shape.
    expect(
      texts(voiceResultLines('use_voice_tools', text('', { error: { message: 'no host', retryable: true } }), done)),
    ).toEqual(['✗ no host · retryable']);
    expect(texts(voiceResultLines('use_voice_tools', text('', { error: {} }), done))).toEqual([
      '✗ Voice capability failed.',
    ]);
  });

  it('falls back to the text with the outcome glyph', () => {
    expect(texts(voiceResultLines('use_voice_tools', text('plain'), done))).toEqual(['✓ plain']);
    expect(texts(voiceResultLines('use_voice_tools', null, { ...done, isPartial: true }))).toEqual(['◐ Working…']);
    expect(texts(voiceResultLines('describe_voice_tools', null, { ...done, isError: true }))).toEqual([
      '✗ No result details.',
    ]);
    expect(voiceResultLines('use_voice_tools', text('not json'), done)[0]?.tone).toBe('muted');
  });

  it('reduces a narration to one status line', () => {
    expect(texts(voiceResultLines('narrate', text('Narration completed.', { outcome: 'completed' }), done))).toEqual([
      '✓ Narration completed',
    ]);
    expect(texts(voiceResultLines('narrate', text('', { outcome: 'interrupted' }), done))).toEqual([
      '⊘ Narration interrupted',
    ]);
    expect(texts(voiceResultLines('narrate', text('', { outcome: 'odd' }), done))).toEqual(['✗ Narration failed']);
    expect(texts(voiceResultLines('narrate', text('Narration is playing.'), { ...done, isPartial: true }))).toEqual([
      '◐ Narration playing',
    ]);
    expect(texts(voiceResultLines('narrate', text('', { error: { message: 'muted' } }), done))).toEqual(['✗ muted']);
    expect(texts(voiceResultLines('narrate', text('unknown'), done))).toEqual(['✓ unknown']);
  });
});
