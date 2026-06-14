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

// A manual_summary_required row to be re-judged by Phase 3 (FIX 4 re-classify).
interface StuckRow { id: string; caseId: string; filePath: string; attemptsJson: unknown }

function makeDeps(opts: {
  candidates: Candidate[];
  frsByKey?: Record<string, { id: string; terminalStatus: string; attemptsJson: unknown } | null>;
  refiresByCase?: Record<string, RefireLog[]>;
  orphanPaged?: Array<{ id: string; case_id: string; s3_key: string }>;
  pagesByDoc?: Record<string, Array<{ text: string }>>;
  // Phase 3: manual_summary_required rows to re-classify, the Document each maps to (by caseId+s3Key),
  // and the stored pages keyed by documentId (reuses pagesByDoc).
  stuckManualRows?: StuckRow[];
  docByCaseKey?: Record<string, { id: string } | null>;
}) {
  const logsCreated: Array<{ action: string; detailsJson: unknown }> = [];
  const frsUpdated: Array<Record<string, unknown>> = [];
  const frsCreated: Array<{ data: Record<string, unknown> }> = [];
  const invokeOcr = vi.fn(async () => {});
  const prisma = {
    document: {
      findMany: vi.fn(async () => opts.candidates),
      // Phase 3 resolves the Document for a stuck readiness row by (caseId, s3Key).
      findFirst: vi.fn(async (a: { where: { caseId: string; s3Key: string } }) => opts.docByCaseKey?.[`${a.where.caseId}|${a.where.s3Key}`] ?? null),
    },
    documentPage: { findMany: vi.fn(async (a: { where: { documentId: string } }) => opts.pagesByDoc?.[a.where.documentId] ?? []) },
    fileReadStatus: {
      findFirst: vi.fn(async (a: { where: { filePath: string } }) => opts.frsByKey?.[a.where.filePath] ?? null),
      // Phase 3 batch query for manual_summary_required rows.
      findMany: vi.fn(async () => opts.stuckManualRows ?? []),
      update: vi.fn(async (a: Record<string, unknown>) => { frsUpdated.push(a); }),
      create: vi.fn(async (a: { data: Record<string, unknown> }) => { frsCreated.push(a); }),
    },
    activityLog: {
      findMany: vi.fn(async (a: { where: { caseId: string } }) => opts.refiresByCase?.[a.where.caseId] ?? []),
      create: vi.fn(async (a: { data: { action: string; detailsJson: unknown } }) => { logsCreated.push(a.data); }),
    },
    // tagged-template raw query for the Phase-2 "pages but no status" anti-join
    $queryRaw: vi.fn(async () => opts.orphanPaged ?? []),
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

  it('Phase 2: STAMPS a text-but-no-status doc as read (classifies existing pages — NO re-OCR)', async () => {
    // Real prose words (NOT "clinical0 clinical1 …" — those embed a digit and read as garbage word slots
    // under the v2 signal; a token must be an actual clean word to count as readable).
    const lex = ['the', 'veteran', 'reports', 'chronic', 'knee', 'pain', 'during', 'active', 'duty', 'service', 'with', 'progressive', 'onset'];
    const cleanText = Array.from({ length: 40 }, (_, i) => lex[i % lex.length]).join(' ');
    const { deps, invokeOcr, frsCreated, logsCreated } = makeDeps({
      candidates: [], // no no-pages candidates this run
      orphanPaged: [{ id: 'DOC-PG', case_id: 'CASE-2', s3_key: 'cases/CASE-2/xyz-Buddy-Statement.pdf' }],
      pagesByDoc: { 'DOC-PG': [{ text: cleanText }] },
    });
    const r = await handler(deps);
    expect(invokeOcr).not.toHaveBeenCalled(); // it already HAS text → never re-OCR
    expect(r.stamped).toBe(1);
    const created = frsCreated.find((f) => f.data['filePath'] === 'cases/CASE-2/xyz-Buddy-Statement.pdf');
    expect(created?.data['terminalStatus']).toBe('read');
    expect(logsCreated.some((l) => l.action === 'ocr_classified_orphan_pages')).toBe(true);
  });

  it('Phase 2: STAMPS a GARBLED text-but-no-status doc as manual_summary_required (never a false read)', async () => {
    const garbled = 'Pati$nt 4@ ol# p#esent!ng r!ght kn$e p$in lim%ted m0t!on n0 ev!d#nce im+pro!vement phys-ic@l'.repeat(3);
    const { deps, frsCreated } = makeDeps({
      candidates: [],
      orphanPaged: [{ id: 'DOC-G', case_id: 'CASE-3', s3_key: 'cases/CASE-3/xyz-BadScan.pdf' }],
      pagesByDoc: { 'DOC-G': [{ text: garbled }, { text: garbled }, { text: garbled }] },
    });
    const r = await handler(deps);
    expect(r.stamped).toBe(1);
    const created = frsCreated.find((f) => f.data['filePath'] === 'cases/CASE-3/xyz-BadScan.pdf');
    expect(created?.data['terminalStatus']).toBe('manual_summary_required');
  });

  // ── Phase 3: re-classify the false-garble backlog (FIX 4, 2026-06-14) ───────────────────────────
  // A row parked at manual_summary_required under the OLD over-broad garble heuristic whose stored pages
  // now PASS the corrected heuristic must self-heal to 'read' with NO re-OCR. These have a file_read_status
  // row (so Phase 2's NOT-EXISTS can't see them) and a stored corruptedTokenRatio > 0.08 (so the eval-time
  // retro-heal can't save them) — Phase 3 is the only path that clears the class.

  it('Phase 3: RE-CLASSIFIES a false-garble manual_summary_required row to read (hyphen-dense summary, NO re-OCR)', async () => {
    // The live false-positive: clean hyphen-dense text that the OLD heuristic scored > 0.08.
    const cleanHyphenDense = 'The veteran is service-connected for PTSD. Follow-up PC-PTSD-5 screen was well-documented. An x-ray and the auto-extracted notes confirm the diagnosis and the patient ongoing care plan today.';
    const { deps, invokeOcr, frsUpdated, logsCreated } = makeDeps({
      candidates: [],
      stuckManualRows: [{ id: 'FRS-FG', caseId: 'CASE-9', filePath: 'cases/CASE-9/uuid-Intake_Summary.pdf', attemptsJson: [{ method: 'textract', corruptedTokenRatio: 0.16, note: 'garbled' }] }],
      docByCaseKey: { 'CASE-9|cases/CASE-9/uuid-Intake_Summary.pdf': { id: 'DOC-FG' } },
      pagesByDoc: { 'DOC-FG': [{ text: cleanHyphenDense }] },
    });
    const r = await handler(deps);
    expect(invokeOcr).not.toHaveBeenCalled(); // NEVER re-OCR — re-judge the stored text only
    expect(r.reclassified).toBe(1);
    const upd = frsUpdated.find((u) => (u['where'] as { id: string }).id === 'FRS-FG');
    expect((upd?.['data'] as Record<string, unknown>)['terminalStatus']).toBe('read');
    expect(logsCreated.some((l) => l.action === 'ocr_reclassified_to_read')).toBe(true);
  });

  it('Phase 3: does NOT re-classify a GENUINELY garbled row — it stays parked (no weakening of garble detection)', async () => {
    const garbled = 'c0nn3@ct€d th3 r3c0rd Pati$nt p#esent!ng kn$e p$in lim%ted m0t!on n0 ev!d#nce im+pro!vement'.repeat(3);
    const { deps, frsUpdated } = makeDeps({
      candidates: [],
      stuckManualRows: [{ id: 'FRS-G', caseId: 'CASE-10', filePath: 'cases/CASE-10/uuid-BadScan.pdf', attemptsJson: [] }],
      docByCaseKey: { 'CASE-10|cases/CASE-10/uuid-BadScan.pdf': { id: 'DOC-G2' } },
      pagesByDoc: { 'DOC-G2': [{ text: garbled }] },
    });
    const r = await handler(deps);
    expect(r.reclassified).toBe(0);
    expect(frsUpdated).toHaveLength(0); // still correctly parked + RN-visible
  });

  it('Phase 3: skips an ORPHAN readiness row (no matching Document) — never touches it', async () => {
    const { deps, frsUpdated } = makeDeps({
      candidates: [],
      stuckManualRows: [{ id: 'FRS-O', caseId: 'CASE-11', filePath: 'cases/CASE-11/deleted-file.pdf', attemptsJson: [] }],
      docByCaseKey: { 'CASE-11|cases/CASE-11/deleted-file.pdf': null }, // no Document → orphan
    });
    const r = await handler(deps);
    expect(r.reclassified).toBe(0);
    expect(frsUpdated).toHaveLength(0);
  });
});
