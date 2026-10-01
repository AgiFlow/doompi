import { defineRepositorySettingsPanel } from '@agimon-ai/doompi-core/web';

import { GitAuthPanel } from './_components/GitAuthPanel';

export default defineRepositorySettingsPanel({
  label: 'git remote',
  detail: "how this workspace's sessions reach the remote when you pull, push or rebase from the cockpit",
  order: 50,
  component: GitAuthPanel,
});
