/**
 * Google Ads offline click conversion upload — fires when the $50 review payment is confirmed.
 *
 * Uses the Data Manager API (ConversionUploadService is deprecated for new accounts as of 2025).
 * Credentials are stored in Secrets Manager under the name in GOOGLE_ADS_SECRET_NAME.
 * Secret value is a JSON object: { developer_token, client_id, client_secret, refresh_token }
 *
 * ALWAYS fire-and-forget. Never throws to caller. A failed upload is logged but never blocks
 * the Stripe webhook response or the payment record.
 */

import { readSecretByName } from './mailer.js';
import type { AppDb } from './db-types.js';

const CUSTOMER_ID         = '9775308437';           // FRN ad account 977-530-8437 (no dashes)
const CONVERSION_ACTION_ID = '7664449375';           // "Nexus Letter Intake" — created 2026-06-27
const DATA_MANAGER_BASE    = 'https://datamanager.googleapis.com';

// ── Types ──────────────────────────────────────────────────────────────────────

interface GoogleAdsCreds {
  developer_token: string;
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

// ── Credential cache (cold-start load, 55-min refresh) ───────────────────────

let _creds: GoogleAdsCreds | null = null;
let _credsLoadedAt = 0;
const CREDS_TTL_MS = 55 * 60 * 1000;

async function getCreds(): Promise<GoogleAdsCreds> {
  const now = Date.now();
  if (_creds && (now - _credsLoadedAt) < CREDS_TTL_MS) return _creds;
  const raw = await readSecretByName(process.env.GOOGLE_ADS_SECRET_NAME);
  _creds = JSON.parse(raw) as GoogleAdsCreds;
  _credsLoadedAt = now;
  return _creds;
}

// ── OAuth token exchange ──────────────────────────────────────────────────────

async function getAccessToken(creds: GoogleAdsCreds): Promise<string> {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const data = await r.json() as { access_token?: string; error?: string; error_description?: string };
  if (!data.access_token) {
    throw new Error(`Google OAuth failed: ${data.error_description ?? data.error ?? 'unknown'}`);
  }
  return data.access_token;
}

// ── gclid extraction from Intake rawAnswersJson ───────────────────────────────

type RawAnswer = { name?: string; answer?: unknown };

export async function extractGclidForCase(db: AppDb, caseId: string): Promise<string | null> {
  // The Intake row is linked to the case via assignedCaseId. rawAnswersJson holds all Jotform
  // fields including s1_gclid (the hidden field the intake.html bridge appends to the Jotform URL).
  const intake = await (db as unknown as {
    intake: { findFirst: (q: { where: Record<string, unknown>; select: Record<string, boolean> }) => Promise<{ rawAnswersJson?: unknown } | null> }
  }).intake.findFirst({
    where: { assignedCaseId: caseId },
    select: { rawAnswersJson: true },
  });
  if (!intake?.rawAnswersJson || typeof intake.rawAnswersJson !== 'object') return null;

  for (const a of Object.values(intake.rawAnswersJson as Record<string, RawAnswer>)) {
    const name = (a.name ?? '').toLowerCase();
    if ((name === 's1_gclid' || name === 'gclid') && typeof a.answer === 'string' && a.answer.trim()) {
      return a.answer.trim();
    }
  }
  return null;
}

// ── Conversion upload ──────────────────────────────────────────────────────────

export async function uploadReviewConversion(
  db: AppDb,
  caseId: string,
  paymentAt: Date,
): Promise<void> {
  const gclid = await extractGclidForCase(db, caseId);
  if (!gclid) {
    // No gclid on this case — organic/direct intake, no conversion to upload. Not an error.
    console.log(`[google-ads] caseId=${caseId} no gclid — skipping conversion upload`);
    return;
  }

  const creds = await getCreds();
  const accessToken = await getAccessToken(creds);

  const r = await fetch(`${DATA_MANAGER_BASE}/v1/events:ingest`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      destinations: [{
        operatingAccount: { accountId: CUSTOMER_ID, accountType: 'GOOGLE_ADS' },
        productDestinationId: CONVERSION_ACTION_ID,
      }],
      events: [{
        adIdentifiers: { gclid },
        eventTimestamp: paymentAt.toISOString(),
        eventName: 'purchase',
        conversionValue: 50.0,
        currency: 'USD',
        eventSource: 'WEB',
      }],
    }),
  });

  const body = await r.json() as Record<string, unknown>;
  if (!r.ok) {
    throw new Error(`Data Manager API ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
  }
  const requestId = (body as { requestId?: string }).requestId ?? '(no-id)';
  console.log(`[google-ads] caseId=${caseId} gclid=${gclid.slice(0, 12)}… conversion uploaded requestId=${requestId}`);
}
