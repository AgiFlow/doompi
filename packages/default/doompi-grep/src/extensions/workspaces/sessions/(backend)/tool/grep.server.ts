import { createHeadlessGrepTool } from '../../../../../services/headlessGrep';

/**
 * Server only: the interactive host overrides Pi's own grep instead, so a
 * neutral file here would register a second one beside it.
 */
export default createHeadlessGrepTool;
