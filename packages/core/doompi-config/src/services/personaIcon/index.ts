import { PROFILE_ICON_MAX_DATA_URL_LENGTH, type ProfileIconMimeType } from '@agimon-ai/doompi-core/profile-identity';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Reads a persona icon into a bounded `data:` URL.
 *
 * The icon travels inside the journalled identity entry rather than through an
 * HTTP route. A route would leave a request-time filesystem resolution reachable
 * from the browser for the life of a session, defended on every request forever;
 * this resolves the path once, server side, at the moment the profile loads.
 *
 * The path comes from user-authored front-matter, so it is confined the same way
 * `buildPersonaPrompt` confines persona files: a symlink must not read outside
 * the persona directory.
 *
 * Every failure is silent and returns undefined. An avatar is decoration, and a
 * broken one must never stop a persona from loading.
 */
const PARENT_DIRECTORY = '..';

/**
 * Magic-byte signatures, checked instead of trusting the filename.
 *
 * `image/svg+xml` is absent on purpose: an SVG rendered same-origin executes
 * script, and the author of this path is whoever wrote the persona. Do not add
 * it to match the cockpit's broader media catalog.
 */
const SIGNATURES: readonly { readonly mime: ProfileIconMimeType; readonly test: (bytes: Buffer) => boolean }[] = [
  {
    mime: 'image/png',
    test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  },
  { mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: (b) => b.length > 6 && b.subarray(0, 6).toString('latin1').startsWith('GIF8') },
  {
    mime: 'image/webp',
    test: (b) =>
      b.length > 12 &&
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

function sniff(bytes: Buffer): ProfileIconMimeType | undefined {
  return SIGNATURES.find((signature) => signature.test(bytes))?.mime;
}

/**
 * Resolves an icon declared in persona front-matter, or undefined when it is
 * missing, unreadable, not an allowed image, escapes the persona directory, or
 * exceeds the data-URL ceiling.
 */
export function readPersonaIcon(personaPath: string, iconRelative: string): string | undefined {
  if (path.isAbsolute(iconRelative)) return undefined;

  try {
    const realPersonaPath = fs.realpathSync(personaPath);
    const iconPath = path.resolve(realPersonaPath, iconRelative);
    if (!fs.existsSync(iconPath)) return undefined;

    const realIconPath = fs.realpathSync(iconPath);
    const relative = path.relative(realPersonaPath, realIconPath);
    if (
      relative === PARENT_DIRECTORY ||
      relative.startsWith(`${PARENT_DIRECTORY}${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return undefined;
    }
    if (!fs.statSync(realIconPath).isFile()) return undefined;

    const bytes = fs.readFileSync(realIconPath);
    const mime = sniff(bytes);
    if (!mime) return undefined;

    const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
    return dataUrl.length > PROFILE_ICON_MAX_DATA_URL_LENGTH ? undefined : dataUrl;
  } catch {
    return undefined;
  }
}
