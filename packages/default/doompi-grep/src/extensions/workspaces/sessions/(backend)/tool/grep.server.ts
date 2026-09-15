import { defineServerTool } from '@agimon-ai/doompi-core/extension-file';

import { createHeadlessGrepTool } from '../../../../../services/grepTool';

export default defineServerTool(createHeadlessGrepTool);
