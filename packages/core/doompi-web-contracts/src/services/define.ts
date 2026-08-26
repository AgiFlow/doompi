import type { SessionChannelContribution, SlotDeclaration, WebPluginDefinition } from '../types/webPlugin.ts';

/** Identity helper so plugin modules get checked literals without a type annotation. */
export function defineWebPlugin(plugin: WebPluginDefinition): WebPluginDefinition {
  return plugin;
}

/**
 * The one audited erasure from Payload to unknown. Channels are stored
 * untyped in the host registry; the payload type lives entirely inside the
 * plugin, behind its own parse gate.
 */
export function defineSessionChannel<Payload>(
  channel: SessionChannelContribution<Payload>,
): SessionChannelContribution {
  return channel as SessionChannelContribution;
}

/**
 * Identity helper for a typed slot handle: the owner keeps the
 * SlotDeclaration<Data> to read its fills back through slotData, and the
 * plugin's `slots` array holds it erased. No cast is needed because Data only
 * appears in the parse gate's return position.
 */
export function defineSlot<Data>(slot: SlotDeclaration<Data>): SlotDeclaration<Data> {
  return slot;
}
