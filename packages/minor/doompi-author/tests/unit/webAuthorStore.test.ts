import { describe, expect, it } from 'vitest';
import { author, authorChannel } from '../../src/web/authorStore.ts';

const session = (sessionId: string | null) => author.select(author.store.state, sessionId);

describe('the author web store channel', () => {
  it('keeps trusted session views separately', () => {
    author.reset();
    authorChannel.apply('s1', authorChannel.parse({ activation: 'active', capabilityCount: 2 })!);
    expect(session('s1')).toEqual({ activation: 'active', capabilityCount: 2 });
    expect(session(null)).toEqual({ activation: 'inactive', capabilityCount: 0 });
    authorChannel.drop('s1');
    expect(author.store.state.s1).toBeUndefined();
    author.reset();
  });

  it('rejects malformed payloads', () => {
    expect(authorChannel.parse('junk')).toBeNull();
    expect(authorChannel.parse({ activation: 'active', capabilityCount: -1 })).toBeNull();
  });
});
