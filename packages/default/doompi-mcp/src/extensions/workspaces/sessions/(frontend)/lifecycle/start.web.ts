import { defineWebLifecycle } from '@agimon-ai/doompi-core/web';

import { startMcpAppRuntime } from '../tool/_lib/mcpAppRuntime';

export default defineWebLifecycle(startMcpAppRuntime);
