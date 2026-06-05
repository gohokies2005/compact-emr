import { describe, expect, it, vi } from 'vitest';
import { runSweep } from '../lambdas/jotform-sweep.js';

function subs(n: number, startId = 0): Array<{ id: string; form_id: string; created_at: string }> {
  return Array.from({ length: n }, (_, i) => ({ id: `S${startId + i}`, form_id: 'F1', created_at: '2026-06-05 08:00:00' }));
}

describe('jotform-sweep runSweep', () => {
  it('paginates the Jotform list (1000 + 3) and replays every submission through the webhook', async () => {
    const pages = [subs(1000, 0), subs(3, 1000)];
    const listSubmissions = vi.fn(async (_since: string, offset: number) => (offset === 0 ? pages[0]! : pages[1]!));
    const replay = vi.fn(async () => 200);
    const r = await runSweep('2026-06-05 05:00:00', { listSubmissions, replay, log: () => {} });
    expect(listSubmissions).toHaveBeenCalledTimes(2); // page 2 (<1000) stops pagination
    expect(replay).toHaveBeenCalledTimes(1003);
    expect(r).toMatchObject({ listed: 1003, replayed: 1003, failed: 0 });
  });

  it('does NOT itself dedupe — replays all; the webhook + DB constraint own idempotency', async () => {
    const replay = vi.fn(async () => 200);
    const r = await runSweep('s', { listSubmissions: async () => subs(5), replay, log: () => {} });
    expect(replay).toHaveBeenCalledTimes(5);
    expect(r.replayed).toBe(5);
  });

  it('surfaces a per-submission failure reason (non-200) and still completes', async () => {
    const replay = vi.fn(async (_f: string, id: string) => (id === 'S2' ? 500 : 200));
    const r = await runSweep('s', { listSubmissions: async () => subs(4), replay, log: () => {} });
    expect(r.replayed).toBe(3);
    expect(r.failed).toBe(1);
    expect(r.failures[0]).toMatchObject({ submissionId: 'S2', reason: 'webhook HTTP 500' });
  });

  it('surfaces a thrown replay error (network) as a failure reason, not an uncaught throw', async () => {
    const replay = vi.fn(async (_f: string, id: string) => { if (id === 'S1') throw new Error('ECONNRESET'); return 200; });
    const r = await runSweep('s', { listSubmissions: async () => subs(3), replay, log: () => {} });
    expect(r.failed).toBe(1);
    expect(r.failures[0]).toMatchObject({ submissionId: 'S1', reason: 'ECONNRESET' });
  });
});
