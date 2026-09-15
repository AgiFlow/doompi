import { definePiTool } from '@agimon-ai/doompi-core/pi-extension';

import { createHashlineGrepTool } from '../../../../../services/grepTool';

export default definePiTool(createHashlineGrepTool(), { overrides: true });
