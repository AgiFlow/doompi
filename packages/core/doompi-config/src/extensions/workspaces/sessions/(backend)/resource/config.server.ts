import { selectionMetadata } from '../../../../services/configResources';
export default { name: 'doompi/config', kind: 'context' as const, read: selectionMetadata };
