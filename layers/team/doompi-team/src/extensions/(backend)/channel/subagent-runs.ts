import { defineChannel } from '@agimon-ai/doompi-core/extension-file';

import { createSubagentsChannel } from '../../../controllers/webSubagentsChannel';

/**
 * The run graph, at every scope.
 *
 * Declared at global and cascaded: the hub serves this at global and workspace
 * as well as inside a session, and the facet used to name the same factory
 * three times to say so.
 */
export default defineChannel(createSubagentsChannel);
