import { definePiTool } from '@agimon-ai/doompi-core/piExtension';

import { createHashlineGrepTool } from './_lib/grepTool';

export default definePiTool(createHashlineGrepTool(), { overrides: true });
