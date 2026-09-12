import { definePiExtension } from '@agimon-ai/doompi-extension-contracts/pi-extension';
import { createDomainRuntime } from '../controllers/domainRuntime';
import { createDomainTelemetry } from '../services/logSinkTelemetry';
import { DOMAIN_SOURCE } from '../types/domains';
import type { DomainTelemetry } from '../types/telemetry';

export const domainsExtension = definePiExtension<DomainTelemetry>(DOMAIN_SOURCE, ({ pi, options }) => ({
  ...createDomainRuntime({ pi, telemetry: options ?? createDomainTelemetry() }),
  resources: [
    {
      source: DOMAIN_SOURCE,
      moduleUrl: import.meta.url,
      skills: [
        {
          name: 'doompi-author-domain',
          description:
            'Configure DoomPi plugin catalogs and domain resource selections in domains.yaml. Use when creating or editing .doom/domains.yaml or ~/.pi/.doom/domains.yaml, choosing local, Git, or npm plugins, filtering plugin resources, setting aliases or defaults, or verifying resolved domain composition.',
        },
      ],
    },
  ],
}));
export default domainsExtension;
