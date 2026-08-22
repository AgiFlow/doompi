import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDoomConfigContext, provideDoomConfigContext } from '@agimon-ai/doompi-config';
import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshHarnessState } from '../../src/exports/config/harnessState';
import {
  copyImageToHarnessTemp,
  eventPath,
  failureMessage,
  inferStoryRenderRequest,
  parseStyleSystemOutput,
  successMessage,
  registerStyleSystemVisuals,
} from '../../src/exports/entries/styleSystem';

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    spawn: () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => undefined,
      });
      setImmediate(() => child.emit('error', new Error('spawn failed')));
      return child;
    },
  };
});

describe('style-system pi extension helpers', () => {
  let root: string;
  const previousTempDir = process.env.DOOMPI_TEMP_DIR;
  const previousRoot = process.env.DOOMPI_ROOT;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'style-system-entry-'));
    refreshHarnessState();
  });

  afterEach(() => {
    process.env.DOOMPI_TEMP_DIR = previousTempDir;
    process.env.DOOMPI_ROOT = previousRoot;
    refreshHarnessState();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('infers render arguments from a story in a style-system project', () => {
    const app = path.join(root, 'apps', 'sample-app');
    const stories = path.join(app, 'src', 'components', 'Card');
    fs.mkdirSync(stories, { recursive: true });
    fs.writeFileSync(path.join(app, 'style-system.config.yaml'), 'extends: web-app\n');
    const storyPath = path.join(stories, 'Card.stories.tsx');
    fs.writeFileSync(
      storyPath,
      `const meta = { title: 'Sample/Card' };
export default meta;
export const Playground = {};
`,
    );

    expect(inferStoryRenderRequest(storyPath, root)).toEqual({
      storyPath,
      projectPath: 'apps/sample-app',
      componentName: 'Sample/Card',
      storyName: 'Playground',
    });
  });

  it('falls back to filename and first exported story', () => {
    const app = path.join(root, 'packages', 'frontend', 'native-ui');
    const stories = path.join(app, 'src', 'Widget');
    fs.mkdirSync(stories, { recursive: true });
    fs.writeFileSync(path.join(app, 'style-system.config.yaml'), 'extends: native-ui-package\n');
    const storyPath = path.join(stories, 'Widget.stories.tsx');
    fs.writeFileSync(storyPath, 'export default {};\nexport const Default = {};\n');

    expect(inferStoryRenderRequest(storyPath, root)).toMatchObject({
      projectPath: 'packages/frontend/native-ui',
      componentName: 'Widget',
      storyName: 'Default',
    });
  });

  it('skips story files outside style-system projects', () => {
    const stories = path.join(root, 'packages', 'plain', 'src');
    fs.mkdirSync(stories, { recursive: true });
    const storyPath = path.join(stories, 'Plain.stories.tsx');
    fs.writeFileSync(storyPath, 'export const Playground = {};\n');

    expect(inferStoryRenderRequest(storyPath, root)).toBeUndefined();
  });

  it('recognizes successful write and edit story tool results', () => {
    const event = {
      isError: false,
      toolName: 'write',
      input: { path: 'src/Card.stories.tsx' },
    } as unknown as ToolResultEvent;

    expect(eventPath(event, root)).toBe(path.join(root, 'src', 'Card.stories.tsx'));
    expect(eventPath({ ...event, isError: true } as ToolResultEvent, root)).toBeUndefined();
    expect(eventPath({ ...event, toolName: 'read' } as ToolResultEvent, root)).toBeUndefined();
    expect(eventPath({ ...event, input: { path: 'src/Card.tsx' } } as ToolResultEvent, root)).toBeUndefined();
  });

  it('parses style-system JSON output', () => {
    expect(parseStyleSystemOutput('{"imagePath":"/tmp/card.png","renderedStory":"Playground"}\n')).toEqual({
      imagePath: '/tmp/card.png',
      renderedStory: 'Playground',
    });
    expect(() => parseStyleSystemOutput('')).toThrow('style-system returned no output');
  });

  it('copies generated images into the harness temporary directory', async () => {
    process.env.DOOMPI_TEMP_DIR = path.join(root, 'harness-tmp');
    refreshHarnessState();
    const sourceImage = path.join(root, 'source.png');
    fs.writeFileSync(sourceImage, 'png');

    const copied = await copyImageToHarnessTemp(
      sourceImage,
      {
        storyPath: path.join(root, 'apps', 'sample-app', 'src', 'Card.stories.tsx'),
        projectPath: 'apps/sample-app',
        componentName: 'Sample/Card',
        storyName: 'Playground',
      },
      process.env.DOOMPI_TEMP_DIR,
    );

    expect(copied).toContain(path.join(root, 'harness-tmp', 'style-system-visuals'));
    expect(fs.readFileSync(copied, 'utf8')).toBe('png');
    expect(fs.statSync(copied).mode & 0o777).toBe(0o600);
  });

  it('formats success and failure messages for the agent', () => {
    const request = {
      storyPath: '/repo/apps/sample-app/src/Card.stories.tsx',
      projectPath: 'apps/sample-app',
      componentName: 'Sample/Card',
      storyName: 'Playground',
    };

    const success = successMessage(
      request,
      { imagePath: '/tmp/source.png', dimensions: '100x200px' },
      '/tmp/copied.png',
    );
    expect(success).toContain('Image path: /tmp/copied.png');
    // The image is handed over as a path, so the message must tell the agent how to view it.
    expect(success).toContain('read tool on the image path');
    expect(failureMessage(request, new Error('render failed'))).toContain('Error: render failed');
  });

  it('reports a failed hook without marking the tool result as an error', async () => {
    const app = path.join(root, 'apps', 'sample-app');
    const stories = path.join(app, 'src', 'components', 'Card');
    fs.mkdirSync(stories, { recursive: true });
    fs.writeFileSync(path.join(app, 'style-system.config.yaml'), 'extends: web-app\n');
    const storyPath = path.join(stories, 'Card.stories.tsx');
    fs.writeFileSync(storyPath, "export default { title: 'Sample/Card' };\nexport const Playground = {};\n");
    process.env.DOOMPI_ROOT = root;
    refreshHarnessState();

    let handler: ((event: ToolResultEvent, ctx: { cwd: string }) => Promise<unknown>) | undefined;
    const cordis = new Context();
    registerStyleSystemVisuals(
      {
        on: (_event: string, registered: unknown) => {
          handler = registered as typeof handler;
        },
      } as unknown as ExtensionAPI,
      undefined,
      () => cordis,
    );

    const event = {
      isError: false,
      toolName: 'write',
      input: { path: path.relative(root, storyPath) },
      content: [{ type: 'text', text: 'file written' }],
    } as unknown as ToolResultEvent;

    const setStatus = vi.fn();
    const context = {
      cwd: root,
      hasUI: true,
      ui: { setStatus },
      sessionManager: { getBranch: () => [] },
    } as unknown as ExtensionContext;
    provideDoomConfigContext(cordis, createDoomConfigContext(context));
    const result = (await handler?.(event, context)) as
      | { content: Array<{ text: string }>; isError?: boolean }
      | undefined;
    await cordis.fiber.dispose();

    // The write landed; only the visual hook failed, so the tool must not be reported as failed.
    expect(result?.isError).toBeUndefined();
    expect(result?.content.at(-1)?.text).toContain('could not generate a visual');
    expect(setStatus).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^style-system:/),
      'Rendering Sample/Card visual...',
    );
    expect(setStatus).toHaveBeenLastCalledWith(expect.stringMatching(/^style-system:/), undefined);
  });
});
