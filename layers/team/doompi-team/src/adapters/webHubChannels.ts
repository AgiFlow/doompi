import type { WebHubChannel } from '@agimon-ai/doompi-web-contracts';
import { createSubagentCatalogChannel } from './webSubagentCatalogChannel.ts';
import { createSubagentsChannel } from './webSubagentsChannel.ts';

/** The named export the generated hub registry imports: this package's data channels, in install order. */
export const webHubChannels: readonly WebHubChannel[] = [createSubagentsChannel(), createSubagentCatalogChannel()];
