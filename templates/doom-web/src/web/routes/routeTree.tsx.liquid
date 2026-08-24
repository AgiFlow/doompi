import { createRootRoute, createRoute, Outlet } from '@tanstack/react-router';
import { CockpitPage } from './CockpitPage.tsx';

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

export const routeTree = rootRoute.addChildren([indexRoute, sessionRoute, sessionTabRoute]);
