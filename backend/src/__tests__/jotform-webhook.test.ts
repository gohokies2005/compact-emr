import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createJotformWebhookRouter } from '../routes/jotform-webhook.js';
import { publishJotformIngest } from '../services/jotform-ingest-queue.js';

// Mock the queue so we can observe whether the doorbell re-enqueues (the sweep-cost gate).
vi.mock('../services/jotform-ingest-queue.js', () => ({ publishJotformIngest: vi.fn(async () => ({ skipped: false })) }));
const enqueueMock = vi.mocked(publishJotformIngest);

// NODE_ENV=test makes publishJotformIngest a no-op, so no SQS is touched.
function appFor(intakeDelegate: unknown) {
  process.env.JOTFORM_WEBHOOK_SECRET = 'sek';
  const app = express();
  app.use('/api/v1/jotform/webhook', express.urlencoded({ extended: true }), createJotformWebhookRouter({ intake: intakeDelegate } as never));
  return app;
}

beforeEach(() => { process.env.JOTFORM_WEBHOOK_SECRET = 'sek'; enqueueMock.mockClear(); });

describe('jotform webhook (doorbell)', () => {
  it('404s on a wrong secret and does not record anything', async () => {
    const create = vi.fn();
    await request(appFor({ create })).post('/api/v1/jotform/webhook/WRONG').type('form').send({ formID: '1', submissionID: '2' }).expect(404);
    expect(create).not.toHaveBeenCalled();
  });

  it('400s when formID/submissionID are missing', async () => {
    await request(appFor({ create: vi.fn() })).post('/api/v1/jotform/webhook/sek').type('form').send({ formID: '1' }).expect(400);
  });

  it('records an Intake (status=pending) and 200s on a valid submission', async () => {
    const create = vi.fn(async () => ({ id: 'intake-1' }));
    const res = await request(appFor({ create })).post('/api/v1/jotform/webhook/sek').type('form').send({ formID: '260898029223159', submissionID: 'SUB-1' }).expect(200);
    expect(res.body.ok).toBe(true);
    expect(create).toHaveBeenCalledWith({ data: { jotformFormId: '260898029223159', jotformSubmissionId: 'SUB-1', status: 'pending' } });
  });

  // Contract the sweep depends on (2026-06-23 Herman Charles fix): the body echoes `result` so a
  // sweep replay can tell a RECOVERY ('enqueued' = real-time webhook had dropped it) from a no-op.
  it('echoes result=enqueued for a fresh submission', async () => {
    const create = vi.fn(async () => ({ id: 'intake-new' }));
    const res = await request(appFor({ create })).post('/api/v1/jotform/webhook/sek').type('form').send({ formID: '1', submissionID: 'FRESH-2' }).expect(200);
    expect(res.body.result).toBe('enqueued');
  });

  it('echoes result=noop-duplicate for an already-ingested submission', async () => {
    const create = vi.fn(async () => { throw { code: 'P2002' }; });
    const findUnique = vi.fn(async () => ({ id: 'intake-existing', status: 'ready' }));
    const res = await request(appFor({ create, findUnique })).post('/api/v1/jotform/webhook/sek').type('form').send({ formID: '1', submissionID: 'DONE-2' }).expect(200);
    expect(res.body.result).toBe('noop-duplicate');
  });

  it('is idempotent — a duplicate submission (P2002) still 200s', async () => {
    const create = vi.fn(async () => { throw { code: 'P2002' }; });
    const findUnique = vi.fn(async () => ({ id: 'intake-existing' }));
    await request(appFor({ create, findUnique })).post('/api/v1/jotform/webhook/sek').type('form').send({ formID: '1', submissionID: 'SUB-DUP' }).expect(200);
    expect(findUnique).toHaveBeenCalledWith({ where: { jotformSubmissionId: 'SUB-DUP' } });
  });

  it('enqueues a FRESH submission for the worker to fetch', async () => {
    const create = vi.fn(async () => ({ id: 'intake-new' }));
    await request(appFor({ create })).post('/api/v1/jotform/webhook/sek').type('form').send({ formID: '1', submissionID: 'FRESH' }).expect(200);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-enqueue a duplicate already ingested (ready) — sweep replay is a cheap no-op', async () => {
    const create = vi.fn(async () => { throw { code: 'P2002' }; });
    const findUnique = vi.fn(async () => ({ id: 'intake-existing', status: 'ready' }));
    await request(appFor({ create, findUnique })).post('/api/v1/jotform/webhook/sek').type('form').send({ formID: '1', submissionID: 'DONE' }).expect(200);
    expect(enqueueMock).not.toHaveBeenCalled(); // the worker never re-fetches an already-done one
  });

  it('DOES re-enqueue a duplicate still stuck pending/failed (self-heal)', async () => {
    const create = vi.fn(async () => { throw { code: 'P2002' }; });
    const findUnique = vi.fn(async () => ({ id: 'intake-stuck', status: 'failed' }));
    await request(appFor({ create, findUnique })).post('/api/v1/jotform/webhook/sek').type('form').send({ formID: '1', submissionID: 'STUCK' }).expect(200);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it('404s when no secret is configured (endpoint stays invisible)', async () => {
    delete process.env.JOTFORM_WEBHOOK_SECRET;
    const create = vi.fn();
    const app = express();
    app.use('/api/v1/jotform/webhook', express.urlencoded({ extended: true }), createJotformWebhookRouter({ intake: { create } } as never));
    await request(app).post('/api/v1/jotform/webhook/anything').type('form').send({ formID: '1', submissionID: '2' }).expect(404);
    expect(create).not.toHaveBeenCalled();
  });
});
