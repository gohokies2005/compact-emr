import { describe, expect, it, vi } from 'vitest';
import { handler } from '../lambdas/stuck-doc-watcher.js';
import type { PrismaClient } from '@prisma/client';

/**
 * The stuck-doc watcher is the keystone of the "never stuck, never silent" OCR guarantee — but a
 * watcher that loops is the OPPOSITE failure (the doctor-pack pypdf incident republished for 14h). These
 * tests lock the three load-bearing invariants: (1) ONE re-fire per doc, then flag — never an infinite
 * re-fire; (2) a doc that already has a terminal read-status is NOT swept; (3) an RN's
 * manual_summary_provided is never clobbered.
 */

const MIN = 60 * 1000;

interface Candidate { id: string; caseId: string; s3Key: string; uploadedAt: Date }
interface RefireLog { ts: Date; detailsJson: unknown }

function makeDeps(opts: {
  candidates: Candidate[];
  frsByKey?: Record<string, { id: string; terminalStatus: string; attemptsJson: unknown } | null>;
  refiresByCase?: Record<string, RefireLog[]>;
}) {
  const logsCreated: Array<{ action: string; detailsJson: unknown }> = [];
  const frsUpdated: Array<Record<string, unknown>> = [];
  const frsCreated: Array<Record<string, unknown>> = [];
  const invokeOcr = vi.fn(async () => {});
  const prisma = {
    document: { findMany: vi.fn(async () => opts.candidates) },
    fileReadStatus: {
      findFirst: vi.fn(async (a: { where: { filePath: string } }) => opts.frsByKey?.[a.where.filePath] ?? null),
      update: vi.fn(async (a: Record<string, unknown>) => { frsUpdated.push(a); }),
      create: vi.fn(async (a: Record<string, unknown>) => { frsCreated.push(a); }),
    },
    activityLog: {
      findMany: vi.fn(async (a: { where: { caseId: string } }) => opts.refiresByCase?.[a.where.caseId] ?? []),
      create: vi.fn(async (a: { data: { action: string; detailsJson: unknown } }) => { logsCreated.push(a.data); }),
    },
  } as unknown as PrismaClient;
  return { deps: { prisma, invokeOcr }, invokeOcr, logsCreated, frsUpdated, frsCreated };
}

const doc = (over: Partial<Candidate> = {}): Candidate => ({
  id: 'DOC-1', caseId: 'CASE-1', s3Key: 'cases/CASE-1/abc-records.pdf', uploadedAt: new Date(Date.now() - 60 * MIN), ...over,
});

describe('stuck-doc watcher — one-re-fire-then-flag, anti-join, clobber-guard', () => {
  it('FIRST encounter (no prior re-fire, no terminal row): re-fires OCR exactly once + logs it', async () => {
    const { deps, invokeOcr, logsCreated } = makeDeps({ candidates: [doc()] });
    const r = await handler(deps);
    expect(invokeOcr).toHaveBeenCalledTimes(1);
    expect(invokeOcr).toHaveBeenCalledWith(expect.any(String), 'cases/CASE-1/abc-records.pdf');
    expect(r.refired).toBe(1);
    expect(r.sweptToManual).toBe(0);
    expect(logsCreated.some((l) => l.action === 'ocr_refired_by_watcher')).toBe(true);
  });

  it('a doc with a TERMINAL read-status (manual_summary_required) is NOT stuck — never re-fired (anti-join)', async () => {
    const { deps, invokeOcr, logsCreated } = makeDeps({
      candidates: [doc()],
      frsByKey: { 'cases/CASE-1/abc-records.pdf': { id: 'FRS-1', terminalStatus: 'manual_summary_required', attemptsJson: [] } },
    });
    const r = await handler(deps);
    expect(invokeOcr).not.toHaveBeenCalled();
    expect(r.refired).toBe(0);
    expect(r.sweptToManual).toBe(0);
    expect(logsCreated).toHaveLength(0);
  });

  it('a prior re-fire OLDER than the give-up window + STILL no terminal row → flags manual (no re-fire loop)', async () => {
    const { deps, invokeOcr, frsCreated, logsCreated } = makeDeps({
      candidates: [doc()],
      refiresByCase: { 'CASE-1': [{ ts: new Date(Date.now() - 40 * MIN), detailsJson: { documentId: 'DOC-1' } }] },
    });
    const r = await handler(deps);
    expect(invokeOcr).not.toHaveBeenCalled(); // crucial: does NOT re-fire again — bounded to one
    expect(r.sweptToManual).toBe(1);
    expect(frsCreated.some((f) => (f['data'] as Record<string, unknown>)['terminalStatus'] === 'manual_summary_required')).toBe(true);
    expect(logsCreated.some((l) => l.action === 'ocr_swept_to_manual')).toBe(true);
  });

  it('a RECENT prior re-fire (within the give-up window) → waits, neither re-fires nor flags', async () => {
    const { deps, invokeOcr, frsCreated } = makeDeps({
      candidates: [doc()],
      refiresByCase: { 'CASE-1': [{ ts: new Date(Date.now() - 2 * MIN), detailsJson: { documentId: 'DOC-1' } }] },
    });
    const r = await handler(deps);
    expect(invokeOcr).not.toHaveBeenCalled();
    expect(r.sweptToManual).toBe(0);
    expect(r.waiting).toBe(1);
    expect(frsCreated).toHaveLength(0);
  });

  it('NEVER clobbers an RN manual_summary_provided, even past the give-up window', async () => {
    const { deps, invokeOcr, frsUpdated, frsCreated } = makeDeps({
      candidates: [doc()],
      frsByKey: { 'cases/CASE-1/abc-records.pdf': { id: 'FRS-1', terminalStatus: 'manual_summary_provided', attemptsJson: [] } },
      refiresByCase: { 'CASE-1': [{ ts: new Date(Date.now() - 40 * MIN), detailsJson: { documentId: 'DOC-1' } }] },
    });
    const r = await handler(deps);
    // manual_summary_provided is terminal → excluded by the anti-join before we even reach the give-up.
    expect(invokeOcr).not.toHaveBeenCalled();
    expect(r.sweptToManual).toBe(0);
    expect(frsUpdated).toHaveLength(0);
    expect(frsCreated).toHaveLength(0);
  });

  it('skips the screening-summary output + _rendered/ letters (not OCR inputs)', async () => {
    const { deps, invokeOcr } = makeDeps({
      candidates: [
        doc({ id: 'DOC-SS', s3Key: 'cases/CASE-1/00000000-screening-summary.txt' }),
        doc({ id: 'DOC-R', s3Key: 'cases/CASE-1/_rendered/veteran-statement-v3.pdf' }),
      ],
    });
    const r = await handler(deps);
    expect(invokeOcr).not.toHaveBeenCalled();
    expect(r.refired).toBe(0);
    expect(r.sweptToManual).toBe(0);
  });
});
