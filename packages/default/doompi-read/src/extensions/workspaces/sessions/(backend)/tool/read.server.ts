import { defineServerTool } from '@agimon-ai/doompi-core/extension-file';

import { createHeadlessReadTool } from '../../../../../services/readTool';

export default defineServerTool(createHeadlessReadTool);
