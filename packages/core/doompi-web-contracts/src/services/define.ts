import type { SessionChannelContribution, WebPluginDefinition } from '../types/webPlugin.ts';

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
