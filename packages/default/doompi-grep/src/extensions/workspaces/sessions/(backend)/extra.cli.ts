import { definePiTool } from '@agimon-ai/doompi-core/pi-extension';

import { PACKAGE_SOURCE } from '../../../../constants/package';
import { createHashlineGrepTool } from '../../../../tools/piGrep';

/**
 * Grep replaces Pi's built-in tool rather than adding one of its own.
 *
 * That is a tool override, not a `tool/` file: a surface folder declares a
 * contribution this package owns, while an override claims a name something
 * else already registered. Overrides have no folder, so they come through the
 * escape hatch.
 */
export default {
  toolOverrides: [{ source: PACKAGE_SOURCE, tools: ['grep'], replacements: [definePiTool(createHashlineGrepTool())] }],
};
