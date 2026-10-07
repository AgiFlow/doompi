import { defineMcpTool } from '@agimon-ai/doompi-core/mcpFacet';

import { createHeadlessEditTool } from '../../../../../services/editTool';

export default defineMcpTool(() => ({
  ...createHeadlessEditTool(),
  description:
    "Edit or patch an existing file in the DoomPi session's repository on the host machine. Replace or delete line ranges using the file hash and anchors (such as 5#abc) from this server's read or grep tool. Each from and to holds one anchor; empty content deletes the range.",
}));
