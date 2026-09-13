import { describe, expect, it } from 'vitest';

import {
  buildDelegationResultMessages,
  buildSessionContextMessages,
  parseRealtimeEvent,
} from '../src/services/realtimeProtocol';

describe('V3 realtime event parsing', () => {
  it('parses ready, transcript delta and completed turn events', () => {
    expect(parseRealtimeEvent('{"type":"session.started","session":{"id":"session-1"}}')).toEqual({ type: 'ready' });
    expect(
      parseRealtimeEvent(
        '{"type":"input_transcript.added","item":{"id":"input-1","type":"input_transcript","text":"hello"}}',
      ),
    ).toEqual({ type: 'transcript', role: 'user', text: 'hello', complete: false });
    expect(
      parseRealtimeEvent(
        '{"type":"output_transcript.added","item":{"id":"output-1","type":"output_transcript","text":"hi"}}',
      ),
    ).toEqual({ type: 'transcript', role: 'assistant', text: 'hi', complete: false });
    expect(
      parseRealtimeEvent('{"type":"turn.done","turn":{"id":"turn-1","role":"assistant","transcript":"done"}}'),
    ).toEqual({ type: 'transcript', role: 'assistant', text: 'done', complete: true });
  });

  it('turns a client delegation into request text without inventing tool dispatch', () => {
    expect(
      parseRealtimeEvent(
        JSON.stringify({
          type: 'delegation.created',
          item: {
            id: 'delegation-1',
            type: 'delegation',
            target: 'client',
            content: [
              { type: 'input_text', text: 'check ' },
              { type: 'audio', audio: 'ignored' },
              { type: 'input_text', text: 'the tests' },
            ],
          },
        }),
      ),
    ).toEqual({ type: 'request', requestId: 'delegation-1', text: 'check the tests' });
    expect(
      parseRealtimeEvent(
        '{"type":"delegation.created","item":{"id":"x","type":"delegation","target":"server","content":[]}}',
      ),
    ).toBeUndefined();
  });

  it('sanitizes errors and ignores unsupported, malformed and oversized events', () => {
    expect(parseRealtimeEvent('{"type":"error","error":{"code":"rate_limit"},"message":"secret detail"}')).toEqual({
      type: 'error',
      code: 'rate_limit',
    });
    expect(parseRealtimeEvent('{"type":"error","message":"credential detail"}')).toEqual({
      type: 'error',
      code: 'realtime_error',
    });
    expect(parseRealtimeEvent('{')).toBeUndefined();
    expect(parseRealtimeEvent('{"type":"output_audio.delta","audio":"AAE="}')).toBeUndefined();
    expect(parseRealtimeEvent(JSON.stringify({ type: 'turn.done', padding: 'x'.repeat(65_536) }))).toBeUndefined();
  });

  it('rejects structurally invalid bounded events and unsafe error codes', () => {
    const invalid = [
      'null',
      '{}',
      '{"type":"session.updated","session":{}}',
      '{"type":"input_transcript.added","item":{"text":4}}',
      '{"type":"turn.done","turn":{"role":"system","transcript":"no"}}',
      '{"type":"delegation.created","item":{"id":"x","type":"delegation","target":"client"}}',
      '{"type":"delegation.created","item":{"id":"x","type":"delegation","target":"client","content":[{"type":"input_text","text":4}]}}',
    ];
    expect(invalid.map(parseRealtimeEvent)).toEqual(invalid.map(() => undefined));
    expect(parseRealtimeEvent('{"type":"error","code":"unsafe code"}')).toEqual({
      type: 'error',
      code: 'realtime_error',
    });
    expect(parseRealtimeEvent('{"type":"error","code":"top_level"}')).toEqual({ type: 'error', code: 'top_level' });
  });
});

describe('V3 realtime control serialization', () => {
  it('builds correlated delegation result and session context appends', () => {
    expect(
      buildDelegationResultMessages('delegation-1', 'finished', 'commentary').map((value) => JSON.parse(value)),
    ).toEqual([
      {
        type: 'delegation.context.append',
        delegation_item_id: 'delegation-1',
        channel: 'commentary',
        content: [{ type: 'input_text', text: 'finished' }],
      },
    ]);
    expect(buildSessionContextMessages('context').map((value) => JSON.parse(value))).toEqual([
      { type: 'session.context.append', content: [{ type: 'input_text', text: 'context' }] },
    ]);
  });

  it('chunks context at 500 UTF-8 bytes without splitting characters', () => {
    const messages = buildDelegationResultMessages('delegation-1', `${'a'.repeat(499)}😀tail`);
    const parsed = messages.map((message) => JSON.parse(message) as { content: Array<{ text: string }> });
    const chunks = parsed.map((message) => message.content[0]?.text ?? '');
    expect(chunks.join('')).toBe(`${'a'.repeat(499)}😀tail`);
    expect(chunks).toEqual(['a'.repeat(499), '😀tail']);
    expect(chunks.every((chunk) => new TextEncoder().encode(chunk).byteLength <= 500)).toBe(true);
  });

  it('rejects over-limit identifiers and text', () => {
    expect(() => buildDelegationResultMessages('x'.repeat(257), 'result')).toThrow('configured limit');
    expect(() => buildSessionContextMessages('x'.repeat(8_193))).toThrow('configured limit');
  });

  it('supports empty context while rejecting empty correlation IDs', () => {
    expect(buildSessionContextMessages('', 'speakable').map((value) => JSON.parse(value))).toEqual([
      {
        type: 'session.context.append',
        channel: 'speakable',
        content: [{ type: 'input_text', text: '' }],
      },
    ]);
    expect(() => buildDelegationResultMessages('', 'result')).toThrow('configured limit');
  });
});
