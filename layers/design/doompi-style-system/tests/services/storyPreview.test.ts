import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { BaseBundlerService, DesignSystemConfig } from '@agimon-ai/style-system';

import { StoryPreviewService, type StoryPreviewRenderer } from '../../src/services/storyPreview';

function config(): DesignSystemConfig {
  return {} as DesignSystemConfig;
}

function png(width = 320, height = 180, size = 24): Buffer {
  const image = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(image);
  image.write('IHDR', 12, 'ascii');
  image.writeUInt32BE(width, 16);
  image.writeUInt32BE(height, 20);
  return image;
}

describe('StoryPreviewService', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-style-preview-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('builds self-contained HTML for an exact story export and owns its artifact', async () => {
    const app = path.join(root, 'app');
    const story = path.join(app, 'Button.stories.tsx');
    const artifact = path.join(app, '.tmp', 'dist-test');
    fs.mkdirSync(artifact, { recursive: true });
    const storySource = "export default { title: 'Button' }; export const Primary = {};";
    fs.writeFileSync(story, storySource);
    const htmlPath = path.join(artifact, 'index.html');
    fs.writeFileSync(htmlPath, '<!doctype html><button>Preview</button>');
    const prerenderComponent = vi.fn().mockResolvedValue({ htmlFilePath: htmlPath });
    const service = new StoryPreviewService(root, {
      loadConfig: async () => config(),
      createBundler: () => ({ prerenderComponent }) as unknown as BaseBundlerService,
      createHandle: () => 'preview-handle',
    });

    const result = await service.build({ appPath: 'app', storyPath: 'app/Button.stories.tsx', storyExport: 'Primary' });

    expect(result).toEqual(
      expect.objectContaining({
        handle: 'preview-handle',
        storyPath: 'app/Button.stories.tsx',
        storyExport: 'Primary',
        sourceSha256: createHash('sha256').update(storySource).digest('hex'),
      }),
    );
    expect(result.html).toContain('<button>Preview</button>');
    expect(prerenderComponent).toHaveBeenCalledWith(
      expect.objectContaining({
        appPath: fs.realpathSync(app),
        componentPath: fs.realpathSync(story),
        storyName: 'Primary',
      }),
    );
    await expect(service.dispose('preview-handle')).resolves.toBe(true);
    expect(fs.existsSync(artifact)).toBe(false);
    await expect(service.dispose('preview-handle')).resolves.toBe(false);
  });

  it('cleans the artifact when handle registration fails', async () => {
    const app = path.join(root, 'app');
    const story = path.join(app, 'Button.stories.tsx');
    const artifact = path.join(app, '.tmp', 'dist-test');
    fs.mkdirSync(artifact, { recursive: true });
    fs.writeFileSync(story, "export default { title: 'Button' }; export const Primary = {};\n");
    const htmlPath = path.join(artifact, 'index.html');
    fs.writeFileSync(htmlPath, '<!doctype html><button>Preview</button>');
    const service = new StoryPreviewService(root, {
      loadConfig: async () => config(),
      createBundler: () =>
        ({
          prerenderComponent: vi.fn().mockResolvedValue({ htmlFilePath: htmlPath }),
        }) as unknown as BaseBundlerService,
      createHandle: () => {
        throw new Error('handle unavailable');
      },
    });

    await expect(
      service.build({ appPath: 'app', storyPath: 'app/Button.stories.tsx', storyExport: 'Primary' }),
    ).rejects.toThrow('handle unavailable');
    expect(fs.existsSync(artifact)).toBe(false);
  });

  it('exports a bounded PNG from the renderer temporary root and cleans up its exact artifact', async () => {
    const app = path.join(root, 'app');
    const story = path.join(app, 'Button.stories.tsx');
    const imageRoot = path.join(root, 'renderer-images');
    const imagePath = path.join(imageRoot, 'button.png');
    fs.mkdirSync(app, { recursive: true });
    fs.mkdirSync(imageRoot, { recursive: true });
    fs.writeFileSync(story, "export default { title: 'Button' }; export const Primary = {};\n");
    fs.writeFileSync(imagePath, png());
    const dispose = vi.fn().mockResolvedValue(undefined);
    const renderComponent = vi.fn().mockResolvedValue({ imagePath, width: 999, height: 999 });
    const service = new StoryPreviewService(root, {
      loadConfig: async () => config(),
      createRenderer: () => ({ renderComponent, dispose }) as unknown as StoryPreviewRenderer,
      rendererTemporaryRoot: () => imageRoot,
      createHandle: () => 'capture-1',
    });

    await expect(
      service.exportImage({ appPath: 'app', storyPath: 'app/Button.stories.tsx', storyExport: 'Primary' }),
    ).resolves.toMatchObject({
      data: png().toString('base64'),
      mimeType: 'image/png',
      captureId: 'capture-1',
      width: 320,
      height: 180,
      storyPath: 'app/Button.stories.tsx',
      storyExport: 'Primary',
    });
    expect(fs.existsSync(imagePath)).toBe(false);
    expect(fs.existsSync(imageRoot)).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects and does not delete a renderer path outside the canonical temporary root', async () => {
    const app = path.join(root, 'app');
    const story = path.join(app, 'Button.stories.tsx');
    const imageRoot = path.join(root, 'renderer-images');
    const outsideImage = path.join(root, 'outside.png');
    const linkedImage = path.join(imageRoot, 'linked.png');
    fs.mkdirSync(app, { recursive: true });
    fs.mkdirSync(imageRoot, { recursive: true });
    fs.writeFileSync(story, "export default { title: 'Button' }; export const Primary = {};\n");
    fs.writeFileSync(outsideImage, png());
    fs.symlinkSync(outsideImage, linkedImage);
    const dispose = vi.fn().mockResolvedValue(undefined);
    const service = new StoryPreviewService(root, {
      loadConfig: async () => config(),
      createRenderer: () =>
        ({
          renderComponent: vi.fn().mockResolvedValue({ imagePath: linkedImage }),
          dispose,
        }) as unknown as StoryPreviewRenderer,
      rendererTemporaryRoot: () => imageRoot,
    });

    await expect(
      service.exportImage({ appPath: 'app', storyPath: 'app/Button.stories.tsx', storyExport: 'Primary' }),
    ).rejects.toThrow('outside its temporary directory');
    expect(fs.existsSync(outsideImage)).toBe(true);
    expect(fs.existsSync(linkedImage)).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects a non-regular artifact without recursively deleting it', async () => {
    const app = path.join(root, 'app');
    const story = path.join(app, 'Button.stories.tsx');
    const imageRoot = path.join(root, 'renderer-images');
    const imageDirectory = path.join(imageRoot, 'not-a-file.png');
    fs.mkdirSync(app, { recursive: true });
    fs.mkdirSync(imageDirectory, { recursive: true });
    fs.writeFileSync(story, "export default { title: 'Button' }; export const Primary = {};\n");
    const dispose = vi.fn().mockResolvedValue(undefined);
    const service = new StoryPreviewService(root, {
      loadConfig: async () => config(),
      createRenderer: () =>
        ({
          renderComponent: vi.fn().mockResolvedValue({ imagePath: imageDirectory }),
          dispose,
        }) as unknown as StoryPreviewRenderer,
      rendererTemporaryRoot: () => imageRoot,
    });

    await expect(
      service.exportImage({ appPath: 'app', storyPath: 'app/Button.stories.tsx', storyExport: 'Primary' }),
    ).rejects.toThrow('non-regular PNG');
    expect(fs.existsSync(imageDirectory)).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects oversized and malformed PNG artifacts, removes regular owned files, and disposes the renderer', async () => {
    const app = path.join(root, 'app');
    const story = path.join(app, 'Button.stories.tsx');
    const imageRoot = path.join(root, 'renderer-images');
    fs.mkdirSync(app, { recursive: true });
    fs.mkdirSync(imageRoot, { recursive: true });
    fs.writeFileSync(story, "export default { title: 'Button' }; export const Primary = {};\n");

    for (const [name, image, error] of [
      ['large.png', png(320, 180, 2 * 1024 * 1024 + 1), 'oversized PNG'],
      ['bad.png', Buffer.from('not png'), 'invalid PNG'],
      ['wide.png', png(1601, 180), 'dimensions outside'],
    ] as const) {
      const imagePath = path.join(imageRoot, name);
      fs.writeFileSync(imagePath, image);
      const dispose = vi.fn().mockResolvedValue(undefined);
      const service = new StoryPreviewService(root, {
        loadConfig: async () => config(),
        createRenderer: () =>
          ({
            renderComponent: vi.fn().mockResolvedValue({ imagePath }),
            dispose,
          }) as unknown as StoryPreviewRenderer,
        rendererTemporaryRoot: () => imageRoot,
      });
      await expect(
        service.exportImage({ appPath: 'app', storyPath: 'app/Button.stories.tsx', storyExport: 'Primary' }),
      ).rejects.toThrow(error);
      expect(fs.existsSync(imagePath)).toBe(false);
      expect(dispose).toHaveBeenCalledOnce();
    }
  });

  it('rejects a valid identifier that is not an exported story', async () => {
    const app = path.join(root, 'app');
    const story = path.join(app, 'Button.stories.tsx');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(story, "export default { title: 'Button' }; export const Primary = {};\n");
    const createBundler = vi.fn();
    const service = new StoryPreviewService(root, {
      loadConfig: async () => config(),
      createBundler,
      createHandle: () => 'unused',
    });

    await expect(
      service.build({ appPath: 'app', storyPath: 'app/Button.stories.tsx', storyExport: 'Secondary' }),
    ).rejects.toThrow('was not found');
    expect(createBundler).not.toHaveBeenCalled();
  });

  it('rejects paths that escape the workspace through a symlink', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-style-outside-'));
    const linked = path.join(root, 'linked');
    fs.symlinkSync(outside, linked, 'dir');
    const service = new StoryPreviewService(root, {
      loadConfig: async () => config(),
      createBundler: () => ({}) as unknown as BaseBundlerService,
      createHandle: () => 'unused',
    });

    await expect(
      service.build({ appPath: linked, storyPath: path.join(linked, 'Escape.stories.tsx'), storyExport: 'Primary' }),
    ).rejects.toThrow('appPath must remain inside the workspace root');
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('returns exact metadata concurrently for duplicated story titles', async () => {
    const app = path.join(root, 'app');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(
      path.join(app, 'First.stories.js'),
      "export default { title: 'Shared' }; export const Primary = { name: 'First' };",
    );
    fs.writeFileSync(
      path.join(app, 'Second.stories.tsx'),
      "export default { title: 'Shared' }; export const Alternate = {};",
    );
    const service = new StoryPreviewService(root);
    const [first, second] = await Promise.all([
      service.metadata({ storyPath: 'app/First.stories.js' }),
      service.metadata({ storyPath: 'app/Second.stories.tsx' }),
    ]);

    expect(first).toMatchObject({
      storyPath: 'app/First.stories.js',
      appPath: '.',
      exports: [{ exportName: 'Primary', label: 'First' }],
    });
    expect(second).toMatchObject({
      storyPath: 'app/Second.stories.tsx',
      exports: [{ exportName: 'Alternate' }],
    });
  });

  it('rejects invalid story exports before executing workspace code', async () => {
    const service = new StoryPreviewService(root);
    await expect(
      service.build({ appPath: '.', storyPath: 'Story.stories.tsx', storyExport: 'Primary;alert(1)' }),
    ).rejects.toThrow('storyExport must be an exact JavaScript named export');
  });
});
