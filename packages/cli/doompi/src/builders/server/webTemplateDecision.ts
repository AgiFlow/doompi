import path from 'node:path';

import { loadDoomConfigLayers } from '@agimon-ai/doompi-config/config';

interface WebTemplateDecision {
  id?: string;
  mount: { scope: 'global' } | { scope: 'workspace'; workspaceId: string };
}

/** Resolve presentation from the server launch, never the selected session or workspace. */
export function resolveWebTemplateDecision(options: {
  cwd: string;
  launchWorkspaceId?: string;
  workspaces: readonly { id: string; root: string }[];
  homeDirectory: string;
  environment: NodeJS.ProcessEnv;
  notice: (message: string) => void;
}): WebTemplateDecision {
  // ponytail: without initial admission, a member checkout outside its canonical workspace
  // root falls back to global config. Resolving it must not admit or sync a new workspace.
  const workspace =
    options.workspaces.find((candidate) => candidate.id === options.launchWorkspaceId) ??
    options.workspaces
      .filter((candidate) => {
        const relative = path.relative(candidate.root, options.cwd);
        return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      })
      .sort((left, right) => right.root.length - left.root.length)[0];
  const mount: WebTemplateDecision['mount'] =
    workspace === undefined ? { scope: 'global' } : { scope: 'workspace', workspaceId: workspace.id };
  try {
    const id = loadDoomConfigLayers(workspace?.root, options.homeDirectory, options.environment).valueAt([
      'web',
      'template',
    ]);
    return { ...(typeof id === 'string' ? { id } : {}), mount };
  } catch (error) {
    options.notice(`Web template configuration unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return { mount };
  }
}
