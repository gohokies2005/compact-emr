// quoClient.ts — Quo (formerly OpenPhone) transport for FRN customer SMS + contacts (EMR port).
//
// Faithful TypeScript port of flatratenexus-project/app/services/quoClient.js. Purpose:
// fire-and-forget transactional texts to FRN customers ("your letter is ready", "we have a question")
// and sync contacts (name/phone/case#) so an inbound call/text is identified for the RNs.
//
// DESIGN (load-bearing — do NOT weaken):
//  - sendSms NEVER throws and is fire-and-forget: a bad/landline number, an unverified campaign, or Quo
//    being down returns {sent:false, reason} — it must NEVER block letter delivery or payment. Every
//    caller in the EMR (delivery /send, case-create contact sync) treats this as strictly additive.
//  - Auth: the RAW API key in the Authorization header (NOT Bearer). Base https://api.quo.com/v1.
//  - EMR KEY RESOLUTION (the one difference from the FRN Node version): the API key is a Secrets Manager
//    secret read at RUNTIME by FRIENDLY NAME via mailer.readSecretByName(QUO_API_KEY_SECRET_NAME), with a
//    process.env.QUO_API_KEY fallback for local/dev. We do NOT add a module-level key cache: readSecretByName
//    ALREADY has a 60s TTL cache and never caches empties/errors — a second cache layer here would (a) pin the
//    random CDK placeholder value forever if resolved before the operator populates the secret, and (b) pin a
//    rotated-out key. So resolveApiKey() reads through readSecretByName on every call (cheap, TTL-cached). A
//    failed secret read degrades to {sent:false, reason:'no_api_key'} — the never-throws contract holds.
//  - SOCKET TIMEOUT: every Quo request is bound to an 8s socket timeout (r.setTimeout → destroy → 'error').
//    Node https has NO default socket timeout, so a black-holed connection would otherwise leave the awaited
//    Promise pending forever and hang the caller's HTTP response up to the Lambda's 120s ceiling — which would
//    turn a committed delivery into a 5xx the RN sees. The timeout makes a hung socket resolve {sent:false}.
//  - From number: process.env.QUO_FROM || the FRN 757 number.
//  - US SMS requires Quo's 10DLC registration to be APPROVED before anything delivers; until then sendSms
//    returns a non-2xx reason (expected). Contacts work immediately.
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { readSecretByName } from './mailer.js';

const HOST = 'api.quo.com';
const REQUEST_TIMEOUT_MS = 8000;

function fromNumber(): string {
  return process.env.QUO_FROM ?? '+17575401077';
}

// Read the key through readSecretByName (60s TTL, fail-soft, never caches empties) on every call — NO extra
// module cache (see header note: it would pin the CDK placeholder or a rotated key). env fallback for dev.
async function resolveApiKey(): Promise<string> {
  let k = '';
  try {
    k = (await readSecretByName(process.env.QUO_API_KEY_SECRET_NAME)) || '';
  } catch {
    k = '';
  }
  if (!k) k = process.env.QUO_API_KEY ?? '';
  return k;
}

/** TEST-ONLY: retained as a no-op (there is no module key cache anymore; readSecretByName owns caching). */
export function __resetKeyCacheForTests(): void {
  /* no-op — key caching now lives entirely in readSecretByName's TTL cache */
}

/** Normalize a US phone to E.164, or null if it isn't a plausible US number (skip silently). */
export function toE164(p: string | null | undefined): string | null {
  if (!p) return null;
  let d = String(p).replace(/[^\d]/g, '');
  if (d.length === 10) d = '1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return null;
}

interface RawResponse {
  code: number;
  json: unknown;
  raw: string;
  error?: string;
}

function request(method: string, path: string, body: unknown, apiKey: string): Promise<RawResponse> {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers: Record<string, string> = {
      Authorization: apiKey || '',
      'Content-Type': 'application/json',
    };
    if (data) headers['Content-Length'] = String(Buffer.byteLength(data));
    const opts: https.RequestOptions = { hostname: HOST, path: '/v1' + path, method, headers };
    const r = https.request(opts, (x: IncomingMessage) => {
      let d = '';
      x.on('data', (c) => { d += c; });
      x.on('end', () => {
        let j: unknown = null;
        try { j = JSON.parse(d); } catch { /* non-JSON body — leave j null */ }
        resolve({ code: x.statusCode ?? 0, json: j, raw: d });
      });
    });
    r.on('error', (e: Error) => resolve({ code: 0, json: null, raw: '', error: e.message }));
    // Node https has NO default socket timeout — bind one so a black-holed Quo endpoint resolves as a failure
    // instead of leaving the awaited Promise (and the caller's HTTP response) pending to the Lambda ceiling.
    // destroy(err) triggers the 'error' handler above → resolve({code:0}); never rejects, never hangs.
    r.setTimeout(REQUEST_TIMEOUT_MS, () => r.destroy(new Error('quo_request_timeout')));
    if (data) r.write(data);
    r.end();
  });
}

