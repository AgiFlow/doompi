import { createRootRoute, createRoute, Outlet } from '@tanstack/react-router';
import { CockpitPage } from './CockpitPage.tsx';
import { SettingsPage } from './SettingsPage.tsx';

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

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
  component: SettingsPage,
});

const settingsSectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/$section',
  component: SettingsPage,
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  sessionRoute,
  sessionTabRoute,
  settingsRoute,
  settingsSectionRoute,
]);
