/**
 * Public availability check for a subagent launch.
 *
 * Lives in adapters rather than services: resolving the contract stats the
 * working directory and reads agent definitions off disk.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { AgentDiscoveryService } from './agents/discovery';
import type { AgentConfig, AgentScope } from './agents/types';

export interface SubagentLaunchContractInput {
  agent: string;
  cwd: string;
  task?: string;
  agentScope?: AgentScope;
  context?: 'fresh' | 'fork';
  skill?: string | string[] | boolean;
  artifacts?: boolean;
}

export interface SubagentLaunchContract {
  agent: AgentConfig;
  cwd: string;
  context: 'fresh' | 'fork';
}

export type SubagentLaunchContractResult =
  | { ok: true; contract: SubagentLaunchContract }
  | { ok: false; code: 'invalid_cwd' | 'missing_agent'; message: string };

/** Lightweight public availability check using Doom Team's discovery rules. */
export async function resolveSubagentLaunchContract(
  input: SubagentLaunchContractInput,
): Promise<SubagentLaunchContractResult> {
  const cwd = path.resolve(input.cwd);
  try {
    if (!fs.statSync(cwd).isDirectory()) {
      return { ok: false, code: 'invalid_cwd', message: `cwd '${cwd}' is not a directory.` };
    }
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : '';
    return { ok: false, code: 'invalid_cwd', message: `cwd '${cwd}' is not a directory.${detail}` };
  }

  const agent = new AgentDiscoveryService().find(cwd, input.agentScope ?? 'both', input.agent);
  if (!agent) return { ok: false, code: 'missing_agent', message: `Unknown agent: ${input.agent}` };

  return {
    ok: true,
    contract: { agent, cwd, context: input.context ?? agent.defaultContext ?? 'fresh' },
  };
}
