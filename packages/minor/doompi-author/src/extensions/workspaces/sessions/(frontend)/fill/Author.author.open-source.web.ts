import { defineFill } from '@agimon-ai/doompi-core/web';

import { authorOpenSourceAction } from '../_components/AuthorDocumentPanel';

export default defineFill({
  slot: 'author.open-source',
  id: 'author',
  data: authorOpenSourceAction,
});
