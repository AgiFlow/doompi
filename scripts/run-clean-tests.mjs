import { spawnSync } from 'node:child_process';
import process from 'node:process';

const blockedNames = new Set(['DOOM_RUNNER_LIFELINE', 'PI_CODING_AGENT', 'PI_CODING_AGENT_DIR', 'PI_SESSION_ID']);
const blockedPrefixes = ['AGENT_HARNESS_', 'DOOMPI_', 'DOOM_PI_', 'PI_SUBAGENT_'];
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !blockedPrefixes.some((prefix) => name.startsWith(prefix)) && !blockedNames.has(name),
  ),
);
environment.NX_DAEMON = 'false';

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('A test command is required.');

const result = spawnSync(command, args, { env: environment, stdio: 'inherit', shell: false });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
