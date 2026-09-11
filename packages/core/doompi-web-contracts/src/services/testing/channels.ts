import type { SessionChannelContribution } from '../../types/webPlugin.ts';

export interface ChannelDelivery {
  accepted: boolean;
}

export function driveChannel(
  channel: SessionChannelContribution,
  sessionId: string,
  payload: unknown,
): ChannelDelivery {
  const parsed: unknown = channel.parse(payload);
  if (parsed === null) return { accepted: false };
  channel.apply(sessionId, parsed);
  return { accepted: true };
}
