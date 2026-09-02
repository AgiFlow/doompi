import type { SkillEntry } from '@agimon-ai/doompi-skill/catalog';
import { type CountTokens, type ToolSource, tokensForTool } from '@agimon-ai/doompi-ui/toolInventory';
import type { ContextItemDetail, ContextToolDetail } from '../types/contextApi.ts';

/**
 * The prose and schema behind the projection's figures.
 *
 * Built from the same inventory in the same pass, so a detail can never
 * describe a composition the panel is not showing. Nothing is grouped here:
 * the panel already knows which mode a row sits under, and a lookup by name is
 * all a click needs.
 */

const MCP_KEY_PREFIX = 'mcp:';
const CORE_OWNER = 'pi';

/** The same join the projection makes, so a row and its detail agree on the owner. */
function ownerOf(source: ToolSource): string {
  if (source.kind === 'extension') return source.packageName ?? source.key;
  if (source.kind === 'mcp') return source.key.slice(MCP_KEY_PREFIX.length);
  return CORE_OWNER;
}

function skillSource(group: SkillEntry['group']): ContextItemDetail['source'] {
  if (group === 'plugins') return 'plugin';
  if (group === 'extensions') return 'extension';
  return 'core';
}

export interface ContextDetailInput {
  readonly sources: readonly ToolSource[];
  readonly skills: readonly SkillEntry[];
  readonly countTokens: CountTokens;
}

export function buildContextDetail(input: ContextDetailInput): ContextItemDetail[] {
  const items: ContextItemDetail[] = [];

  for (const source of input.sources) {
    const owner = ownerOf(source);
    for (const tool of source.tools) {
      const cost = tokensForTool(tool, input.countTokens);
      const detail: ContextToolDetail = {
        itemKind: 'tool',
        name: tool.name,
        owner,
        source: source.kind === 'core' ? 'core' : source.kind,
        active: tool.active,
        tokens: { schemaTokens: cost.schemaTokens, promptTokens: cost.promptTokens, totalTokens: cost.totalTokens },
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.promptSnippet ? { promptSnippet: tool.promptSnippet } : {}),
        ...(tool.promptGuidelines?.length ? { promptGuidelines: tool.promptGuidelines } : {}),
        ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
      };
      items.push(detail);
    }
  }

  for (const skill of input.skills) {
    items.push({
      itemKind: 'skill',
      name: skill.name,
      owner: skill.owner,
      source: skillSource(skill.group),
      active: true,
      tokens: skill.promptTokens ?? 0,
      description: skill.description,
      filePath: skill.filePath,
      modelInvocable: skill.modelInvocable,
    });
  }

  return items;
}
