import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Existing parents only, pinned by identity before and after exclusive creation. */
export async function writeCwdFile(cwd: string, relative: string, bytes: Uint8Array): Promise<string> {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Path must be relative without traversal.');
  const root = await fs.realpath(cwd);
  const target = path.join(root, relative);
  const parents = [root];
  for (const segment of relative.split('/').slice(0, -1)) parents.push(path.join(parents.at(-1)!, segment));
  const identities = await Promise.all(
    parents.map(async (parent) => {
      const stat = await fs.lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(parent)) !== parent)
        throw new Error('Unsafe parent directory.');
      return stat;
    }),
  );
  const check = async () => {
    for (let i = 0; i < parents.length; i += 1) {
      const stat = await fs.lstat(parents[i]);
      if (
        stat.dev !== identities[i].dev ||
        stat.ino !== identities[i].ino ||
        (await fs.realpath(parents[i])) !== parents[i]
      )
        throw new Error('Parent directory changed.');
    }
  };
  await check();
  const handle = await fs.open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const identity = await handle.stat();
    const checkFile = async () => {
      const named = await fs.lstat(target);
      if (named.dev !== identity.dev || named.ino !== identity.ino || (await fs.realpath(target)) !== target)
        throw new Error('File identity changed.');
    };
    await check();
    await checkFile();
    await handle.writeFile(bytes);
    await check();
    await checkFile();
    return target;
  } catch (error) {
    // Only our exclusively-created inode is truncated, even if its parents moved.
    await handle.truncate(0);
    // Never unlink through a mutable pathname: Node cannot atomically prove the
    // name still identifies this descriptor. Failed writes may leave an empty file.
    throw error;
  } finally {
    await handle.close();
  }
}
