import type { SettingsSectionContribution } from '@agimon-ai/doompi-core/web';

export const computerUseSettingsSection: SettingsSectionContribution = {
  id: 'computer-use',
  label: 'computer use',
  detail: 'control whether DoomPi Desktop may expose session-scoped computer control',
  order: 45,
  fields: [
    {
      id: 'enabled',
      label: 'enable computer use',
      kind: 'toggle',
      keyPath: ['computerUse', 'enabled'],
      detail: 'Makes the computer-use minor mode available. Each control session still requires native confirmation.',
    },
  ],
};
