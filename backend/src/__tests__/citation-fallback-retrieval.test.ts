import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import https from 'node:https';
import { EventEmitter } from 'node:events';

/**
 * BUG 3 (Spring, 2026-06-25) — grounded NCBI retrieval robustness in the vendored citationFallback.
 * These tests stub https.get so NO real network call is made. They assert:
 *   (a) the NCBI_API_KEY is read PER-REQUEST and appended to every E-utilities URL when set, and
 *       omitted when unset (keyless fallback);
 *   (b) eutil RETRIES on a transient failure (the request succeeds on a later attempt);
 *   (c) verifyPmidById never throws and returns a clean reason on bad input.
 */

const require_ = createRequire(import.meta.url);
const CJS_PATH = path.join(__dirname, '..', 'vendor', 'citationFallback.cjs');
type FallbackModule = {
  verifyPmidById(pmid: string, condition?: string): Promise<{ verified: boolean; reason?: string }>;
  retrieveGroundedAnchors(condition: string, opts?: { mechanismHints?: string[] }): Promise<{ status: string; anchors: unknown[] }>;
};

// Build a fake https.get that records the requested URLs and replays a queue of scripted responses.
// Each scripted response is either { body } (a 200 with that body) or { error } (reject) — letting us
// model a transient failure followed by a success to prove the retry path.
function installHttpStub(script: Array<{ body?: string; error?: Error }>) {
  const urls: string[] = [];
  let i = 0;
  const spy = vi.spyOn(https, 'get').mockImplementation(((url: string, cb: (res: unknown) => void) => {
    urls.push(String(url));
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    const req = new EventEmitter() as EventEmitter & { setTimeout: (ms: number, fn: () => void) => void; destroy: (e?: Error) => void };
    req.setTimeout = () => {};
    req.destroy = (e?: Error) => { req.emit('error', e ?? new Error('destroyed')); };
    queueMicrotask(() => {
      if (step.error) { req.emit('error', step.error); return; }
      const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; setEncoding: () => void; resume: () => void };
      res.statusCode = 200;
      res.headers = {};
      res.setEncoding = () => {};
      res.resume = () => {};
      cb(res);
      res.emit('data', step.body ?? '');
      res.emit('end');
    });
    return req as unknown as ReturnType<typeof https.get>;
  }) as unknown as typeof https.get);
  return { urls, spy };
}

describe('citationFallback retrieval (Bug 3: API key + retry + clean failure)', () => {
  let mod: FallbackModule;
  beforeEach(() => {
    delete process.env.NCBI_API_KEY;
    delete require_.cache[require_.resolve(CJS_PATH)];
    mod = require_(CJS_PATH) as FallbackModule;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.NCBI_API_KEY;
  });

  it('appends api_key to the E-utilities URL when NCBI_API_KEY is set', async () => {
    process.env.NCBI_API_KEY = 'TEST_KEY_123';
    // esummary returns no usable summary → verify fails fast after the first esummary call, but the
    // URL is still recorded with the key.
    const { urls } = installHttpStub([{ body: JSON.stringify({ result: {} }) }]);
    await mod.verifyPmidById('12345678', 'osa');
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.includes('api_key=TEST_KEY_123'))).toBe(true);
  });

  it('does NOT append api_key when NCBI_API_KEY is unset (keyless fallback still works)', async () => {
    const { urls } = installHttpStub([{ body: JSON.stringify({ result: {} }) }]);
    await mod.verifyPmidById('12345678', 'osa');
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((u) => u.includes('api_key='))).toBe(false);
  });

  it('RETRIES a transient failure then succeeds (eutil backoff)', async () => {
    // First attempt errors (timeout), second returns an empty-but-valid esummary body. The fact that
    // verifyPmidById resolves to a clean { verified:false } (not a throw) proves the retry was taken.
    const { urls } = installHttpStub([
      { error: Object.assign(new Error('timeout'), {}) },
      { body: JSON.stringify({ result: {} }) },
    ]);
    const out = await mod.verifyPmidById('12345678', 'osa');
    expect(out.verified).toBe(false);
    expect(urls.length).toBeGreaterThanOrEqual(2); // attempt 1 (error) + attempt 2 (success)
  });

  it('verifyPmidById returns a clean reason on empty PMID (never throws)', async () => {
    const out = await mod.verifyPmidById('');
    expect(out.verified).toBe(false);
    expect(out.reason).toBe('invalid_pmid');
  });
});
