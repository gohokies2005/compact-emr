import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createJotformWebhookRouter } from '../routes/jotform-webhook.js';

// NODE_ENV=test makes publishJotformIngest a no-op, so no SQS is touched.
function appFor(intakeDelegate: unknown) {
  process.env.JOTFORM_WEBHOOK_SECRET = 'sek';
  const app = express();
  app.use('/api/v1/jotform/webhook', express.urlencoded({ extended: true }), createJotformWebhookRouter({ intake: intakeDelegate } as never));
  return app;
}

beforeEach(() => { process.env.JOTFORM_WEBHOOK_SECRET = 'sek'; });

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

  it('is idempotent — a duplicate submission (P2002) still 200s', async () => {
    const create = vi.fn(async () => { throw { code: 'P2002' }; });
    const findUnique = vi.fn(async () => ({ id: 'intake-existing' }));
    await request(appFor({ create, findUnique })).post('/api/v1/jotform/webhook/sek').type('form').send({ formID: '1', submissionID: 'SUB-DUP' }).expect(200);
    expect(findUnique).toHaveBeenCalledWith({ where: { jotformSubmissionId: 'SUB-DUP' } });
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
