import { describe, expect, it, vi } from 'vitest';
import { runSweep, fmtEastern } from '../lambdas/jotform-sweep.js';

// Regression for the 2026-06-06 incident (Arturo Perez): the sweep formatted its created_at:gt
// cutoff in UTC, but Jotform's filter is US Eastern — so the cutoff was 4-5h in the future and the
// sweep matched NOTHING every run (listed:0). fmtEastern must render the instant in America/New_York.
describe('fmtEastern (Jotform created_at filter is US Eastern, not UTC)', () => {
  it('renders a summer (EDT, UTC-4) instant in Eastern', () => {
    // 2026-06-05 22:14:41Z = Arturo. EDT is UTC-4 → 18:14:41.
    expect(fmtEastern(new Date('2026-06-05T22:14:41Z'))).toBe('2026-06-05 18:14:41');
  });
  it('renders a winter (EST, UTC-5) instant in Eastern', () => {
    expect(fmtEastern(new Date('2026-01-15T10:00:00Z'))).toBe('2026-01-15 05:00:00');
  });
  it('is NOT equal to the UTC rendering (the old bug)', () => {
    const d = new Date('2026-06-05T22:14:41Z');
    expect(fmtEastern(d)).not.toBe('2026-06-05 22:14:41');
  });
});

function subs(n: number, startId = 0): Array<{ id: string; form_id: string; created_at: string }> {
  return Array.from({ length: n }, (_, i) => ({ id: `S${startId + i}`, form_id: 'F1', created_at: '2026-06-05 08:00:00' }));
}

// Steady-state replay: the doorbell finds the submission already ingested → 200 noop-duplicate.
const ok = async (): Promise<{ status: number; result: 'noop-duplicate' }> => ({ status: 200, result: 'noop-duplicate' });

describe('jotform-sweep runSweep', () => {
  it('paginates the Jotform list (1000 + 3) and replays every submission through the webhook', async () => {
    const pages = [subs(1000, 0), subs(3, 1000)];
    const listSubmissions = vi.fn(async (_since: string, offset: number) => (offset === 0 ? pages[0]! : pages[1]!));
    const replay = vi.fn(ok);
    const r = await runSweep('2026-06-05 05:00:00', { listSubmissions, replay, log: () => {} });
    expect(listSubmissions).toHaveBeenCalledTimes(2); // page 2 (<1000) stops pagination
    expect(replay).toHaveBeenCalledTimes(1003);
    expect(r).toMatchObject({ listed: 1003, replayed: 1003, recovered: 0, failed: 0 });
  });

  it('does NOT itself dedupe — replays all; the webhook + DB constraint own idempotency', async () => {
    const replay = vi.fn(ok);
    const r = await runSweep('s', { listSubmissions: async () => subs(5), replay, log: () => {} });
    expect(replay).toHaveBeenCalledTimes(5);
    expect(r.replayed).toBe(5);
  });

  it('surfaces a per-submission failure reason (non-200) and still completes', async () => {
    const replay = vi.fn(async (_f: string, id: string) => (id === 'S2' ? { status: 500, result: 'unknown' as const } : { status: 200, result: 'noop-duplicate' as const }));
    const r = await runSweep('s', { listSubmissions: async () => subs(4), replay, log: () => {} });
    expect(r.replayed).toBe(3);
    expect(r.failed).toBe(1);
    expect(r.failures[0]).toMatchObject({ submissionId: 'S2', reason: 'webhook HTTP 500' });
  });

  it('surfaces a thrown replay error (network) as a failure reason, not an uncaught throw', async () => {
    const replay = vi.fn(async (_f: string, id: string) => { if (id === 'S1') throw new Error('ECONNRESET'); return { status: 200, result: 'noop-duplicate' as const }; });
    const r = await runSweep('s', { listSubmissions: async () => subs(3), replay, log: () => {} });
    expect(r.failed).toBe(1);
    expect(r.failures[0]).toMatchObject({ submissionId: 'S1', reason: 'ECONNRESET' });
  });

  // 2026-06-23 (Herman Charles, CKD): Jotform silently dropped the real-time webhook for two fresh
  // submissions; the doorbell never saw them, so the sweep's replay was the FIRST delivery and the
  // doorbell returned result='enqueued'. That is a RECOVERY — count it + log it so the alarm fires.
  it('counts a sweep RECOVERY (doorbell result=enqueued = real-time webhook had dropped it) and logs it loud', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const replay = vi.fn(async (_f: string, id: string) =>
      (id === 'S1' ? { status: 200, result: 'enqueued' as const } : { status: 200, result: 'noop-duplicate' as const }));
    const r = await runSweep('s', { listSubmissions: async () => subs(3), replay, log: (o) => logs.push(o) });
    expect(r.replayed).toBe(3);
    expect(r.recovered).toBe(1);
    // The per-recovery loud line (drives the MetricFilter / alarm) + the per-run count datapoint.
    expect(logs.some((l) => l.msg === 'jotform-sweep: recovered-missed-webhook' && l.submissionId === 'S1')).toBe(true);
    expect(logs.some((l) => l.msg === 'jotform-sweep: recovered-count' && l.recovered === 1)).toBe(true);
  });

  it('emits a recovered-count=0 datapoint every run (so the MetricFilter always has data)', async () => {
    const logs: Array<Record<string, unknown>> = [];
    await runSweep('s', { listSubmissions: async () => subs(2), replay: vi.fn(ok), log: (o) => logs.push(o) });
    expect(logs.some((l) => l.msg === 'jotform-sweep: recovered-count' && l.recovered === 0)).toBe(true);
  });
});
