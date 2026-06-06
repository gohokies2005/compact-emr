import { env } from '../env';

// PUBLIC delivery-portal calls (Ryan 2026-06-06). The veteran is NOT logged in, so these use a RAW
// fetch — no Cognito header, and no shared response-interceptor that would redirect a 401 to /signin
// (a wrong password must just say "incorrect password"). Separate from the authed api/delivery.ts.
const base = env.apiBaseUrl.replace(/\/$/, '');

export async function checkDeliveryToken(token: string): Promise<{ valid: boolean; expired?: boolean }> {
  try {
    const r = await fetch(`${base}/api/v1/delivery/${encodeURIComponent(token)}`);
    if (r.status === 404) return { valid: false };
    const j = await r.json();
    return (j?.data as { valid: boolean; expired?: boolean }) ?? { valid: false };
  } catch {
    return { valid: false };
  }
}

export type UnlockResult = { ok: true; url: string } | { ok: false; status: number; message: string };

export async function unlockDelivery(token: string, password: string): Promise<UnlockResult> {
  let r: Response;
  try {
    r = await fetch(`${base}/api/v1/delivery/${encodeURIComponent(token)}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
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
