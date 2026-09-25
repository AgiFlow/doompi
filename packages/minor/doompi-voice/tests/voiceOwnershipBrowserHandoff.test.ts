import { afterEach, expect, it } from 'vitest';

import {
  activeVoiceSession,
  voiceMediaHandoff,
  voiceOwnershipChannel,
} from '../src/extensions/workspaces/sessions/(frontend)/_lib/voiceMediaWakeStore';
import { VOICE_OWNERSHIP_PROTOCOL_VERSION, parseBrowserVoiceOwnershipPayload } from '../src/types/voiceOwnership';

afterEach(() => {
  activeVoiceSession.reset();
  voiceMediaHandoff.reset();
});

it('keeps staged ownership distinct from explicit stop and rejects malformed handoffs', () => {
  const preparing = {
    type: 'browser-media-session',
    version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
    activeSessionId: 'source',
    handoff: { id: 'tx-1', phase: 'preparing', sourceSessionId: 'source', targetSessionId: 'target' },
  } as const;
  expect(parseBrowserVoiceOwnershipPayload({ ...preparing, version: 3 })).toBeUndefined();
  expect(
    parseBrowserVoiceOwnershipPayload({
      ...preparing,
      handoff: { id: 'tx-1', phase: 'rebinding', sourceSessionId: 'source' },
    }),
  ).toBeUndefined();
  const parsed = voiceOwnershipChannel.parse(preparing);
  expect(parsed).not.toBeNull();
  voiceOwnershipChannel.apply('source', parsed!);
  expect(activeVoiceSession.store.state).toBe('source');
  expect(voiceMediaHandoff.store.state?.phase).toBe('preparing');

  voiceOwnershipChannel.apply('source', {
    ...preparing,
    activeSessionId: null,
    handoff: { ...preparing.handoff, phase: 'failed' },
  });
  voiceOwnershipChannel.drop('source');
  expect(voiceMediaHandoff.store.state?.id).toBe('tx-1');
  voiceOwnershipChannel.apply('source', {
    type: 'browser-media-session',
    version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
    activeSessionId: null,
  });
  expect(voiceMediaHandoff.store.state).toBeUndefined();
  expect(activeVoiceSession.store.state).toBeNull();
});
