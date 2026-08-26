import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';

/**
 * This package's cockpit presence: pure metadata. The selection bar renders
 * the minor-mode entry and folds in what the session reports; no signal is published yet, so it shows as unavailable.
 */
export const webPlugin = defineWebPlugin({
  id: 'help',
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
});
