import { definePiToolRenderer } from '@agimon-ai/doompi-core/pi-extension';

import { grepRenderer } from './_lib/grepRenderer.cli';

export default definePiToolRenderer(grepRenderer);
