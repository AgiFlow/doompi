import { promises as fs } from 'node:fs';
import path from 'node:path';

import { resetStyleSystemConfigCache, StoriesIndexService, StyleSystemConfigLoader } from '@agimon-ai/style-system';

import type {
  StyleSystemCatalogProject,
  StyleSystemCatalogRequest,
  StyleSystemCatalogView,
} from '../../types/styleSystemCatalog';

const CONFIG_FILE = 'style-system.config.yaml';
const EXCLUDED = new Set([
  'node_modules',
  '.git',
  '.tmp',
  '.cache',
  '.nx',
  '.nx-cache',
  'dist',
  'build',
  'generated',
  'coverage',
  'templates',
]);
const MAX_STORIES = 5000;
const MAX_CONFIGS = 512;

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/') || '.';
}

export class StyleSystemCatalogService {
  private readonly loader = new StyleSystemConfigLoader();
  private pending?: Promise<StyleSystemCatalogView>;

  constructor(private readonly workspaceRoot: string) {}

  read(request: StyleSystemCatalogRequest = {}): Promise<StyleSystemCatalogView> {
    if (request.refresh) {
      this.loader.invalidate();
      resetStyleSystemConfigCache();
      this.pending = undefined;
    }
    if (this.pending === undefined) {
      const pending = this.scan();
      this.pending = pending;
      void pending.catch(() => {
        if (this.pending === pending) this.pending = undefined;
      });
    }
    return this.pending;
  }

  private async scan(): Promise<StyleSystemCatalogView> {
    const root = await fs.realpath(this.workspaceRoot);
    const catalog: StyleSystemCatalogView = { projects: [], components: [], diagnostics: [], truncated: false };
    const configs: string[] = [];
    const stories: string[] = [];
    const diagnostic = (file: string, reason: unknown): void => {
      if (catalog.diagnostics.length < 100)
        catalog.diagnostics.push({
          path: relative(root, file),
          message: (reason instanceof Error ? reason.message : String(reason)).split(root).join('.'),
        });
    };
    const walk = async (directory: string): Promise<void> => {
      if (!contained(root, await fs.realpath(directory))) {
        diagnostic(directory, 'Directory escapes the workspace.');
        return;
      }
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && !EXCLUDED.has(entry.name)) {
            try {
              await walk(file);
            } catch (reason) {
              diagnostic(file, reason);
            }
          }
        } else if (entry.isFile() && (entry.name === CONFIG_FILE || /\.stories\.(?:ts|tsx)$/u.test(entry.name))) {
          const canonical = await fs.realpath(file);
          if (!contained(root, canonical)) {
            diagnostic(file, 'File escapes the workspace.');
            continue;
          }
          if ((await fs.stat(canonical)).size > 1024 * 1024) {
            diagnostic(file, 'Metadata file exceeds the 1 MiB discovery limit.');
            catalog.truncated = true;
            continue;
          }
          if (entry.name === CONFIG_FILE) {
            if (configs.length < MAX_CONFIGS) configs.push(canonical);
            else catalog.truncated = true;
          } else if (stories.length < MAX_STORIES) stories.push(canonical);
          else catalog.truncated = true;
        }
      }
    };
    await walk(root);
    let sharedTags = ['style-system'];
    for (const file of configs) {
      const appPath = relative(root, path.dirname(file));
      const project: StyleSystemCatalogProject = {
        appPath,
        configPath: relative(root, file),
        settings: {},
        provenance: { presets: [] },
      };
      // The public loader parses YAML and validates root:true; no second YAML parser or syntax guesses.
      const workspace = await this.loader.loadRoot(path.dirname(file)).catch(() => undefined);
      if (workspace !== undefined) {
        if (path.dirname(file) === root) {
          sharedTags = workspace.sharedComponentTags ?? sharedTags;
          catalog.workspace = {
            configPath: relative(root, file),
            settings: { ...workspace },
            sharedComponentTags: sharedTags,
          };
        }
        continue;
      }
      try {
        const resolved = await this.loader.resolveProject(path.dirname(file));
        project.settings = { ...resolved.config };
        project.provenance = { presets: resolved.appliedPresets, projectConfigPath: relative(root, file) };
        project.preset = resolved.appliedPresets.at(-1);
        project.bundler = resolved.config.bundler;
      } catch (reason) {
        project.error = (reason instanceof Error ? reason.message : String(reason)).split(root).join('.');
        diagnostic(file, reason);
      }
      catalog.projects.push(project);
    }
    // ponytail: bounded metadata index, explicit refresh replaces watchers; add server paging if repositories exceed this ceiling.
    const index = new StoriesIndexService({
      workspaceRoot: root,
      storyFiles: stories,
      searchRoots: [],
      concurrency: 4,
    });
    const result = await index.initialize();
    for (const failure of result.failures) diagnostic(failure.filePath, failure.error);
    const projects = [...catalog.projects].sort((a, b) => b.appPath.length - a.appPath.length);
    for (const component of index.getAllComponents()) {
      const canonical = await fs.realpath(component.filePath);
      if (!contained(root, canonical)) {
        diagnostic(component.filePath, 'Story escapes the workspace.');
        continue;
      }
      const project = projects.find((candidate) => contained(path.resolve(root, candidate.appPath), canonical));
      catalog.components.push({
        storyPath: relative(root, canonical),
        title: component.title,
        tags: component.tags,
        exports: component.storyExports.map((exportName, offset) => ({ exportName, label: component.stories[offset] })),
        projectPath: project?.appPath,
        shared: component.tags.some((tag) => sharedTags.includes(tag)),
      });
    }
    catalog.components.sort((a, b) => a.title.localeCompare(b.title) || a.storyPath.localeCompare(b.storyPath));
    return catalog;
  }
}
