import { definePiTool } from '@agimon-ai/doompi-core/pi-extension';

import { createHashlineGrepTool } from '../../../../../tools/piGrep';

/**
 * Pi ships its own grep, so this replaces that name rather than adding one.
 *
 * `overrides` is what makes it a claim the host arbitrates instead of a second
 * registration: only one package may own a name, and the loser registers
 * nothing. It sits in `tool/` beside the server half because from the author's
 * side both are "this package provides grep"; the difference is in the value,
 * which is the only place that knows it.
 */
export default definePiTool(createHashlineGrepTool(), { overrides: true });
