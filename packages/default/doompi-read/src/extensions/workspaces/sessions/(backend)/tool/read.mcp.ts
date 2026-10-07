import { defineMcpTool } from '@agimon-ai/doompi-core/mcpFacet';

import { createHeadlessReadTool } from '../../../../../services/readTool';

export default defineMcpTool(() => ({
  ...createHeadlessReadTool(),
  description:
    "Read a text file from the DoomPi session's repository on the host machine (open, view, cat). Returns a file hash and line anchors such as 5#abc that this server's edit tool requires. Use offset and limit for large files; text is truncated at 2000 lines or 50KB.",
}));
