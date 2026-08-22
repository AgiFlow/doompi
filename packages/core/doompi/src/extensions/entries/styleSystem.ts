import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import { DOOM_CONFIG_SERVICE } from '@agimon-ai/doompi-extension-contracts/config';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ToolResultEvent } from '@earendil-works/pi-coding-agent';
import {
  createHarnessTelemetry,
  HARNESS_EVENT,
  type HarnessTelemetry,
} from '../../adapters/telemetry/logSinkTelemetry.ts';

interface StoryRenderRequest {
  storyPath: string;
  projectPath: string;
  componentName: string;
  storyName: string;
}

interface StyleSystemResult {
  imagePath?: string;
  storyFilePath?: string;
  componentTitle?: string;
  renderedStory?: string;
  colorScheme?: string;
  viewport?: { width: number; height: number };
  dimensions?: string;
}

const STYLE_SYSTEM_PACKAGE = 'style-system';
const STYLE_SYSTEM_CONFIG_FILE = `${STYLE_SYSTEM_PACKAGE}.config.yaml`;
const DEFAULT_STORY_NAME = 'Playground';
const STORY_FILE_PATTERN = /\.stories\.(?:ts|tsx)$/;
const EXPORT_STORY_PATTERN = /export\s+const\s+([A-Z][A-Za-z0-9_]*)\b/g;
const TOOL_TIMEOUT_MS = 120_000;
const PACKAGE_SOURCE = '@agimon-ai/doompi/style-system';

export function eventPath(event: ToolResultEvent, cwd: string): string | undefined {
  if (event.isError || (event.toolName !== 'write' && event.toolName !== 'edit')) return undefined;
  const input = event.input as { path?: unknown };
  if (typeof input.path !== 'string' || !STORY_FILE_PATTERN.test(input.path)) return undefined;
  return path.resolve(cwd, input.path);
}

