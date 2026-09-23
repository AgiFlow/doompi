import { definePiTool } from '@agimon-ai/doompi-core/piExtension';

import { createHashlineReadTool } from './_lib/readTool';

export default definePiTool(createHashlineReadTool(), { overrides: true });
