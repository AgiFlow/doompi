import { definePiExtension, definePiTool } from '@agimon-ai/doompi-core/pi-extension';
import { PACKAGE_SOURCE } from '../constants/package';
import { createHashlineReadTool } from '../tools/piRead';

export const activateDoomPiReadExtension = definePiExtension(PACKAGE_SOURCE, () => ({
  toolOverrides: [{ source: PACKAGE_SOURCE, tools: ['read'], replacements: [definePiTool(createHashlineReadTool())] }],
}));
export default activateDoomPiReadExtension;
