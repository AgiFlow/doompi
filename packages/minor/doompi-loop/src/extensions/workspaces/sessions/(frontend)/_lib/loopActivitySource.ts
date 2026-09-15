export const LOOPS_ACTIVITY_SOURCE = {
  subscribe: () => () => undefined,
  isActive: (_sessionId: string | null) => false,
};
