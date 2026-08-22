import path from 'node:path';
import {
  createDisabledDoomMcpProjection,
  type DoomMcpProjection,
} from '@agimon-ai/doompi-extension-contracts/mcp-projection';

/** Minimal valid projection for persisted-state tests that do not exercise MCP discovery. */
export function testMcpProjection(
  repoRoot: string,
  stagingDirectory = path.join(repoRoot, '.mcp-staging'),
): DoomMcpProjection {
  return createDisabledDoomMcpProjection({ repoRoot, stagingDirectory });
}
