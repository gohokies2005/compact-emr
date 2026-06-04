import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createIntakesRouter } from '../routes/intakes.js';

function appFor(intake: unknown, deps: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as { user?: unknown }).user = { sub: 'u1', email: 'u@e.com', roles: ['ops_staff'] }; next(); });
  app.use('/api/v1', createIntakesRouter({ intake } as never, deps as never));
  return app;
}

describe('intakes pool API', () => {
  it('lists intakes filtered by status + search, newest first', async () => {
    const findMany = vi.fn(async () => [{ id: 'i1', status: 'ready' }]);
    const res = await request(appFor({ findMany })).get('/api/v1/intakes?status=ready&q=frank').expect(200);
    expect(res.body.data).toHaveLength(1);
    const arg = (findMany.mock.calls[0] as unknown as [{ where: { status?: string; OR?: unknown }; orderBy: unknown }])[0];
    expect(arg.where.status).toBe('ready');
    expect(arg.where.OR).toBeDefined();
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('404s on a missing intake detail', async () => {
    await request(appFor({ findUnique: vi.fn(async () => null) })).get('/api/v1/intakes/nope').expect(404);
  });

  it('returns detail with the file manifest (no s3 configured → no preview URLs)', async () => {
    const findUnique = vi.fn(async () => ({ id: 'i1', status: 'ready', fileManifestJson: [{ name: 'a.pdf', s3Key: 'intake/i1/a.pdf' }] }));
    const res = await request(appFor({ findUnique })).get('/api/v1/intakes/i1').expect(200);
    expect(res.body.data.files).toHaveLength(1);
    expect(res.body.data.files[0].previewUrl).toBeUndefined();
  });

  it('dismiss sets status=dismissed + reason (kept for audit)', async () => {
    const findUnique = vi.fn(async () => ({ id: 'i1' }));
    const update = vi.fn(async () => ({ id: 'i1', status: 'dismissed' }));
    await request(appFor({ findUnique, update })).post('/api/v1/intakes/i1/dismiss').send({ reason: 'dupe' }).expect(200);
    expect(update).toHaveBeenCalledWith({ where: { id: 'i1' }, data: { status: 'dismissed', dismissedReason: 'dupe' } });
  });

  it('retry resets to pending + increments retryCount (RN self-service)', async () => {
    const findUnique = vi.fn(async () => ({ id: 'i1', jotformFormId: 'f', jotformSubmissionId: 's', retryCount: 2 }));
    const update = vi.fn(async () => ({}));
    await request(appFor({ findUnique, update })).post('/api/v1/intakes/i1/retry').expect(200);
    expect(update).toHaveBeenCalledWith({ where: { id: 'i1' }, data: { status: 'pending', errorMessage: null, retryCount: 3 } });
  });
});
