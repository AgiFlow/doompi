import { describe, expect, it } from 'vitest';
import { createDetachedBacklog, createFrameDecoder, encodeFrame } from '../../../src/services/sessionFraming.ts';

describe('createFrameDecoder', () => {
  it('reassembles a frame split across chunks', () => {
    const decode = createFrameDecoder();

    expect(decode('{"type":"mes')).toEqual([]);
    expect(decode('sage"}\n')).toEqual([{ type: 'message' }]);
  });

  it('returns every complete frame in one chunk and keeps the remainder', () => {
    const decode = createFrameDecoder();

    expect(decode('{"a":1}\n{"b":2}\n{"c":')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(decode('3}\n')).toEqual([{ c: 3 }]);
  });

  it('ignores blank lines and non-object frames', () => {
    const decode = createFrameDecoder();

    expect(decode('\n\n{"a":1}\n[1,2]\n"text"\n')).toEqual([{ a: 1 }]);
  });

  it('round-trips through the encoder', () => {
    const decode = createFrameDecoder();

    expect(decode(encodeFrame({ type: 'prompt', message: 'hi' }))).toEqual([{ type: 'prompt', message: 'hi' }]);
  });
});

describe('createDetachedBacklog', () => {
  it('keeps frames in order until drained', () => {
    const backlog = createDetachedBacklog(10);
    backlog.record({ a: 1 });
    backlog.record({ b: 2 });

    expect(backlog.drain()).toEqual({ frames: [{ a: 1 }, { b: 2 }], dropped: 0 });
  });

  it('empties itself once drained', () => {
    const backlog = createDetachedBacklog(10);
    backlog.record({ a: 1 });
    backlog.drain();

    expect(backlog.drain()).toEqual({ frames: [], dropped: 0 });
  });

  it('drops the oldest frames past the limit and counts the loss', () => {
    const backlog = createDetachedBacklog(2);
    backlog.record({ a: 1 });
    backlog.record({ b: 2 });
    backlog.record({ c: 3 });

    expect(backlog.drain()).toEqual({ frames: [{ b: 2 }, { c: 3 }], dropped: 1 });
  });
});
