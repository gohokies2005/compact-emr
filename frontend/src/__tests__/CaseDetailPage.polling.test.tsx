import { describe, expect, it } from 'vitest';
import { decidePollIntervalMs } from '../routes/cases/CaseDetailPage';

// Phase 8.1 G2 (RN self-service audit): tests the EXTRACTED pure decider for polling
// interval. The full component-level polling behavior (refetchInterval + visibility-change
// pause) is verified post-deploy via Vite dev server; fake-timers + React Query are
// chronically flaky together. The decider IS the entire polling decision: if its return
// value is correct, the React Query options are correct.

describe('decidePollIntervalMs', () => {
  it('returns 8000ms for pre-draft case statuses', () => {
    expect(decidePollIntervalMs('records')).toBe(8000);
    expect(decidePollIntervalMs('viability')).toBe(8000);
    expect(decidePollIntervalMs('drafting')).toBe(8000);
  });

  it('returns false (stop polling) for post-draft case statuses', () => {
    expect(decidePollIntervalMs('physician_review')).toBe(false);
    expect(decidePollIntervalMs('correction_requested')).toBe(false);
    expect(decidePollIntervalMs('correction_review')).toBe(false);
    expect(decidePollIntervalMs('delivered')).toBe(false);
    expect(decidePollIntervalMs('paid')).toBe(false);
    expect(decidePollIntervalMs('rejected')).toBe(false);
  });

  it('returns false for intake and undefined status', () => {
    expect(decidePollIntervalMs('intake')).toBe(false);
    expect(decidePollIntervalMs(undefined)).toBe(false);
  });
});
