import { defineGlobalStore, defineSessionStore } from '@agimon-ai/doompi-web-contracts';
import { VOICE_MEDIA_WAKE_TYPE, type VoiceMediaWake } from '../types/clientMedia.ts';
import {
  VOICE_OWNERSHIP_FRAME_TYPE,
  parseBrowserVoiceOwnershipPayload,
  type BrowserVoiceOwnershipPayload,
} from '../types/voiceOwnership.ts';

const MAX_EVENT_EPOCH_LENGTH = 200;

export const voiceMediaWakes = defineSessionStore<VoiceMediaWake | undefined>(undefined);
export const activeVoiceSession = defineGlobalStore<string | null>(null);
export interface VoiceMediaBrowserState {
  sessionId: string;
  phase: 'connecting' | 'connected' | 'conflict';
}
export const voiceMediaBrowserState = defineGlobalStore<VoiceMediaBrowserState | undefined>(undefined);

export function parseVoiceMediaWakePayload(input: unknown): VoiceMediaWake | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'eventEpoch' || keys[1] !== 'sequence') return null;
  if (
    typeof record.eventEpoch !== 'string' ||
    record.eventEpoch.length === 0 ||
    record.eventEpoch.length > MAX_EVENT_EPOCH_LENGTH ||
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) < 0
  )
    return null;
  return { eventEpoch: record.eventEpoch, sequence: record.sequence as number };
}

export const voiceMediaWakeChannel = {
  channel: VOICE_MEDIA_WAKE_TYPE,
  parse: parseVoiceMediaWakePayload,
  apply(sessionId: string, payload: VoiceMediaWake) {
    voiceMediaWakes.update(sessionId, (current) =>
      current?.eventEpoch === payload.eventEpoch && payload.sequence <= current.sequence ? current : payload,
    );
  },
  drop(sessionId: string) {
    voiceMediaWakes.drop(sessionId);
  },
};

export const voiceOwnershipChannel = {
  channel: VOICE_OWNERSHIP_FRAME_TYPE,
  parse(input: unknown): BrowserVoiceOwnershipPayload | null {
    return parseBrowserVoiceOwnershipPayload(input) ?? null;
  },
  apply(_sessionId: string, payload: BrowserVoiceOwnershipPayload) {
    activeVoiceSession.update((current) => (current === payload.activeSessionId ? current : payload.activeSessionId));
  },
  drop(sessionId: string) {
    activeVoiceSession.update((current) => (current === sessionId ? null : current));
  },
};

export function waitForVoiceMediaWake(
  sessionId: string,
  eventEpoch: string,
  after: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<VoiceMediaWake | undefined> {
  const matchingWake = (): VoiceMediaWake | undefined => {
    const wake = voiceMediaWakes.select(voiceMediaWakes.store.state, sessionId);
    return wake?.eventEpoch === eventEpoch && wake.sequence > after ? wake : undefined;
  };
  const current = matchingWake();
  if (current !== undefined || signal.aborted) return Promise.resolve(current);

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let subscription: { unsubscribe(): void } | undefined;
    const finish = (wake?: VoiceMediaWake): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      subscription?.unsubscribe();
      resolve(wake);
    };
    const aborted = (): void => finish();
    subscription = voiceMediaWakes.store.subscribe(() => {
      const wake = matchingWake();
      if (wake !== undefined) finish(wake);
    });
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) {
      finish();
      return;
    }
    timer = setTimeout(() => finish(), timeoutMs);
    const afterSubscribe = matchingWake();
    if (afterSubscribe !== undefined) finish(afterSubscribe);
  });
}
