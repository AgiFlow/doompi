import type { WebPluginDefinition } from '@agimon-ai/doompi-core/web';

export default {
  minorModes: [{ name: 'help', keys: 'h e', order: 10 }],
  // The TUI's SPC h e, through the /minor command an RPC client can send.
  leaderBindings: [
    {
      id: 'help.toggle',
      path: [
        { key: 'h', label: 'help', detail: 'package docs and logs' },
        { key: 'e', label: 'toggle', detail: 'load or hide package Help' },
      ],
      command: 'minor help',
    },
  ],
} satisfies NonNullable<WebPluginDefinition['session']>;
