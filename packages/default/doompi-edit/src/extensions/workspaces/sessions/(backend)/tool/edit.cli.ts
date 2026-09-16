import { definePiTool } from '@agimon-ai/doompi-core/pi-extension';

import { createHashlineEditTool } from '../../../../../services/editTool';

export default definePiTool(createHashlineEditTool(), { overrides: true });
