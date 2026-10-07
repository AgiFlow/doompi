import { defineMcpTool } from '@agimon-ai/doompi-core/mcpFacet';

import { createHeadlessGrepTool } from '../../../../../services/grepTool';

export default defineMcpTool(() => ({
  ...createHeadlessGrepTool(),
  description:
    "Search file contents in the DoomPi session's repository on the host machine (ripgrep, regex or literal, code search). Respects .gitignore. Matches include file hashes and line anchors for this server's edit tool.",
}));
