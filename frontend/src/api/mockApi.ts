export async function mockRequest<T>(_path: string): Promise<T> {
  throw new Error('mock api removed in Phase 3; set VITE_USE_MOCK_API=false');
}
