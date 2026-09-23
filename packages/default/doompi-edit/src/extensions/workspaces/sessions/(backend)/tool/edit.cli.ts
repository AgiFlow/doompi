import { definePiTool } from '@agimon-ai/doompi-core/piExtension';

import { createHashlineEditTool } from '../../../../../services/editTool';

export default definePiTool(createHashlineEditTool(), { overrides: true });
