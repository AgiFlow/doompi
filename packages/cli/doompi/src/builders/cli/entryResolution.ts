import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Distribution entries must resolve relative to doompi, never a dependency's installation. */
export function ownEntry(name: string): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(directory, 'package.json'))) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Cannot locate the Doompi distribution');
    directory = parent;
  }
  const source = import.meta.url.endsWith('.ts');
  const entryName = source ? name : name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  return path.join(directory, source ? 'src' : 'dist', 'extensions', `${entryName}.${source ? 'ts' : 'mjs'}`);
}
