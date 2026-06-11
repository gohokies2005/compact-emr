// Keystone 4b — the FORCE path of the chart-extract trigger. The salted hash must break the
// (caseId, triggerHash) INSERT-as-mutex where the unsalted re-run would P2002-no-op, while the
// all-terminal gate still applies (force "rides the existing trigger", never a synchronous path).
import { describe, it, expect, vi } from 'vitest';
import { maybeEnqueueChartExtract } from '../chart-extract-trigger.js';
import { computeTriggerHash } from '../chart-build-state.js';
import type { AppDb } from '../db-types.js';

vi.mock('../chart-extract-queue.js', () => ({
  publishChartExtractQueued: vi.fn(async () => undefined),
}));

const DOCS = [{ id: 'd1', s3Key: 'cases/C-1/k1' }, { id: 'd2', s3Key: 'cases/C-1/k2' }];
const READ = [
  { filePath: 'cases/C-1/k1', terminalStatus: 'read' },
  { filePath: 'cases/C-1/k2', terminalStatus: 'read' },
];

function makeDb(opts: { docs?: typeof DOCS; readStatuses?: typeof READ; createThrowsP2002?: boolean } = {}) {
  const creates: Record<string, unknown>[] = [];
  const db = {
    case: { findFirst: vi.fn(async () => ({ veteranId: 'VET-1' })) },
    document: { findMany: vi.fn(async () => opts.docs ?? DOCS) },
    fileReadStatus: { findMany: vi.fn(async () => opts.readStatuses ?? READ) },
    chartExtractionRun: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (opts.createThrowsP2002) { const err = new Error('unique'); (err as Error & { code?: string }).code = 'P2002'; throw err; }
        creates.push(args.data);
        return args.data;
      }),
      delete: vi.fn(async () => ({})),
    },
  } as unknown as AppDb;
  return { db, creates };
}

describe('maybeEnqueueChartExtract — force salt (keystone 4b)', () => {
  it('without force: creates a run with the bare hash (unchanged contract)', async () => {
    const { db, creates } = makeDb();
    const out = await maybeEnqueueChartExtract(db, 'C-1');
    expect(out.enqueued).toBe(true);
    expect(creates[0]?.['triggerHash']).toBe(computeTriggerHash(DOCS, READ));
  });

  it('with forceSalt: creates a FRESH run with the salted hash where the bare hash would collide', async () => {
    const { db, creates } = makeDb();
    const out = await maybeEnqueueChartExtract(db, 'C-1', { forceSalt: 'manual:req-1' });
    expect(out.enqueued).toBe(true);
    const base = computeTriggerHash(DOCS, READ);
    expect(creates[0]?.['triggerHash']).toBe(`${base}:manual:req-1`);
    expect(creates[0]?.['triggerHash']).not.toBe(base); // the wedge-breaking property
  });

  it('force still honors the all-terminal gate: mid-OCR docs → ocr_in_progress, no run created', async () => {
    const { db, creates } = makeDb({ readStatuses: [READ[0]!] }); // k2 has no terminal status
    const out = await maybeEnqueueChartExtract(db, 'C-1', { forceSalt: 'manual:req-1' });
    expect(out).toEqual({ enqueued: false, reason: 'ocr_in_progress' });
    expect(creates).toHaveLength(0);
  });

  it('a same-salt retry P2002s into the benign already_enqueued no-op (the mutex still works)', async () => {
    const { db } = makeDb({ createThrowsP2002: true });
    const out = await maybeEnqueueChartExtract(db, 'C-1', { forceSalt: 'manual:req-1' });
    expect(out).toEqual({ enqueued: false, reason: 'already_enqueued' });
  });
});
