import { definePiTool } from '@agimon-ai/doompi-core/pi-extension';

import { createHashlineReadTool } from '../../../../../services/readTool';

export default definePiTool(createHashlineReadTool(), { overrides: true });
