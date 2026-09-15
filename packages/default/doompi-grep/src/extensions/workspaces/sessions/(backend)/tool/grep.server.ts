import { defineServerTool } from '@agimon-ai/doompi-core/extension-file';

import { createHeadlessGrepTool } from '../../../../../services/headlessGrep';

/**
 * Server only: the interactive host overrides Pi's own grep instead, so a
 * neutral file here would register a second one beside it.
 *
 * A native headless tool rather than a portable one, because the host
 * registers it untouched. Wrapping it as portable would route it through the
 * adapter that turns a throw into an error result, which is a different
 * contract from the one this tool already has.
 */
export default defineServerTool(createHeadlessGrepTool);
