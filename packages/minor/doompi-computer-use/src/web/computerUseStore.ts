import { defineSessionStore } from '@agimon-ai/doompi-web-contracts';
import { computerUseChannelType } from '../types/computerUseApi.ts';
import type { ComputerUseChannelPayload } from '../types/computerUseApi.ts';

export interface ComputerUseSession extends ComputerUseChannelPayload {}

const initialState: ComputerUseSession = {
  state: { sessionId: '', revision: 0, wake: 0, phase: 'inactive' },
  targets: [],
};

export const computerUse = defineSessionStore<ComputerUseSession>(initialState);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const computerUseChannel = computerUse.channel<ComputerUseChannelPayload>({
  channel: computerUseChannelType,
  parse(input) {
    if (!isRecord(input) || !isRecord(input.state) || !Array.isArray(input.targets)) return null;
    if (typeof input.state.phase !== 'string' || typeof input.state.revision !== 'number') return null;
    return input as unknown as ComputerUseChannelPayload;
  },
  reduce: (_current, payload) => payload,
});
