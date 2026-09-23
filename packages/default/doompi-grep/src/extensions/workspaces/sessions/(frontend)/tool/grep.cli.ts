import { definePiToolRenderer } from '@agimon-ai/doompi-core/piExtension';

import { grepRenderer } from './_lib/grepRenderer.cli';

export default definePiToolRenderer(grepRenderer);
