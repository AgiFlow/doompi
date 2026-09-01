import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';

/**
 * This package's cockpit presence: pure metadata. The selection bar renders
 * the domains axis from what the session reports through the 'doom-domain'
 * footer status, a comma-separated list because several domains compose at
 * once.
 */
export const webPlugin = defineWebPlugin({
  id: 'domain',
  selectionAxes: [
    { name: 'domains', command: 'domains', statusKey: 'doom-domain', emptyLabel: 'no domains', multi: true, order: 20 },
  ],
});
