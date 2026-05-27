export const buildInfo = {
  commitSha: import.meta.env.VITE_COMMIT_SHA?.trim() || 'local',
  useMockApi: import.meta.env.VITE_USE_MOCK_API === 'true',
  apiMode: import.meta.env.VITE_USE_MOCK_API === 'true' ? 'mock API' : 'live API',
} as const;
