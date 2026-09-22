import { defineMessageRenderer } from '@agimon-ai/doompi-core/piExtension';
import { Text } from '@earendil-works/pi-tui';

import { NOTIFY_CUSTOM_TYPE } from '../../../../../services/delegation';

export default defineMessageRenderer(
  NOTIFY_CUSTOM_TYPE,
  (message, _options, theme) =>
    new Text(theme.fg('muted', typeof message.content === 'string' ? message.content : ''), 0, 0),
);
