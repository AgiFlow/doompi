import { definePiExtension, definePiTool } from '@agimon-ai/doompi-core/pi-extension';

import { PACKAGE_SOURCE } from '../constants/package';
import { createHashlineEditTool } from '../tools/piEdit';

export const activateDoomPiEditExtension = definePiExtension(PACKAGE_SOURCE, () => ({
  toolOverrides: [{ source: PACKAGE_SOURCE, tools: ['edit'], replacements: [definePiTool(createHashlineEditTool())] }],
}));
export default activateDoomPiEditExtension;
