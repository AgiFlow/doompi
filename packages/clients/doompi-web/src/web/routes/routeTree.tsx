import { createRootRoute, createRoute, Outlet } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';

import { PluginSurface } from '../components/PluginSurface';
import { RefusedCard } from '../features/connection/RefusedCard';
import { DialogOverlay } from '../features/dialogs/DialogOverlay';
import { CommandPalette } from '../features/leader/CommandPalette';
import { HOST_SLOTS } from '../lib/pluginRegistry';
import { sessionsStore } from '../stores/sessionsStore';
import { CockpitPage } from './CockpitPage';
import { SettingsPage } from './SettingsPage';

function settingsSearch(search: Record<string, unknown>): { workspace?: string } {
  return typeof search.workspace === 'string' && search.workspace !== '' ? { workspace: search.workspace } : {};
}

/** Mandatory surfaces remain outside replaceable template layouts on every route. */
function RootLayout() {
  const sessionId = useStore(sessionsStore, (state) => state.activeId);
  return (
    <>
      <Outlet />
      <DialogOverlay />
      <RefusedCard />
      <CommandPalette />
      <PluginSurface slot={HOST_SLOTS.overlay} sessionId={sessionId} />
    </>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: CockpitPage,
});

const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/session/$sessionId',
  component: CockpitPage,
});

// Every plugin tab lives under one parameterized segment, so the route tree
// stays static while the tab set comes from the plugin registry.
const sessionTabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/session/$sessionId/$tabId',
  component: CockpitPage,
});

// Settings keep the same shape: one static segment, one parameter for the
// section, so adding a page never touches the route tree.
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  validateSearch: settingsSearch,
  component: SettingsPage,
});

const settingsSectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/$section',
  validateSearch: settingsSearch,
  component: SettingsPage,
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  sessionRoute,
  sessionTabRoute,
  settingsRoute,
  settingsSectionRoute,
]);
