import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ComponentRendererService,
  createDefaultBundlerService,
  getAppDesignSystemConfig,
  StoriesIndexService,
  type BaseBundlerService,
  type DesignSystemConfig,
} from '@agimon-ai/style-system';

import type { StoryPreviewExport, StoryPreviewMetadataRequest, StoryPreviewMetadataView } from '../../types/previewApi';
import type {
  StoryPreviewBuildInput,
  StoryPreviewBuildResult,
  StoryPreviewImageResult,
  StoryPreviewServiceDependencies,
} from './type';

const STORY_FILE_PATTERN = /\.stories\.(?:js|jsx|ts|tsx)$/u;
const STORY_EXPORT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1600;
const NON_STORY_EXPORTS = new Set([
  'afterAll',
  'afterEach',
  'argTypes',
  'beforeAll',
  'beforeEach',
  'component',
  'decorators',
  'excludeStories',
  'globals',
  'includeStories',
  'loaders',
  'meta',
  'parameters',
  'render',
  'tags',
]);

interface OwnedArtifact {
  directory: string;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function stripComments(source: string): string {
  let output = '';
  let quote: "'" | '"' | '`' | undefined;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote !== undefined) {
      output += character === '\n' ? '\n' : ' ';
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      output += ' ';
    } else if (character === '/' && next === '/') {
      output += '  ';
      index += 2;
      while (index < source.length && source[index] !== '\n') {
        output += ' ';
        index += 1;
      }
      if (index < source.length) output += '\n';
    } else if (character === '/' && next === '*') {
      output += '  ';
      index += 2;
      while (index < source.length && !(source[index - 1] === '*' && source[index] === '/')) {
        output += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
    } else output += character;
  }
  return output;
}

