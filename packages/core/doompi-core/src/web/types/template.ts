import type { ComponentType, ReactNode } from 'react';

/** Host content is independent of the selected presentation package. */
export interface WebTemplateSlots {
  navigation: ReactNode;
  header: (options: WebTemplateHeaderOptions) => ReactNode;
  notices: ReactNode;
  content: ReactNode;
  composer: ReactNode;
  controls: ReactNode;
  activity: ReactNode;
}

/** A drawer-based template keeps the corresponding header controls visible on desktop too. */
export interface WebTemplateHeaderOptions {
  navigationToggle: 'mobile' | 'always';
  activityToggle: 'mobile' | 'always';
}

export interface WebTemplateProps {
  view: 'conversation' | 'panel' | 'settings' | 'welcome';
  slots: WebTemplateSlots;
  navigationOpen: boolean;
  desktopActivityOpen: boolean;
  mobileActivityOpen: boolean;
  onNavigationOpenChange: (open: boolean) => void;
  onDesktopActivityOpenChange: (open: boolean) => void;
  onMobileActivityOpenChange: (open: boolean) => void;
}

/** A template is a browser contribution, never an agent mode or a separate session runtime. */
export interface WebTemplateContribution {
  id: string;
  label: string;
  description: string;
  contractVersion: 1;
  layout: ComponentType<WebTemplateProps>;
}
