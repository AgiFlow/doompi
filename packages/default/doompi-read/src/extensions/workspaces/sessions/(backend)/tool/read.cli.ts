import { definePiTool } from '@agimon-ai/doompi-core/pi-extension';

import { createHashlineReadTool } from './_lib/readTool';

export default definePiTool(createHashlineReadTool(), { overrides: true });
