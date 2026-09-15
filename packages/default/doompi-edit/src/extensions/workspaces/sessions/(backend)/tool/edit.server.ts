import { defineServerTool } from '@agimon-ai/doompi-core/extension-file';

import { createHeadlessEditTool } from '../../../../../services/editTool';

export default defineServerTool(createHeadlessEditTool);