function findStyleSystemProject(startFile: string, root: string): string | undefined {
  let directory = path.dirname(startFile);
  const resolvedRoot = path.resolve(root);
  while (directory.startsWith(resolvedRoot)) {
    if (fs.existsSync(path.join(directory, STYLE_SYSTEM_CONFIG_FILE))) {
      return path.relative(resolvedRoot, directory) || '.';
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function inferComponentName(storyPath: string, content: string): string {
  const title = content.match(/title\s*:\s*['"]([^'"]+)['"]/)?.[1]?.trim();
  if (title) return title;
  return path.basename(storyPath).replace(/\.stories\.(?:ts|tsx)$/, '');
}

function inferStoryName(content: string): string {
  if (/export\s+const\s+Playground\b/.test(content)) return DEFAULT_STORY_NAME;
  const firstExportedStory = EXPORT_STORY_PATTERN.exec(content)?.[1];
  EXPORT_STORY_PATTERN.lastIndex = 0;
  return firstExportedStory ?? DEFAULT_STORY_NAME;
}

export function inferStoryRenderRequest(storyPath: string, root: string): StoryRenderRequest | undefined {
  if (!STORY_FILE_PATTERN.test(storyPath) || !fs.existsSync(storyPath)) return undefined;
  const projectPath = findStyleSystemProject(storyPath, root);
  if (!projectPath) return undefined;
  const content = fs.readFileSync(storyPath, 'utf8');
  return {
    storyPath,
    projectPath,
    componentName: inferComponentName(storyPath, content),
    storyName: inferStoryName(content),
  };
}

export function parseStyleSystemOutput(stdout: string): StyleSystemResult {
  const text = stdout.trim();
  if (!text) throw new Error(`${STYLE_SYSTEM_PACKAGE} returned no output`);
  return JSON.parse(text) as StyleSystemResult;
}

/* v8 ignore next 57 */
async function runStyleSystem(request: StoryRenderRequest, root: string): Promise<StyleSystemResult> {
  const args = [
    'exec',
    STYLE_SYSTEM_PACKAGE,
    'get-ui-component',
    '--component-name',
    request.componentName,
    '--app-path',
    request.projectPath,
    '--story-name',
    request.storyName,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', args, {
      cwd: root,
      env: { ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? 'info' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), TOOL_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${STYLE_SYSTEM_PACKAGE} exited with code ${code ?? 'unknown'}`));
        return;
      }
      try {
        resolve(parseStyleSystemOutput(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function copyImageToHarnessTemp(
  imagePath: string,
  request: StoryRenderRequest,
  outputDirectory: string = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-harness-style-system-')),
): Promise<string> {
  const targetDirectory = path.join(outputDirectory, `${STYLE_SYSTEM_PACKAGE}-visuals`);
  await fs.promises.mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  const baseName = path
    .basename(request.storyPath)
    .replace(/[^a-zA-Z0-9.-]/g, '-')
    .replace(/\.stories\./, '.');
  const targetPath = path.join(targetDirectory, `${Date.now()}-${baseName}.png`);
  await fs.promises.copyFile(imagePath, targetPath);
  await fs.promises.chmod(targetPath, 0o600);
  return targetPath;
}

export function successMessage(
  request: StoryRenderRequest,
  result: StyleSystemResult,
  copiedImagePath: string,
): string {
  const details = [
    `Image path: ${copiedImagePath}`,
    `Story file: ${result.storyFilePath ?? request.storyPath}`,
    `Component: ${result.componentTitle ?? request.componentName}`,
    `Story: ${result.renderedStory ?? request.storyName}`,
    result.colorScheme ? `Color scheme: ${result.colorScheme}` : undefined,
    result.dimensions ? `Dimensions: ${result.dimensions}` : undefined,
  ].filter((line): line is string => Boolean(line));

  return [
    'Style-system visual generated for the story you just changed.',
    ...details,
    'The image is saved and ready to inspect: call the read tool on the image path above to view it.',
    'If the layout, spacing, color, overflow, or hierarchy looks wrong, adjust the UI and story, then let this hook render it again.',
  ].join('\n');
}

export function failureMessage(request: StoryRenderRequest, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    `Your file change was applied, but ${STYLE_SYSTEM_PACKAGE} could not generate a visual for it.`,
    `Story file: ${request.storyPath}`,
    `Command: pnpm exec ${STYLE_SYSTEM_PACKAGE} get-ui-component --component-name ${JSON.stringify(request.componentName)} --app-path ${JSON.stringify(request.projectPath)} --story-name ${JSON.stringify(request.storyName)}`,
    `Error: ${message}`,
    'Do not treat the UI as visually verified. Run the command above to investigate.',
  ].join('\n');
}

/* v8 ignore next 23 */
// Pi's extension loader resolves this default export and rejects the module
// without it ("Extension does not export a valid factory function"). This must
// stay a default export; see the pi-extension override in vibe-lint.config.yaml.
export function registerStyleSystemVisuals(
  pi: ExtensionAPI,
  telemetry: HarnessTelemetry = createHarnessTelemetry(),
  cordisContext: () => Context,
): void {
  pi.on('tool_result', async (event, ctx) => {
    const changedPath = eventPath(event, ctx.cwd);
    if (!changedPath) return undefined;

    const harness = requireDoomConfigContext(cordisContext()).harness;
    const root = harness.root ?? ctx.cwd;
    const request = inferStoryRenderRequest(changedPath, root);
    if (!request) return undefined;
    const statusKey = `style-system:${event.toolCallId}`;
    if (ctx.hasUI) ctx.ui.setStatus(statusKey, `Rendering ${request.componentName} visual...`);

    try {
      const result = await runStyleSystem(request, root);
      if (!result.imagePath) throw new Error(`${STYLE_SYSTEM_PACKAGE} did not return an imagePath`);
      const copiedImagePath = await copyImageToHarnessTemp(
        result.imagePath,
        request,
        harness.temporaryDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'agent-harness-style-system-')),
      );
      return {
        content: [...event.content, { type: 'text' as const, text: successMessage(request, result, copiedImagePath) }],
      };
    } catch (error) {
      void telemetry.recordWarning(HARNESS_EVENT.styleSystemRenderFailed, error, {
        'style_system.component': request.componentName,
      });
      // The tool itself succeeded; only this hook failed. Surface the reason without
      // reporting the write as failed, which would invite a retry of a change that landed.
      return {
        content: [...event.content, { type: 'text' as const, text: failureMessage(request, error) }],
      };
    } finally {
      if (ctx.hasUI) ctx.ui.setStatus(statusKey, undefined);
    }
  });
}

interface StyleSystemPluginConfig {
  readonly pi: ExtensionAPI;
  readonly telemetry: HarnessTelemetry;
}

function styleSystemPlugin(cordis: Context, { pi, telemetry }: StyleSystemPluginConfig): void {
  let activeContext: Context | undefined;
  cordis.inject([DOOM_CONFIG_SERVICE], (context) => {
    activeContext = context;
    return () => {
      if (activeContext === context) activeContext = undefined;
    };
  });
  registerStyleSystemVisuals(pi, telemetry, () => {
    if (!activeContext) throw new Error('Doom style-system runtime is waiting for the session config service.');
    return activeContext;
  });
}

export default async function styleSystemVisuals(
  pi: ExtensionAPI,
  telemetry: HarnessTelemetry = createHarnessTelemetry(),
): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(styleSystemPlugin, { pi, telemetry });
  try {
    await fiber;
  } catch (error) {
    await fiber.dispose();
    await connection.dispose();
    throw error;
  }
  let disposal: Promise<void> | undefined;
  pi.on(
    'session_shutdown',
    () =>
      (disposal ??= (async () => {
        try {
          await fiber.dispose();
        } finally {
          await connection.dispose();
        }
      })()),
  );
}
