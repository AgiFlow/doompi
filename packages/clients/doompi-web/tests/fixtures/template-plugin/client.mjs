import { defineWebPlugin } from '@agimon-ai/doompi-core/web';
import { createElement } from 'react';

function IndependentLayout({ slots, rail, scope = 'global' }) {
  return createElement(
    'div',
    { 'data-testid': 'independent-template', 'data-template-scope': scope },
    slots.notices,
    slots.header({ navigationToggle: 'always', activityToggle: 'always' }),
    createElement('main', null, slots.content, slots.composer, slots.controls),
    slots.activity,
    createElement(
      'button',
      {
        'data-testid': 'independent-workspace-settings',
        onClick: () => rail.actions.openWorkspaceSettings(rail.workspaces[0].id),
      },
      'Workspace settings',
    ),
  );
}

function WorkspaceIndependentLayout(props) {
  return createElement(IndependentLayout, { ...props, scope: 'workspace' });
}

function BrokenLayout() {
  throw new Error('Deliberate independent template failure');
}

const templates = [
  {
    id: 'independent-reader',
    label: 'Independent reader',
    description: 'A third-party template fixture loaded only through modes.yaml composition.',
    contractVersion: 1,
    layout: IndependentLayout,
  },
  {
    id: 'broken-reader',
    label: 'Broken reader',
    description: 'A template fixture that throws so host recovery can be verified.',
    contractVersion: 1,
    layout: BrokenLayout,
  },
];

export const webPlugin = defineWebPlugin({
  id: 'independent-template',
  global: { templates },
  workspace: {
    templates: templates.map((template) =>
      template.id === 'independent-reader' ? { ...template, layout: WorkspaceIndependentLayout } : template,
    ),
  },
  session: { templates },
});
