/**
 * Google Ads offline click conversion upload — fires when the $50 review payment is confirmed.
 *
 * Uses the Data Manager API (ConversionUploadService is deprecated for new accounts as of 2025).
 * Credentials are stored in Secrets Manager under the name in GOOGLE_ADS_SECRET_NAME.
 * Secret value is a JSON object: { developer_token, client_id, client_secret, refresh_token }
 *
 * Throws on failure — callers must catch. The Stripe webhook awaits this and catches it so
 * the Lambda context doesn't freeze with a dangling promise (fire-and-forget is unsafe on Lambda).
 * A 3-second abort guard prevents a hung Google endpoint from wedging the webhook past Stripe's
 * 30-second timeout.
 */

import { readSecretByName } from './mailer.js';
import type { AppDb } from './db-types.js';

// FRN ad account 3654279964 (where the conversion action lives).
// The MCC is 9775308437 — the conversion action was created on the CHILD account, not the MCC.
const AD_ACCOUNT_ID        = '3654279964';
const CONVERSION_ACTION_ID = '7664449375'; // "Nexus Letter Intake" — created 2026-06-27
const DATA_MANAGER_BASE    = 'https://datamanager.googleapis.com';
const FETCH_TIMEOUT_MS     = 3000; // abort a hung Google endpoint before it wedges the Stripe webhook

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

function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ── OAuth token exchange ──────────────────────────────────────────────────────

async function getAccessToken(creds: GoogleAdsCreds): Promise<string> {
  const r = await timedFetch('https://oauth2.googleapis.com/token', {
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
  // orderBy: createdAt desc — if a veteran resubmits and has two intake rows, use the newest.
  const intake = await (db as unknown as {
    intake: {
      findFirst: (q: {
        where: Record<string, unknown>;
        select: Record<string, boolean>;
        orderBy: Record<string, string>;
      }) => Promise<{ rawAnswersJson?: unknown } | null>;
    }
  }).intake.findFirst({
    where: { assignedCaseId: caseId },
    select: { rawAnswersJson: true },
    orderBy: { createdAt: 'desc' },
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
    // No gclid — organic/direct intake. Not an error; the majority of intakes are direct.
    console.log(`[google-ads] caseId=${caseId} no gclid — skipping`);
    return;
  }

  const creds = await getCreds();
  const accessToken = await getAccessToken(creds);

  const r = await timedFetch(`${DATA_MANAGER_BASE}/v1/events:ingest`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      destinations: [{
        operatingAccount: { accountId: AD_ACCOUNT_ID, accountType: 'GOOGLE_ADS' },
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
    throw new Error(`Data Manager API ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }

  // Parse per-event results — the Data Manager API returns 200 even for per-event rejections
  // (e.g., gclid not in Google's index, outside attribution window). Log them explicitly so a
  // silent-zero situation is visible in CloudWatch rather than appearing as success.
  const status = (body as { requestStatusPerDestination?: unknown }).requestStatusPerDestination;
  const requestId = (body as { requestId?: string }).requestId ?? '(no-id)';
  if (status) {
    console.log(`[google-ads] caseId=${caseId} gclid=${gclid.slice(0, 12)}… requestId=${requestId} perDestStatus=${JSON.stringify(status).slice(0, 200)}`);
  } else {
    console.log(`[google-ads] caseId=${caseId} gclid=${gclid.slice(0, 12)}… requestId=${requestId} accepted`);
  }
}