function storyLabel(source: string, clean: string, exportName: string): string | undefined {
  const escapedExport = exportName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const declaration = new RegExp(`\\bexport\\s+(?:const|let|var)\\s+${escapedExport}\\b[^=]*=\\s*\\{`, 'u');
  const match = clean.match(declaration);
  if (match === null || match.index === undefined) return undefined;
  const opening = clean.indexOf('{', match.index);
  let depth = 0;
  for (let index = opening; index < clean.length; index += 1) {
    if (clean[index] === '{') depth += 1;
    else if (clean[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        const label = source
          .slice(opening, index)
          .match(/\bname\s*:\s*(['"])(.*?)\1/u)?.[2]
          ?.trim();
        return label === '' ? undefined : label;
      }
    }
  }
  return undefined;
}

/** Extracts named CSF candidates without evaluating workspace source. */
export function extractStoryExports(source: string): readonly StoryPreviewExport[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    if (name === 'default' || NON_STORY_EXPORTS.has(name) || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  const clean = stripComments(source);
  const declarations = /\bexport\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gu;
  for (const match of clean.matchAll(declarations)) add(match[1]!);
  const lists = /\bexport\s*\{([^}]*)\}/gu;
  for (const match of clean.matchAll(lists)) {
    for (const item of match[1]!.split(',')) {
      const parts = item.trim().split(/\s+as\s+/u);
      const name = (parts.at(-1) ?? '').trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name)) add(name);
    }
  }
  return names.map((exportName) => {
    const label = storyLabel(source, clean, exportName);
    return label === undefined ? { exportName } : { exportName, label };
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function relativeWorkspacePath(root: string, candidate: string): string {
  const relative = path.relative(root, candidate).split(path.sep).join('/');
  return relative === '' ? '.' : relative;
}

const defaultDependencies: StoryPreviewServiceDependencies = {
  loadConfig: getAppDesignSystemConfig,
  createBundler(_config: DesignSystemConfig): BaseBundlerService {
    return createDefaultBundlerService();
  },
  createRenderer(config, appPath) {
    return new ComponentRendererService(config, appPath);
  },
  rendererTemporaryRoot: () => path.join(os.tmpdir(), 'style-system'),
  createHandle: randomUUID,
};

function pngCrc(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngDimensions(image: Buffer): { width: number; height: number } {
  if (image.length < PNG_SIGNATURE.length || !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('Style-system returned an invalid PNG image');
  }
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let chunks = 0;
  let hasImageData = false;
  let hasEnd = false;
  while (offset < image.length) {
    if (image.length - offset < 12) throw new Error('Style-system returned an invalid PNG image');
    const length = image.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > image.length) throw new Error('Style-system returned an invalid PNG image');
    const type = image.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/u.test(type)) throw new Error('Style-system returned an invalid PNG image');
    if (image.readUInt32BE(end - 4) !== pngCrc(image.subarray(offset + 4, end - 4))) {
      throw new Error('Style-system returned an invalid PNG image');
    }
    if (chunks === 0) {
      if (type !== 'IHDR' || length !== 13) throw new Error('Style-system returned an invalid PNG image');
      width = image.readUInt32BE(offset + 8);
      height = image.readUInt32BE(offset + 12);
    } else if (type === 'IHDR') throw new Error('Style-system returned an invalid PNG image');
    if (type === 'IDAT') hasImageData = true;
    if (type === 'IEND') {
      if (length !== 0 || end !== image.length) throw new Error('Style-system returned an invalid PNG image');
      hasEnd = true;
    }
    chunks += 1;
    offset = end;
  }
  if (!hasImageData || !hasEnd) throw new Error('Style-system returned an invalid PNG image');
  if (width === 0 || height === 0 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new Error('Style-system returned PNG dimensions outside the supported range');
  }
  return { width, height };
}

/** Owns disposable static story-preview artifacts for one trusted workspace. */
export class StoryPreviewService {
  private readonly root: string;
  private readonly dependencies: StoryPreviewServiceDependencies;
  private readonly artifacts = new Map<string, OwnedArtifact>();

  constructor(workspaceRoot: string, dependencies: Partial<StoryPreviewServiceDependencies> = {}) {
    this.root = path.resolve(workspaceRoot);
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  async metadata(input: StoryPreviewMetadataRequest): Promise<StoryPreviewMetadataView> {
    const root = await fs.realpath(this.root);
    const storyPath = await this.resolveContainedPath(root, input.storyPath, 'storyPath');
    if (!STORY_FILE_PATTERN.test(storyPath))
      throw new Error('storyPath must name a .stories.js, .stories.jsx, .stories.ts, or .stories.tsx file');
    const project = await this.resolveProject(root, storyPath, input.appPath);
    const source = await fs.readFile(storyPath, 'utf8');
    return {
      storyPath: relativeWorkspacePath(root, storyPath),
      appPath: relativeWorkspacePath(root, project.path),
      projectResolution: project.resolution,
      exports: extractStoryExports(source),
    };
  }

  private async resolveProject(
    root: string,
    storyPath: string,
    requestedPath: string | undefined,
  ): Promise<{ path: string; resolution: StoryPreviewMetadataView['projectResolution'] }> {
    if (requestedPath !== undefined && requestedPath.trim() !== '') {
      return { path: await this.resolveContainedPath(root, requestedPath, 'appPath'), resolution: 'explicit' };
    }
    let directory = path.dirname(storyPath);
    let packagePath: string | undefined;
    while (isContained(root, directory)) {
      if (await exists(path.join(directory, 'style-system.config.yaml'))) {
        return { path: directory, resolution: 'config' };
      }
      if (packagePath === undefined && (await exists(path.join(directory, 'package.json')))) packagePath = directory;
      if (directory === root) break;
      directory = path.dirname(directory);
    }
    return packagePath === undefined
      ? { path: root, resolution: 'workspace' }
      : { path: packagePath, resolution: 'package' };
  }

  private async exactStory(root: string, storyPath: string, storyExport: string) {
    const source = await fs.readFile(storyPath, 'utf8');
    if (!extractStoryExports(source).some((entry) => entry.exportName === storyExport)) {
      throw new Error(`Story export "${storyExport}" was not found in ${relativeWorkspacePath(root, storyPath)}.`);
    }
    const index = new StoriesIndexService({ workspaceRoot: root, storyFiles: [storyPath], searchRoots: [] });
    await index.initialize();
    const component = index.getAllComponents().find((entry) => path.resolve(entry.filePath) === storyPath);
    if (component === undefined) throw new Error('The requested story file could not be indexed.');
    return component;
  }

  async build(input: StoryPreviewBuildInput): Promise<StoryPreviewBuildResult> {
    if (!STORY_EXPORT_PATTERN.test(input.storyExport)) {
      throw new Error('storyExport must be an exact JavaScript named export');
    }

    const root = await fs.realpath(this.root);
    const appPath = await this.resolveContainedPath(root, input.appPath, 'appPath');
    const storyPath = await this.resolveContainedPath(root, input.storyPath, 'storyPath');
    if (!STORY_FILE_PATTERN.test(storyPath))
      throw new Error('storyPath must name a .stories.js, .stories.jsx, .stories.ts, or .stories.tsx file');
    await this.exactStory(root, storyPath, input.storyExport);

    const [source, config] = await Promise.all([fs.readFile(storyPath, 'utf8'), this.dependencies.loadConfig(appPath)]);
    const bundler = this.dependencies.createBundler(config);
    let artifactDirectory: string | undefined;
    try {
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
      const candidateDirectory = path.dirname(htmlPath);
      const temporaryRoot = path.join(appPath, '.tmp');
      if (candidateDirectory === temporaryRoot || !isContained(temporaryRoot, candidateDirectory)) {
        throw new Error('Style-system returned a preview artifact outside the project temporary directory');
      }
      artifactDirectory = candidateDirectory;

      const handle = this.dependencies.createHandle();
      const html = await fs.readFile(htmlPath, 'utf8');
      this.artifacts.set(handle, { directory: artifactDirectory });
      return {
        handle,
        html,
        storyPath: relativeWorkspacePath(root, storyPath),
        storyExport: input.storyExport,
        sourceSha256: createHash('sha256').update(source).digest('hex'),
      };
    } catch (reason) {
      if (artifactDirectory !== undefined) await fs.rm(artifactDirectory, { recursive: true, force: true });
      throw reason;
    }
  }

  /** Renders a fresh source-backed PNG. This does not preserve transient iframe interaction state. */
  async exportImage(input: StoryPreviewBuildInput): Promise<StoryPreviewImageResult> {
    if (!STORY_EXPORT_PATTERN.test(input.storyExport)) {
      throw new Error('storyExport must be an exact JavaScript named export');
    }
    const root = await fs.realpath(this.root);
    const appPath = await this.resolveContainedPath(root, input.appPath, 'appPath');
    const storyPath = await this.resolveContainedPath(root, input.storyPath, 'storyPath');
    if (!STORY_FILE_PATTERN.test(storyPath))
      throw new Error('storyPath must name a .stories.js, .stories.jsx, .stories.ts, or .stories.tsx file');

    const [source, config] = await Promise.all([fs.readFile(storyPath, 'utf8'), this.dependencies.loadConfig(appPath)]);
    const renderer = this.dependencies.createRenderer(config, appPath);
    let ownedImagePath: string | undefined;
    try {
      const component = await this.exactStory(root, storyPath, input.storyExport);
      const rendered = await renderer.renderComponent(component, {
        storyName: input.storyExport,
        darkMode: input.darkMode,
      });
      const [renderedImagePath, imageRoot] = await Promise.all([
        fs.realpath(rendered.imagePath),
        fs.realpath(this.dependencies.rendererTemporaryRoot()),
      ]);
      if (renderedImagePath === imageRoot || !isContained(imageRoot, renderedImagePath)) {
        throw new Error('Style-system returned an image artifact outside its temporary directory');
      }
      const imageStat = await fs.stat(renderedImagePath);
      if (!imageStat.isFile()) throw new Error('Style-system returned a non-regular PNG image');
      ownedImagePath = renderedImagePath;
      if (imageStat.size > MAX_IMAGE_BYTES) throw new Error('Style-system returned an oversized PNG image');
      const image = await fs.readFile(renderedImagePath);
      if (image.length !== imageStat.size) throw new Error('Style-system PNG changed while it was being read');
      const { width, height } = pngDimensions(image);
      return {
        data: image.toString('base64'),
        mimeType: 'image/png',
        captureId: this.dependencies.createHandle(),
        width,
        height,
        storyPath: relativeWorkspacePath(root, storyPath),
        storyExport: input.storyExport,
        sourceSha256: createHash('sha256').update(source).digest('hex'),
      };
    } finally {
      try {
        if (ownedImagePath !== undefined) await fs.rm(ownedImagePath, { force: true });
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
  StoryPreviewRenderer,
  StoryPreviewServiceDependencies,
} from './type';
