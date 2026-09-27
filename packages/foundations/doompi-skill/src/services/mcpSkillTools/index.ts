import type { DoomHeadlessHostService, DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';

import { loadSkillParameters, searchSkillsParameters } from '../../schemas/mcpSkillTools';

function text(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function skills(context: Parameters<DoomHeadlessTool['execute']>[4]) {
  if (context.mcpSkills === undefined) throw new Error('Remote skill access is unavailable.');
  return context.mcpSkills;
}

export function createSearchSkillsTool(): DoomHeadlessTool<typeof searchSkillsParameters> {
  return {
    // web-plugin-tool-renderers: ignore search_skills (remote MCP only)
    name: 'search_skills',
    label: 'Search skills',
    description: 'Discover repository and active-domain skills available to this remote connection.',
    parameters: searchSkillsParameters,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_toolCallId, { query }, _signal, _onUpdate, context) {
      const needle = query?.trim().toLocaleLowerCase();
      const available = await skills(context).list();
      const matches =
        needle === undefined || needle === ''
          ? available
          : available.filter(({ name, description }) => `${name}\n${description}`.toLocaleLowerCase().includes(needle));
      return { ...text(JSON.stringify(matches)), structuredContent: { skills: matches } };
    },
  };
}

/**
 * The session agent's way into a skill. Its skills are listed in the prompt, which DoomPi
 * controls, so it needs no search; a remote agent's prompt is not ours, hence the pair above.
 */
export function createSessionLoadSkillTool(
  host: Pick<DoomHeadlessHostService, 'readSkill'>,
): DoomHeadlessTool<typeof loadSkillParameters> {
  return {
    // web-plugin-tool-renderers: ignore load_skill (server session only, shown as a generic call)
    // DOOM_LOAD_SKILL_TOOL, spelled out so the renderer rule can read it.
    name: 'load_skill',
    label: 'Load skill',
    description: 'Load the full instructions of a skill from the available skills list by exact name.',
    parameters: loadSkillParameters,
    executionMode: 'parallel',
    async execute(_toolCallId, { name }) {
      const body = host.readSkill(name);
      if (body === undefined) return { ...text(`No skill named ${name} is available in this session.`), isError: true };
      return text(body);
    },
  };
}

export function createLoadSkillTool(): DoomHeadlessTool<typeof loadSkillParameters> {
  return {
    // web-plugin-tool-renderers: ignore load_skill (remote MCP only)
    name: 'load_skill',
    label: 'Load skill',
    description: 'Load the full Markdown instructions for an available remote skill by exact name.',
    parameters: loadSkillParameters,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_toolCallId, { name }, _signal, _onUpdate, context) {
      return text(await skills(context).read(name));
    },
  };
}
