import { defineRoot } from '@agimon-ai/doompi-core/extensionFile';

import { api } from '../../../../services/previewApi';

export default defineRoot(() => ({ value: { api: [api] } }));
