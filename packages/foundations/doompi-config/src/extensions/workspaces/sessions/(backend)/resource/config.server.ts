import { defineResource } from '@agimon-ai/doompi-core/extensionFile';

import { selectionMetadata } from '../../../../../services/configResources';
export default defineResource({ name: 'doompi/config', kind: 'context' as const, read: selectionMetadata });
