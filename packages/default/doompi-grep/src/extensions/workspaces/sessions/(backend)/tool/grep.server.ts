import { defineServerTool } from '@agimon-ai/doompi-core/extensionFile';

import { createHeadlessGrepTool } from '../../../../../services/grepTool';

export default defineServerTool(createHeadlessGrepTool);
