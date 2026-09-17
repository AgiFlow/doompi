import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  ComponentRendererService,
  createDefaultBundlerService,
  getAppDesignSystemConfig,
  StoriesIndexService,
  type BaseBundlerService,
  type DesignSystemConfig,
} from '@agimon-ai/style-system';

import type {
  StoryPreviewBuildInput,
  StoryPreviewBuildResult,
  StoryPreviewImageResult,
  StoryPreviewServiceDependencies,
} from './type';

const STORY_FILE_PATTERN = /\.stories\.(?:ts|tsx)$/;
const STORY_EXPORT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

interface OwnedArtifact {
  directory: string;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

const defaultDependencies: StoryPreviewServiceDependencies = {
  loadConfig: getAppDesignSystemConfig,
  createBundler(_config: DesignSystemConfig): BaseBundlerService {
    return createDefaultBundlerService();
  },
  createHandle: randomUUID,
};

/** Owns disposable static story-preview artifacts for one trusted workspace. */
export class StoryPreviewService {
  private readonly root: string;
  private readonly dependencies: StoryPreviewServiceDependencies;
  private readonly artifacts = new Map<string, OwnedArtifact>();

  constructor(workspaceRoot: string, dependencies: StoryPreviewServiceDependencies = defaultDependencies) {
    this.root = path.resolve(workspaceRoot);
    this.dependencies = dependencies;
  }

  private async exactStory(root: string, storyPath: string, storyExport: string) {
    const index = new StoriesIndexService({ workspaceRoot: root, storyFiles: [storyPath], searchRoots: [] });
    await index.initialize();
    const component = index.getAllComponents().find((entry) => path.resolve(entry.filePath) === storyPath);
    if (component === undefined) throw new Error('The requested story file could not be indexed.');
    if (!component.stories.includes(storyExport)) {
      throw new Error(`Story export "${storyExport}" was not found in ${path.relative(root, storyPath)}.`);
    }
    return component;
  }

  async build(input: StoryPreviewBuildInput): Promise<StoryPreviewBuildResult> {
    if (!STORY_EXPORT_PATTERN.test(input.storyExport)) {
      throw new Error('storyExport must be an exact JavaScript named export');
    }

    const root = await fs.realpath(this.root);
    const appPath = await this.resolveContainedPath(root, input.appPath, 'appPath');
    const storyPath = await this.resolveContainedPath(root, input.storyPath, 'storyPath');
    if (!STORY_FILE_PATTERN.test(storyPath)) throw new Error('storyPath must name a .stories.ts or .stories.tsx file');
    await this.exactStory(root, storyPath, input.storyExport);

    const [source, config] = await Promise.all([fs.readFile(storyPath, 'utf8'), this.dependencies.loadConfig(appPath)]);
    const bundler = this.dependencies.createBundler(config);
    const rendered = await bundler.prerenderComponent({
      componentPath: storyPath,
      storyName: input.storyExport,
      args: input.args,
      darkMode: input.darkMode,
      appPath,
      themePath: config.themeProvider,
      cssFiles: config.cssFiles,
      rootComponent: config.rootComponent,
      unistylesConfig: config.unistylesConfig,
    });

    const htmlPath = await fs.realpath(rendered.htmlFilePath);
    const artifactDirectory = path.dirname(htmlPath);
    const temporaryRoot = path.join(appPath, '.tmp');
    if (!isContained(temporaryRoot, artifactDirectory)) {
      throw new Error('Style-system returned a preview artifact outside the project temporary directory');
    }

    const handle = this.dependencies.createHandle();
    const html = await fs.readFile(htmlPath, 'utf8');
    this.artifacts.set(handle, { directory: artifactDirectory });
    return {
      handle,
      html,
      storyPath: path.relative(root, storyPath),
      storyExport: input.storyExport,
      sourceSha256: createHash('sha256').update(source).digest('hex'),
    };
  }

  /** Renders a fresh source-backed PNG. This does not preserve transient iframe interaction state. */
  async exportImage(input: StoryPreviewBuildInput): Promise<StoryPreviewImageResult> {
    if (!STORY_EXPORT_PATTERN.test(input.storyExport)) {
      throw new Error('storyExport must be an exact JavaScript named export');
    }
    const root = await fs.realpath(this.root);
    const appPath = await this.resolveContainedPath(root, input.appPath, 'appPath');
    const storyPath = await this.resolveContainedPath(root, input.storyPath, 'storyPath');
    if (!STORY_FILE_PATTERN.test(storyPath)) throw new Error('storyPath must name a .stories.ts or .stories.tsx file');

    const [source, config] = await Promise.all([fs.readFile(storyPath, 'utf8'), this.dependencies.loadConfig(appPath)]);
    const renderer = new ComponentRendererService(config, appPath);
    let imagePath: string | undefined;
    try {
      const component = await this.exactStory(root, storyPath, input.storyExport);
      const rendered = await renderer.renderComponent(component, {
        storyName: input.storyExport,
        darkMode: input.darkMode,
      });
      imagePath = await fs.realpath(rendered.imagePath);
      const image = await fs.readFile(imagePath);
      return {
        data: image.toString('base64'),
        mimeType: 'image/png',
        storyPath: path.relative(root, storyPath),
        storyExport: input.storyExport,
        sourceSha256: createHash('sha256').update(source).digest('hex'),
      };
    } finally {
      try {
        if (imagePath !== undefined) await fs.rm(imagePath, { force: true });
      } finally {
        await renderer.dispose();
      }
    }
  }

  async dispose(handle: string): Promise<boolean> {
    const artifact = this.artifacts.get(handle);
    if (artifact === undefined) return false;
    this.artifacts.delete(handle);
    await fs.rm(artifact.directory, { recursive: true, force: true });
    return true;
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.artifacts.keys()].map((handle) => this.dispose(handle)));
  }

  private async resolveContainedPath(root: string, inputPath: string, field: string): Promise<string> {
    if (inputPath.trim() === '') throw new Error(`${field} is required`);
    const candidate = path.isAbsolute(inputPath) ? inputPath : path.resolve(root, inputPath);
    const canonical = await fs.realpath(candidate);
    if (!isContained(root, canonical)) throw new Error(`${field} must remain inside the workspace root`);
    return canonical;
  }
}

export type {
  StoryPreviewBuildInput,
  StoryPreviewBuildResult,
  StoryPreviewImageResult,
  StoryPreviewServiceDependencies,
} from './type';
