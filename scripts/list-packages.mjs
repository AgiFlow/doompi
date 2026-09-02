import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const packageDirectories = [
  ...directoriesIn(path.join(root, 'packages', 'core')),
  ...directoriesIn(path.join(root, 'packages', 'default')),
  ...directoriesIn(path.join(root, 'packages', 'minor')),
  ...directoriesIn(path.join(root, 'packages', 'clients')),
  ...directoriesIn(path.join(root, 'packages', 'tooling')),
  ...directoriesIn(path.join(root, 'layers')).flatMap(directoriesIn),
].filter((directory) => fs.existsSync(path.join(directory, 'package.json')));

function directoriesIn(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name));
}

for (const directory of packageDirectories.sort()) {
  const manifestPath = path.join(directory, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.private === true) {
    continue;
  }
  if (process.argv.includes('--paths')) {
    console.log(path.relative(root, manifestPath));
    continue;
  }
  console.log(`${manifest.name}\t${manifest.version}`);
}
