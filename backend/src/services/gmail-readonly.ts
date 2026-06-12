import { gmailAccess } from './mailer.js';

// READ-ONLY Gmail pull for the case Email tab — "Live Gmail" section (ships DARK 2026-06-12).
// The Workspace domain-wide delegation grant currently covers gmail.send ONLY, so the readonly
// token mint FAILS at the token-grant step until Ryan adds the scope in admin.google.com. This
// module therefore NEVER throws to its caller: every failure degrades to {available:false, reason}
// and the route stays 200. The moment the scope is granted, the next request (after the 60s cache
// TTL) lights the feature up with NO redeploy.
//
// PHI discipline: metadata only (From/To/Subject/Date headers + Gmail's own snippet). NEVER fetch
// full bodies, NEVER persist anything, NEVER log snippets/subjects/addresses — counts only.

const READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface GmailThreadMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  otherParty: string;
  subject: string;
  snippet: string;
  date: string;
}

export type VeteranCorrespondence =
  | { available: true; messages: GmailThreadMessage[] }
  | { available: false; reason: 'workspace_scope_not_granted' | 'gmail_unreachable' };

// 60s in-process cache keyed by vetEmail (same Map-TTL idiom as mailer's readSecretByName cache).
// Degraded results are cached too — once the scope is granted, the next minute's request re-probes.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { val: VeteranCorrespondence; exp: number }>();

interface GmailHeader { name?: string; value?: string }
interface GmailMetaResponse { id?: string; snippet?: string; payload?: { headers?: GmailHeader[] } }

function header(meta: GmailMetaResponse, name: string): string {
  const lower = name.toLowerCase();
  return meta.payload?.headers?.find((h) => (h.name ?? '').toLowerCase() === lower)?.value ?? '';
}

