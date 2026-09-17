import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { BaseBundlerService, DesignSystemConfig } from '@agimon-ai/style-system';

import { StoryPreviewService } from '../../src/services/storyPreview';

function config(): DesignSystemConfig {
  return {} as DesignSystemConfig;
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

  it('rejects invalid story exports before executing workspace code', async () => {
    const service = new StoryPreviewService(root);
    await expect(
      service.build({ appPath: '.', storyPath: 'Story.stories.tsx', storyExport: 'Primary;alert(1)' }),
    ).rejects.toThrow('storyExport must be an exact JavaScript named export');
  });
});
