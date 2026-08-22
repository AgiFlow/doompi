import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const nxConfig = JSON.parse(fs.readFileSync(path.join(root, 'nx.json'), 'utf8'));
const releaseProjects = nxConfig.release.groups.alpha.projects;

const [affectedFile] = process.argv.slice(2);
if (!affectedFile || affectedFile === '--all') {
  console.log(releaseProjects.join(','));
  process.exit(0);
}

const affected = new Set(JSON.parse(fs.readFileSync(affectedFile, 'utf8')));
console.log(releaseProjects.filter((project) => affected.has(project)).join(','));
