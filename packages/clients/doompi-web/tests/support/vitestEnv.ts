import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// Keep workflow fixtures isolated from the developer's real configuration.
process.env.WORKFLOW_MCP_HOME = path.join(os.tmpdir(), `doompi-web-vitest-workflows-${randomUUID()}`);
