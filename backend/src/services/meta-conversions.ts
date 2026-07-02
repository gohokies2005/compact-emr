/**
 * Meta (Facebook) Conversions API — offline Purchase upload, fires when the $50 review payment is
 * confirmed (the paid-intake → case assign). Server-to-server mirror of google-ads-conversions.ts.
 *
 * Sends the $50 intake as a `Purchase` event to the FRN pixel via the CAPI /events endpoint, matched
 * by fbc (built from the s1_fbclid captured on the landing page). This is how Meta (a) reports true
 * cost-per-intake for Facebook and (b) can optimize campaigns toward veterans who actually pay,
 * instead of the cheapest scroll-stops.
 *
 * Credentials in Secrets Manager under META_CAPI_SECRET_NAME. Secret value is JSON:
 *   { pixel_id, access_token }
 *
 * Throws on failure — callers must catch (intakes.ts wraps it so a Meta outage can never break the
 * assign). A 3-second abort guard prevents a hung Meta endpoint from wedging the request.
 *
 * PRIVACY (mirrors google-ads-conversions.ts): we send the fbclid-derived `fbc` ONLY. We deliberately
 * do NOT send the veteran's email/phone (even hashed). A hashed email is a match identifier Meta
 * resolves back to the person, which would tie a named individual to "completed a VA-disability
 * nexus-letter intake" — a health-context identifier we will not hand to an ad platform. fbc is a
 * direct click identifier, sufficient when present. Match rate is lower than with email; revisit ONLY
 * with an explicit decision to accept that tradeoff.
 */

import { readSecretByName } from './mailer.js';
import type { AppDb } from './db-types.js';

const GRAPH_BASE       = 'https://graph.facebook.com/v21.0';
const FETCH_TIMEOUT_MS = 3000; // abort a hung Meta endpoint before it wedges the request

// ── Types ──────────────────────────────────────────────────────────────────────

interface MetaCapiCreds {
  pixel_id: string;
  access_token: string;
}

// ── Credential cache (cold-start load, 55-min refresh) ───────────────────────

let _creds: MetaCapiCreds | null = null;
let _credsLoadedAt = 0;
const CREDS_TTL_MS = 55 * 60 * 1000;

async function getCreds(): Promise<MetaCapiCreds> {
  const now = Date.now();
  if (_creds && (now - _credsLoadedAt) < CREDS_TTL_MS) return _creds;
  const raw = await readSecretByName(process.env.META_CAPI_SECRET_NAME);
  _creds = JSON.parse(raw) as MetaCapiCreds;
  _credsLoadedAt = now;
  return _creds;
}

function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ── fbclid extraction from Intake rawAnswersJson ───────────────────────────────

type RawAnswer = { name?: string; answer?: unknown };

export async function extractFbclidForCase(db: AppDb, caseId: string): Promise<string | null> {
  // Mirror of extractGclidForCase: the Intake row links to the case via assignedCaseId; rawAnswersJson
  // holds the Jotform fields including s1_fbclid (the hidden field the intake.html bridge appends).
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
    if ((name === 's1_fbclid' || name === 'fbclid') && typeof a.answer === 'string' && a.answer.trim()) {
      return a.answer.trim();
    }
  }
  return null;
}

// ── Conversion upload (fbc-only — see PRIVACY note in the file header) ──────────

export async function uploadReviewConversionMeta(
  db: AppDb,
  caseId: string,
  paymentAt: Date,
): Promise<void> {
  const fbclid = await extractFbclidForCase(db, caseId);
  if (!fbclid) {
    // No fbclid — not a Facebook click (organic/direct or a Google click). Not an error.
    console.log(`[meta-capi] caseId=${caseId} no fbclid — skipping`);
    return;
  }

  const creds = await getCreds();
  const eventTime = Math.floor(paymentAt.getTime() / 1000);
  // fbc format: fb.1.<creation_unix_ms>.<fbclid>. Meta matches primarily on the fbclid; the timestamp
  // is when the click id was observed (payment time here is within Meta's tolerance).
  const fbc = `fb.1.${paymentAt.getTime()}.${fbclid}`;

  const event = {
    event_name: 'Purchase',
    event_time: eventTime,
    action_source: 'website',
    // Deterministic per case → Meta dedups a re-fire (and a future browser pixel with the same id).
    event_id: `frn-intake-${caseId}`,
    event_source_url: 'https://www.flatratenexus.com/intake',
    user_data: { fbc },
    custom_data: { value: 50.0, currency: 'USD' },
  };

  const r = await timedFetch(
    `${GRAPH_BASE}/${creds.pixel_id}/events?access_token=${encodeURIComponent(creds.access_token)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [event] }),
    },
  );

  const body = await r.json() as {
    events_received?: number;
    messages?: unknown[];
    fbtrace_id?: string;
    error?: { message?: string };
  };

  if (!r.ok || body.error) {
    throw new Error(`Meta CAPI ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }

  // events_received:1 = accepted. messages[] carries non-fatal warnings (e.g. low match quality) —
  // surface them so a silent-zero (accepted but never attributed) is visible in CloudWatch.
  const received = body.events_received ?? 0;
  const warnings = Array.isArray(body.messages) && body.messages.length ? ` warnings=${JSON.stringify(body.messages).slice(0, 200)}` : '';
  console.log(`[meta-capi] caseId=${caseId} fbclid=${fbclid.slice(0, 16)}… events_received=${received} requestId=${body.fbtrace_id ?? '(none)'}${warnings}`);
}
