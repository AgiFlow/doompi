import { persistMcpConfig } from '@agimon-ai/doompi-domain/mcp';
import type { HarnessContext } from '../adapters/harnessContext';
import type { HarnessOptions } from '../types/interfaces/harness';
import { BaseCommand } from './baseCommand.ts';

/**
 * Writes the resolved MCP config to a directory and exits.
 *
 * Lets claude.sh and codex.sh reuse the same domain-scoped MCP surface instead
 * of reimplementing the filter in shell.
 */
export class EmitMcpCommand extends BaseCommand {
  readonly name = 'emit-mcp';

  matches(options: HarnessOptions): boolean {
    return Boolean(options.emitMcp);
  }

  async execute(context: HarnessContext): Promise<number> {
    const { options, resources } = context;
    if (!options.emitMcp) throw new Error('--emit-mcp requires a target directory');
    if (!resources.mcpConfigPath) throw new Error('--emit-mcp requires MCP to be enabled');

    const emitted = await persistMcpConfig(resources.mcpConfigPath, resources.temporaryDirectory, options.emitMcp);
    process.stdout.write(`${emitted}\n`);
    return 0;
  }
}
