import { defineResource } from '@agimon-ai/doompi-core/extension-file';

import { DOMAIN_SOURCE } from '../../../../../types/domains';
export default defineResource({
  source: DOMAIN_SOURCE,
  moduleUrl: import.meta.url,
  skills: [
    {
      name: 'doompi-author-domain',
      description:
        'Configure DoomPi plugin catalogs and domain resource selections in domains.yaml. Use when creating or editing .doom/domains.yaml or ~/.pi/.doom/domains.yaml, choosing local, Git, or npm plugins, filtering plugin resources, setting aliases or defaults, or verifying resolved domain composition.',
    },
  ],
});
