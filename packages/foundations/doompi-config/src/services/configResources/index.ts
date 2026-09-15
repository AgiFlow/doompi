import { readFile } from 'node:fs/promises';

const PACKAGE_ROOT = new URL('../../../', import.meta.url);

export function selectionMetadata(execution: {
  readonly selection: {
    readonly profile?: string;
    readonly domains: readonly string[];
    readonly majorMode: string;
    readonly activeLayers: readonly string[];
  };
}): string {
  return JSON.stringify({
    profile: execution.selection.profile ?? null,
    domains: execution.selection.domains,
    majorMode: execution.selection.majorMode,
    activeLayers: execution.selection.activeLayers,
  });
}

export async function readPackageResource(name: string): Promise<string> {
  try {
    return await readFile(new URL(name, PACKAGE_ROOT), 'utf8');
  } catch {
    return `(resource unavailable: ${name})`;
  }
}
