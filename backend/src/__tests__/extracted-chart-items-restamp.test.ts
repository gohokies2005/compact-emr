// Keystone 4c — the post-merge restamp hook wiring in POST /internal/cases/:caseId/extracted-chart-items:
// fires exactly when the merge WROTE rows (written > 0), never in shadow/no-op merges, and a hook
// throw can never fail the worker callback (the merge already committed).
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInternalWorkerRouter } from '../routes/internal-worker.js';
import { requireServicePrincipal, INTERNAL_WORKER_TOKEN_HEADER } from '../middleware/service-principal.js';
import { isHttpError, sendError } from '../http/errors.js';
import { applyExtractionMerge } from '../services/chart-merge-apply.js';
import { refreshDerivedStamps } from '../services/case-stamp-refresh.js';
import type { AppDb } from '../services/db-types.js';

const TEST_TOKEN = 'phase7b-test-worker-token-must-be-16+chars';

vi.mock('../services/chart-merge-apply.js', () => ({
  applyExtractionMerge: vi.fn(),
}));
vi.mock('../services/case-stamp-refresh.js', () => ({
  refreshDerivedStamps: vi.fn(async () => ({ framing: 'overwritten', viability: 'skipped', cds: 'skipped' })),
}));

const mergeMock = vi.mocked(applyExtractionMerge);
const refreshMock = vi.mocked(refreshDerivedStamps);

function appFor() {
  const db = {
    case: { findFirst: vi.fn(async () => ({ veteranId: 'VET-1' })) },
  } as unknown as AppDb;
  const app = express();
  app.use(express.json());
  app.use('/api/v1', requireServicePrincipal(), createInternalWorkerRouter(db));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (isHttpError(error)) return sendError(res, error.status, error.code, error.message, error.details);
    return sendError(res, 500, 'internal_error', 'Unexpected server error.');
  });
  return app;
}

const ITEM = {
  category: 'sc_condition', name: 'PTSD', sourceDocumentId: 'd1', sourcePage: 1,
  sourceQuote: 'service connected for PTSD', confidence: 0.95,
};

function post(app: express.Express) {
  return request(app)
    .post('/api/v1/internal/cases/CASE-1/extracted-chart-items')
    .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
    .send({ runId: 'RUN-1', items: [ITEM] });
}

beforeEach(() => {
  process.env['INTERNAL_WORKER_TOKEN'] = TEST_TOKEN;
  vi.clearAllMocks();
  refreshMock.mockResolvedValue({ framing: 'overwritten', viability: 'skipped', cds: 'skipped' });
});

describe('extracted-chart-items → post-merge restamp hook', () => {
  it('fires the restamp when the merge WROTE rows (written > 0)', async () => {
    mergeMock.mockResolvedValueOnce({ autofill: true, written: 2, skippedManual: 0, skippedPriorExtracted: 0, skippedDuplicate: 0 });
    const res = await post(appFor()).expect(200);
    expect(res.body.data.written).toBe(2);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(refreshMock).toHaveBeenCalledWith(expect.anything(), 'CASE-1');
  });

  it('does NOT fire in shadow mode / when nothing was written (written = 0)', async () => {
    mergeMock.mockResolvedValueOnce({ autofill: false, written: 0, skippedManual: 0, skippedPriorExtracted: 0, skippedDuplicate: 0 });
    await post(appFor()).expect(200);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('a restamp throw never fails the callback — the merge result still returns 200', async () => {
    mergeMock.mockResolvedValueOnce({ autofill: true, written: 1, skippedManual: 0, skippedPriorExtracted: 0, skippedDuplicate: 0 });
    refreshMock.mockRejectedValueOnce(new Error('stamp refresh exploded'));
    const res = await post(appFor()).expect(200);
    expect(res.body.data.written).toBe(1); // the worker callback is unharmed
  });

  // Architect pre-flip BLOCKER: the route's coerceExtractedItems rebuilds each item field-by-field
  // and previously DROPPED medStatus/startDate/lastSeenDate, so every full-read med would write as
  // 'active' and the timeline would collapse at dedup. Guard the boundary passthrough.
  it('passes medication temporality through to the merge (no HTTP-boundary drop)', async () => {
    mergeMock.mockResolvedValueOnce({ autofill: false, written: 0, skippedManual: 0, skippedPriorExtracted: 0, skippedDuplicate: 0 });
    const med = {
      category: 'active_medication', name: 'escitalopram', medStatus: 'historical',
      startDate: '03/12/2015', lastSeenDate: '06/14/2022',
      sourceDocumentId: 'd1', sourcePage: 5, sourceQuote: 'escitalopram', confidence: 0.9,
    };
    await request(appFor())
      .post('/api/v1/internal/cases/CASE-1/extracted-chart-items')
      .set(INTERNAL_WORKER_TOKEN_HEADER, TEST_TOKEN)
      .send({ runId: 'RUN-1', items: [med] })
      .expect(200);
    const passedItem = mergeMock.mock.calls[0]![1].items[0]!;
    expect(passedItem).toMatchObject({ medStatus: 'historical', startDate: '03/12/2015', lastSeenDate: '06/14/2022' });
  });
});
