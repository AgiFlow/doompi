import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DOOM_SKILL_SOURCES_SERVICE, requireDoomSkillSourcesService } from '@agimon-ai/doompi-core/skills';
import type { PiEventHandlers, PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

type PiContext = PiPluginContext<unknown>['context'];

const DESIGN_SOURCE = '@agimon-ai/doompi-style-system';
const MAX_SEEN_TOOL_CALLS = 256;
const UI_FILE_PATTERN = /\.(?:css|less|sass|scss|jsx|tsx|vue|svelte)$/u;

export interface StyleSystemPiScope {
  readonly toolResult: NonNullable<PiEventHandlers['tool_result']>;
}

function packageRoot(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(directory, 'package.json'))) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Style-system resources are unavailable.');
    directory = parent;
  }
  return directory;
}

export function styleSystemSkillDirectory(): string {
  return path.join(packageRoot(), 'skills');
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sourcePath(input: Record<string, unknown>, cwd: string): string | undefined {
  const value = input.path;
  if (typeof value !== 'string' || value.trim() === '' || !UI_FILE_PATTERN.test(value)) return undefined;
  const root = path.resolve(cwd);
  const candidate = path.resolve(root, value);
  return contained(root, candidate) ? candidate : undefined;
}

function registerSkillSource(context: PiContext): void {
  context.inject([DOOM_SKILL_SOURCES_SERVICE], (skillContext) => {
    const contribution = requireDoomSkillSourcesService(skillContext).register({
      source: DESIGN_SOURCE,
      directories: [styleSystemSkillDirectory()],
    });
    return () => contribution.dispose();
  });
}

export function createStyleSystemPiRoot(): { value: StyleSystemPiScope; services: readonly [typeof registerSkillSource] } {
  const seen = new Set<string>();
  let reminded = false;
  const toolResult: NonNullable<PiEventHandlers['tool_result']> = async (event, context) => {
    if (event.isError || reminded || seen.has(event.toolCallId)) return undefined;
    seen.add(event.toolCallId);
    if (seen.size > MAX_SEEN_TOOL_CALLS) seen.delete(seen.values().next().value!);
    if (event.toolName !== 'edit' && event.toolName !== 'write') return undefined;
    if (sourcePath(event.input, context.cwd) === undefined) return undefined;
    reminded = true;
    return {
      content: [
        ...event.content,
        {
          type: 'text' as const,
          text: 'Design source changed. Use the design skill and CLI to check existing components and tokens; run the readiness check before requesting approval.',
        },
      ],
    };
  };
  return { value: { toolResult }, services: [registerSkillSource] };
}

export default createStyleSystemPiRoot;
