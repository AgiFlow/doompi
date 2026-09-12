import { definePiExtension, definePiTool } from '@agimon-ai/doompi-core/pi-extension';
import { PACKAGE_SOURCE } from '../constants/package';
import { createHashlineGrepTool } from '../tools/piGrep';

export const activateDoomPiGrepExtension = definePiExtension(PACKAGE_SOURCE, () => ({
  toolOverrides: [{ source: PACKAGE_SOURCE, tools: ['grep'], replacements: [definePiTool(createHashlineGrepTool())] }],
}));
export default activateDoomPiGrepExtension;
