import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const PACKAGE_MANIFEST_PATH = fileURLToPath(new URL('../package.json', import.meta.url));

describe('package MCP configuration', () => {
  it('keeps architectural review outside the MCP proxy dependency boundary', () => {
    const manifest = JSON.parse(fs.readFileSync(PACKAGE_MANIFEST_PATH, 'utf8')) as PackageManifest;
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    };

    expect(dependencies).toHaveProperty('@agimon-ai/mcp-proxy', '0.31.20');
    expect(dependencies).not.toHaveProperty('@agiflowai/architect-mcp');
    expect(dependencies).not.toHaveProperty('@agimon-ai/vibe-lint');
  });
});
