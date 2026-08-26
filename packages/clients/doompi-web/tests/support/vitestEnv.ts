import os from 'node:os';
import path from 'node:path';

// Hub construction starts a workflow-registry watcher by default. Point it at
// a throwaway home for every vitest run so no suite ever reads the
// developer's real ~/.workflow-mcp; tests that want workflow runs pass their
// own home through the hub's watchWorkflows seam.
process.env.WORKFLOW_MCP_HOME = path.join(os.tmpdir(), `doompi-web-vitest-workflows-${process.pid}`);