function extractDetail(r: RawResponse): string {
  const j = r.json as { message?: unknown; errors?: unknown } | null;
  if (j && typeof j.message === 'string') return j.message;
  if (j && j.errors !== undefined) return JSON.stringify(j.errors);
  return (r.raw || '').slice(0, 160);
}

export interface SendSmsResult {
  sent: boolean;
  reason?: string;
  id?: string;
  code?: number;
  detail?: string;
}

/** Fire-and-forget SMS. NEVER throws. */
export async function sendSms(to: string | null | undefined, content: string): Promise<SendSmsResult> {
  try {
    const apiKey = await resolveApiKey();
    if (!apiKey) return { sent: false, reason: 'no_api_key' };
    const e164 = toE164(to);
    if (!e164) return { sent: false, reason: 'invalid_number' };
    const r = await request('POST', '/messages', { from: fromNumber(), to: [e164], content }, apiKey);
    if (r.code >= 200 && r.code < 300) {
      const j = r.json as { id?: string } | null;
      return { sent: true, id: j?.id, code: r.code };
    }
    if (r.code === 0) return { sent: false, reason: 'network', detail: r.error ?? extractDetail(r) };
    return { sent: false, reason: 'http_' + r.code, detail: extractDetail(r) };
  } catch (e) {
    return { sent: false, reason: 'exception', detail: e instanceof Error ? e.message : String(e) };
  }
}

export interface CreateContactInput {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  email?: string | null;
  role?: string | null;
  source?: string;
  externalId?: string;
  // Quo expects customFields as an ARRAY of {name,value}; an object is accepted and converted. NOTE:
  // each custom field must already be DEFINED in the Quo workspace before it can be set via API — the
  // EMR case-create sync passes NONE (the workspace fields aren't defined yet; passing them 400s).
  customFields?: Array<{ name: string; value: string }> | Record<string, string>;
}

export interface ContactResult {
  ok: boolean;
  reason?: string;
  id?: string | null;
  code?: number;
  detail?: string;
}

/** Create an integration contact (read-only in the Quo app; the EMR stays source of truth). Never throws. */
export async function createContact(input: CreateContactInput = {}): Promise<ContactResult> {
  try {
    const apiKey = await resolveApiKey();
    if (!apiKey) return { ok: false, reason: 'no_api_key' };
    const e164 = toE164(input.phone);
    const defaultFields: Record<string, unknown> = {
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      role: input.role ?? null,
      phoneNumbers: e164 ? [{ name: 'cell', value: e164 }] : [],
      emails: input.email ? [{ name: 'email', value: input.email }] : [],
    };
    const body: Record<string, unknown> = { defaultFields };
    if (input.source) body.source = input.source;
    if (input.externalId) body.externalId = input.externalId;
    if (Array.isArray(input.customFields) && input.customFields.length) {
      body.customFields = input.customFields;
    } else if (input.customFields && typeof input.customFields === 'object') {
      const arr = Object.entries(input.customFields).map(([name, value]) => ({ name, value }));
      if (arr.length) body.customFields = arr;
    }
    const r = await request('POST', '/contacts', body, apiKey);
    if (r.code >= 200 && r.code < 300) {
      const j = r.json as { data?: { id?: string }; id?: string } | null;
      return { ok: true, id: (j?.data?.id ?? j?.id) ?? null, code: r.code };
    }
    if (r.code === 0) return { ok: false, reason: 'network', detail: r.error ?? extractDetail(r) };
    return { ok: false, reason: 'http_' + r.code, detail: extractDetail(r) };
  } catch (e) {
    return { ok: false, reason: 'exception', detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteContact(id: string): Promise<{ ok: boolean; code?: number; detail?: string }> {
  try {
    const apiKey = await resolveApiKey();
    if (!apiKey) return { ok: false };
    const r = await request('DELETE', '/contacts/' + id, null, apiKey);
    return { ok: r.code >= 200 && r.code < 300, code: r.code };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── FRN message templates (transactional, with STOP) ──
export function letterReadyText(): string {
  return 'Flat Rate Nexus: your nexus letter is complete and ready. Please check your email (and your spam folder) for the payment link to receive your signed letter. This text line isn’t monitored — for any questions or issues, just email info@flatratenexus.com and we’ll be happy to help. Reply STOP to opt out.';
}

export function needInfoText(): string {
  return 'Flat Rate Nexus: we have a question we need answered to finish your letter. Please check your email and reply, or contact info@flatratenexus.com. Reply STOP to opt out.';
}
