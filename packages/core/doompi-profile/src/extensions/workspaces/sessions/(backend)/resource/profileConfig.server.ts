import { defineResource } from '@agimon-ai/doompi-core/extension-file';

import { readSelectedPersona } from '../_lib/profileServer';
export default defineResource({ name: 'doompi/profile-config', kind: 'context' as const, read: readSelectedPersona });
