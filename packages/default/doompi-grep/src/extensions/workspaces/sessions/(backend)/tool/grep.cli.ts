import { definePiTool } from '@agimon-ai/doompi-core/pi-extension';

import { createHashlineGrepTool } from './_lib/grepTool';

export default definePiTool(createHashlineGrepTool(), { overrides: true });
