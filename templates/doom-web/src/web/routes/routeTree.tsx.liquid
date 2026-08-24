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

function WorkflowsView() {
  return <CockpitPage view="workflows" />;
}

const sessionWorkflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/session/$sessionId/workflows',
  component: WorkflowsView,
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  sessionRoute,
  sessionSubagentsRoute,
  sessionWorkflowsRoute,
]);
