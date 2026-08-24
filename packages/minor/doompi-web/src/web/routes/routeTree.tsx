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

function SubagentsView() {
  return <CockpitPage view="subagents" />;
}

const sessionSubagentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/session/$sessionId/subagents',
  component: SubagentsView,
});

export const routeTree = rootRoute.addChildren([indexRoute, sessionRoute, sessionSubagentsRoute]);
