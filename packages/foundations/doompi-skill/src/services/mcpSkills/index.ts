import { readFile } from 'node:fs/promises';

import type { DoomMcpPluginContext, DoomMcpSkill } from '@agimon-ai/doompi-core/mcpFacet';
import type { Context } from '@deepseek-ai/cordis';

import type { ServerSkillGroup } from '../serverInventory';

export const MCP_SKILLS_SERVICE = 'doom/discovered-mcp-skills';

export interface McpSkillProvider {
  list(context: DoomMcpPluginContext): readonly DoomMcpSkill[];
}

/** Explicit remote provider, never a projection of the local resource registry. */
export function mountMcpSkills(groups: readonly ServerSkillGroup[], signal: AbortSignal) {
  return (context: Context): void => {
    context.provide(MCP_SKILLS_SERVICE, {
      list(remote) {
        signal.throwIfAborted();
        remote.signal.throwIfAborted();
        const domains = remote.selection.read().domains;
        const skills = new Map<string, DoomMcpSkill>();
        for (const group of groups) {
          if (group.domain !== undefined && !domains.includes(group.domain)) continue;
          for (const skill of group.skills) {
            // Match command precedence, including shared copies across domains.
            if (skills.has(skill.name)) continue;
            skills.set(skill.name, {
              name: skill.name,
              description: skill.description,
              async read() {
                const readSignal = AbortSignal.any([signal, remote.signal]);
                readSignal.throwIfAborted();
                const text = await readFile(skill.filePath, { encoding: 'utf8', signal: readSignal });
                readSignal.throwIfAborted();
                return text;
              },
            });
          }
        }
        return [...skills.values()];
      },
    } satisfies McpSkillProvider);
  };
}

export function bindMcpSkills(context: DoomMcpPluginContext): readonly DoomMcpSkill[] {
  const provider = context.services.get<McpSkillProvider>(MCP_SKILLS_SERVICE);
  if (!provider) throw new Error('Discovered MCP skills are unavailable.');
  return provider.list(context);
}
