import { defineServerTool } from '@agimon-ai/doompi-core/extensionFile';

import { createHeadlessReadTool } from '../../../../../services/readTool';

export default defineServerTool(createHeadlessReadTool);
