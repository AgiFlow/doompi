import { DIRECT_TOOLS_ENV, NO_DIRECT_TOOLS } from '../../schemas/directTools.ts';
import { DirectToolFilter } from '../../services/directTools.ts';

/** Reads a child agent's MCP tool selection from the process environment. */
export function readDirectToolFilter(environment: NodeJS.ProcessEnv = process.env): DirectToolFilter | undefined {
  const raw = environment[DIRECT_TOOLS_ENV];
  if (raw === undefined || raw === '') return undefined;
  if (raw === NO_DIRECT_TOOLS) return new DirectToolFilter([]);
  return new DirectToolFilter(raw.split(','));
}
