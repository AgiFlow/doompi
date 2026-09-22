import { defineServerTool } from '@agimon-ai/doompi-core/extensionFile';

import { createHeadlessEditTool } from '../../../../../services/editTool';

export default defineServerTool(createHeadlessEditTool);
