import { env } from '../env';

// PUBLIC delivery-portal calls (Ryan 2026-06-06; identity-unlock 2026-06-11). The veteran is NOT
// logged in, so these use a RAW fetch — no Cognito header, and no shared response-interceptor that
// would redirect a 401 to /signin (a wrong answer must just say so). Separate from the authed
// api/delivery.ts.
const base = env.apiBaseUrl.replace(/\/$/, '');

export type DeliveryMode = 'identity' | 'password';

export async function checkDeliveryToken(
  token: string,
): Promise<{ valid: boolean; expired?: boolean; locked?: boolean; mode?: DeliveryMode }> {
  try {
    const r = await fetch(`${base}/api/v1/delivery/${encodeURIComponent(token)}`);
    if (r.status === 404) return { valid: false };
    const j = await r.json();
    return (j?.data as { valid: boolean; expired?: boolean; locked?: boolean; mode?: DeliveryMode }) ?? { valid: false };
  } catch {
    return { valid: false };
  }
}

export type UnlockResult = { ok: true; url: string } | { ok: false; status: number; message: string };

// Identity mode sends {dob, phoneLast4}; legacy password mode sends {password}.
export type UnlockInput = { dob: string; phoneLast4: string } | { password: string };

export async function unlockDelivery(token: string, input: UnlockInput): Promise<UnlockResult> {
  let r: Response;
  try {
    r = await fetch(`${base}/api/v1/delivery/${encodeURIComponent(token)}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, status: 0, message: 'Could not reach the server. Please try again.' };
  }
  if (r.ok) {
    const j = await r.json();
    return { ok: true, url: (j?.data?.url as string) ?? '' };
  }
  let message = 'Could not open the letter.';
  try { const j = await r.json(); if (typeof j?.error === 'string') message = j.error; } catch { /* keep default */ }
  return { ok: false, status: r.status, message };
}
