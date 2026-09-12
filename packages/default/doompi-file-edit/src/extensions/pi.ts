import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';
import { PACKAGE_SOURCE } from '../constants/package';
import { createFileEditRuntime } from '../controllers/fileEditRuntime';
import { createFileEditDependencies } from '../tui/fileEditDependencies';
export const fileEditExtension = definePiExtension(PACKAGE_SOURCE, () =>
  createFileEditRuntime(createFileEditDependencies()),
);
export default fileEditExtension;
