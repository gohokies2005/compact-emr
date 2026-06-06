import { createHash } from 'node:crypto';

// Feature B — email→veteran matching (Ryan 2026-06-06). Inbound emails are matched to a veteran by
// address. SAFE by design: normalize both sides; consider only the NON-FRN party (From+To+Cc minus our
// monitored mailboxes); and NEVER auto-assign when >1 veteran shares an address (PHI mis-route risk) —
// those drop to the unmatched queue for an RN to resolve. Pure functions → unit-testable; the DB lookup
// is injected so the Lambda/route stays thin.

/** `"John Doe" <John.Doe+tag@Example.com>` → `john.doe@example.com`. Returns '' if no usable address. */
export function normalizeEmailAddress(raw: string): string {
  if (typeof raw !== 'string') return '';
  const angle = /<([^>]+)>/.exec(raw);
  let addr = (angle ? angle[1]! : raw).trim().toLowerCase().replace(/^["'\s]+|["'\s]+$/g, '');
  const at = addr.lastIndexOf('@');
  if (at < 0) return '';
  let local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  const plus = local.indexOf('+'); // strip +sub-addressing
  if (plus >= 0) local = local.slice(0, plus);
  if (!local || !domain) return '';
  return `${local}@${domain}`;
}

export interface AddressMatchInput {
  readonly from: string;
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly frnAddresses: readonly string[]; // monitored mailboxes / our senders to exclude
}

/** The candidate (non-FRN) normalized addresses on a message — From + To + Cc minus our own. */
export function candidateAddresses(input: AddressMatchInput): string[] {
  const frn = new Set(input.frnAddresses.map(normalizeEmailAddress).filter(Boolean));
  const all = [input.from, ...(input.to ?? []), ...(input.cc ?? [])].map(normalizeEmailAddress).filter(Boolean);
  const out: string[] = [];
  for (const a of all) if (!frn.has(a) && !out.includes(a)) out.push(a);
  return out;
}

export type VeteranMatch =
  | { readonly status: 'matched'; readonly veteranId: string; readonly matchedAddress: string }
  | { readonly status: 'unmatched'; readonly reason: string };

/**
 * Decide the veteran for a set of candidate addresses. `lookup` returns the veterans whose
 * (normalized) email matches a given address. Policy: a single distinct veteran across the matched
 * addresses → matched; an address shared by >1 veteran, or addresses mapping to different veterans,
 * or no match → UNMATCHED (we never guess which patient — honors the wrong-patient rule).
 */
export function decideVeteranMatch(
  candidates: readonly string[],
  lookup: (normalizedAddress: string) => readonly { id: string }[],
): VeteranMatch {
  const hits = new Map<string, string>(); // veteranId -> the address that matched it
  let ambiguousAddress: string | null = null;
  for (const addr of candidates) {
    const distinct = [...new Set(lookup(addr).map((v) => v.id))];
    if (distinct.length > 1) { ambiguousAddress = addr; continue; }
    if (distinct.length === 1) hits.set(distinct[0]!, addr);
  }
  const ids = [...hits.keys()];
  if (ids.length === 1) return { status: 'matched', veteranId: ids[0]!, matchedAddress: hits.get(ids[0]!)! };
  if (ids.length > 1) return { status: 'unmatched', reason: 'addresses on the message map to different veterans' };
  if (ambiguousAddress) return { status: 'unmatched', reason: `multiple veterans share ${ambiguousAddress}` };
  return { status: 'unmatched', reason: 'no veteran matches any address on the message' };
}

/**
 * Deterministic email id from the RFC Message-ID. Both the S3 prefix (emails/<id>/) and the DB row id
 * derive from this, so storage + row are idempotent in one stroke — a retry overwrites the same prefix
 * and the same PK rather than orphaning objects or duplicating rows (architect C4). Lambda + backend
 * MUST compute this identically (the staged Lambda replicates it in Node — workers/gmail-ingest/handler.mjs).
 */
export function deriveEmailId(messageId: string): string {
  return `eml_${createHash('sha256').update(messageId).digest('hex').slice(0, 32)}`;
}

/** first ~140 chars, whitespace-collapsed, for the collapsed log row. */
export function makeSnippet(body: string, max = 140): string {
  const s = (body ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
