import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export async function readPackageResource(name: string): Promise<string> {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(directory, 'package.json'))) {
    const parent = path.dirname(directory);
    if (parent === directory) return `(resource unavailable: ${name})`;
    directory = parent;
  }
  try {
    return await readFile(path.join(directory, name), 'utf8');
  } catch {
    return `(resource unavailable: ${name})`;
  }
}