async function fetchMeta(token: string, id: string, vetEmail: string): Promise<GmailThreadMessage> {
  const url = `${GMAIL_API}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`gmail readonly: metadata fetch failed (${r.status})`);
  const meta = (await r.json()) as GmailMetaResponse;
  const from = header(meta, 'From');
  // direction = inbound when the veteran is the sender; otherParty is the named side of the spec
  // contract (From for inbound, To for outbound) — i.e. always the non-FRN correspondent line.
  const inbound = from.toLowerCase().includes(vetEmail.toLowerCase());
  return {
    id,
    direction: inbound ? 'inbound' : 'outbound',
    otherParty: inbound ? from : header(meta, 'To'),
    subject: header(meta, 'Subject'),
    snippet: meta.snippet ?? '',
    date: header(meta, 'Date'),
  };
}

// A single RFC-addr token: no whitespace/quotes/parens/colons, exactly one @. Anything else gets
// the EMPTY result, never interpolated — a garbage intake email like `a@b.com OR from:ryan@…`
// would otherwise REWRITE the Gmail search and render unrelated veterans' correspondence into
// this case's thread (adversarial-audit finding #9).
const SAFE_EMAIL = /^[^\s()"<>:,;]+@[^\s()"<>:,;@]+\.[^\s()"<>:,;@]+$/;

// Metadata fan-out: chunked + allSettled (adversarial-audit finding #11). 50 concurrent gets
// (5 quota units each) + the list (5) lands at 255 vs Gmail's 250 units/sec/user — and one 429
// inside a bare Promise.all would reject the WHOLE thread and poison the 60s cache with
// 'gmail_unreachable'. 10-wide chunks stay far under quota; failed singles are dropped.
const META_CHUNK = 10;

async function fetchCorrespondence(vetEmail: string): Promise<VeteranCorrespondence> {
  const { token } = await gmailAccess(READONLY_SCOPE);
  const q = encodeURIComponent(`(from:${vetEmail} OR to:${vetEmail}) newer_than:2y`);
  const r = await fetch(`${GMAIL_API}/messages?q=${q}&maxResults=50`, { headers: { authorization: `Bearer ${token}` } });
  // A refresh-token-shaped credential can mint a token whose scopes DON'T include readonly (the
  // scope param can't widen a consent-time grant) — the Gmail API then 403s here. Same remedy as a
  // failed mint: the Workspace scope grant. Treat identically.
  if (r.status === 403) return { available: false, reason: 'workspace_scope_not_granted' };
  if (!r.ok) throw new Error(`gmail readonly: messages.list failed (${r.status})`);
  const list = (await r.json()) as { messages?: Array<{ id?: string }> };
  const ids = (list.messages ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
  const messages: GmailThreadMessage[] = [];
  let dropped = 0;
  for (let i = 0; i < ids.length; i += META_CHUNK) {
    const settled = await Promise.allSettled(ids.slice(i, i + META_CHUNK).map((id) => fetchMeta(token, id, vetEmail)));
    for (const s of settled) {
      if (s.status === 'fulfilled') messages.push(s.value);
      else dropped += 1;
    }
  }
  // Counts ONLY — never snippets/subjects/addresses.
  console.log(JSON.stringify({ msg: 'gmail_readonly_listed', count: messages.length, dropped }));
  return { available: true, messages };
}

/** Live read-only Gmail correspondence with a veteran (metadata + snippet only, newest 50, 2y window).
 * Never throws: degrades to {available:false} until the gmail.readonly Workspace scope is granted. */
export async function listVeteranCorrespondence(vetEmail: string): Promise<VeteranCorrespondence> {
  const key = vetEmail.trim().toLowerCase();
  // No veteran email on file → nothing to search for (and an empty address would make the Gmail
  // query match the whole mailbox). A malformed/multi-token address is treated the same — it must
  // NEVER reach the query string (finding #9). An empty, available result is the honest answer.
  if (!key || !SAFE_EMAIL.test(key)) return { available: true, messages: [] };
  const hit = cache.get(key);
  if (hit !== undefined && hit.exp > Date.now()) return hit.val;

  let result: VeteranCorrespondence;
  try {
    result = await fetchCorrespondence(key);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // mailer's gmailAccess throws 'gmail transport: token grant failed (400/401 …unauthorized_client…)'
    // while the delegation grant lacks the readonly scope.
    result = /token grant failed|unauthorized/i.test(msg)
      ? { available: false, reason: 'workspace_scope_not_granted' }
      : { available: false, reason: 'gmail_unreachable' };
    // Counts/reasons only — the error message from our own stack carries no PHI, but keep it terse.
    console.log(JSON.stringify({ msg: 'gmail_readonly_degraded', reason: result.reason }));
  }
  cache.set(key, { val: result, exp: Date.now() + CACHE_TTL_MS });
  return result;
}

// ── FULL MESSAGE BODY (Ryan 2026-06-12) — authenticated, role-gated read of ONE message's full body
// for the case Email tab bubble view. This DOES fetch the body (the metadata-only discipline above is
// for the cheap thread LIST). It stays PHI-safe: the caller is an authorized EMR user, the body is
// NEVER persisted and NEVER logged (counts only), and we verify the veteran is a party to the message
// before returning it — a staffer can't read an arbitrary mailbox message by guessing an id (audit #9).
interface GmailPart { mimeType?: string; body?: { data?: string }; parts?: GmailPart[] }

function decodeB64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
// Walk the MIME tree for the first body of the wanted type. text/plain is preferred across the WHOLE
// tree before falling back to (stripped) text/html.
function collectByMime(part: GmailPart | undefined, wanted: string): string {
  if (!part) return '';
  if ((part.mimeType ?? '').startsWith(wanted) && part.body?.data) return decodeB64Url(part.body.data);
  for (const p of part.parts ?? []) { const t = collectByMime(p, wanted); if (t) return t; }
  return '';
}

export type GmailMessageBody =
  | { available: true; body: string }
  | { available: false; reason: 'workspace_scope_not_granted' | 'gmail_unreachable' | 'not_party' };

const MAX_BODY_CHARS = 50_000;

/** Full body of ONE Gmail message, gated on the veteran being a party. Never throws; never logs the body. */
export async function fetchMessageBody(messageId: string, vetEmail: string): Promise<GmailMessageBody> {
  const key = vetEmail.trim().toLowerCase();
  if (!key || !SAFE_EMAIL.test(key)) return { available: false, reason: 'not_party' };
  try {
    const { token } = await gmailAccess(READONLY_SCOPE);
    const r = await fetch(`${GMAIL_API}/messages/${encodeURIComponent(messageId)}?format=full`, { headers: { authorization: `Bearer ${token}` } });
    if (r.status === 403) return { available: false, reason: 'workspace_scope_not_granted' };
    if (!r.ok) return { available: false, reason: 'gmail_unreachable' };
    const msg = (await r.json()) as { payload?: GmailPart & { headers?: GmailHeader[] } };
    // Cross-veteran guard (audit #9): the veteran must be From or To on this message.
    const headers = msg.payload?.headers ?? [];
    const from = (headers.find((h) => (h.name ?? '').toLowerCase() === 'from')?.value ?? '').toLowerCase();
    const to = (headers.find((h) => (h.name ?? '').toLowerCase() === 'to')?.value ?? '').toLowerCase();
    if (!from.includes(key) && !to.includes(key)) return { available: false, reason: 'not_party' };
    const plain = collectByMime(msg.payload, 'text/plain');
    const body = (plain || stripHtml(collectByMime(msg.payload, 'text/html'))).slice(0, MAX_BODY_CHARS);
    console.log(JSON.stringify({ msg: 'gmail_readonly_body_fetched', chars: body.length })); // count ONLY — never the body
    return { available: true, body };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { available: false, reason: /token grant failed|unauthorized/i.test(m) ? 'workspace_scope_not_granted' : 'gmail_unreachable' };
  }
}
