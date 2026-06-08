// Pure, separately-unit-tested helpers for the staff-messaging backend (build chunk 2, folded into
// chunk 3). NO I/O here — every function is a pure transform over plain data so the route layer can
// be reasoned about and tested in isolation. The router does the DB reads and feeds the rows in.
import type { StaffMessageRecipientRecord } from './db-types.js';

/**
 * Defensive S3-key validator for staff-message attachments. Mirrors isCaseDocumentS3Key /
 * isLetterRevisionS3Key in s3-key-safety.ts: the presign endpoint computes the canonical key
 * server-side and the client must echo the SAME key back on register. Without this, a leaked
 * staff token could register an attachment row pointing at any phiBucket key and download it via
 * the participant-gated GET endpoint.
 *
 * Canonical shape: message-attachments/<uuid>/<uuid>-<sanitizedFilename>
 *   - first segment = a randomUUID() folder (one per upload, lowercase hex)
 *   - filename portion sanitized to [a-zA-Z0-9._-] (matches the documents.ts sanitizer)
 */
const MAX_KEY_LENGTH = 500;

export function isStaffMessageAttachmentS3Key(s3Key: unknown): s3Key is string {
  if (typeof s3Key !== 'string') return false;
  if (s3Key.length === 0 || s3Key.length > MAX_KEY_LENGTH) return false;
  if (s3Key.startsWith('/')) return false;
  if (s3Key.includes('..')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\\]/.test(s3Key)) return false;
  return /^message-attachments\/[a-f0-9-]+\/[a-f0-9-]+-[a-zA-Z0-9._-]+$/.test(s3Key);
}

// ── Recipient / role-alias resolution ────────────────────────────────────────────────────────────
export type RoleAlias = 'all_rns' | 'all_physicians' | 'admin';

export function isRoleAlias(value: unknown): value is RoleAlias {
  return value === 'all_rns' || value === 'all_physicians' || value === 'admin';
}

export interface ActiveMember {
  /** Cognito sub — the cross-role identity key. */
  readonly sub: string;
  /** Which alias pool this member belongs to (for expansion). */
  readonly alias: RoleAlias;
}

/**
 * Resolve a role alias to the set of active recipient subs, given the active-member pool the
 * router fetched (active ops_staff appUsers = all_rns, active admin appUsers = admin, active
 * physicians = all_physicians). Pure: the router supplies `members`; this just filters + de-dups.
 */
export function resolveRoleAlias(alias: RoleAlias, members: readonly ActiveMember[]): string[] {
  const subs = members.filter((m) => m.alias === alias).map((m) => m.sub);
  return [...new Set(subs)].filter((s) => s.length > 0);
}

export type RecipientKind = 'to' | 'cc';
export interface RawRecipient {
  /** Either an explicit individual sub OR a role alias. */
  readonly sub?: unknown;
  readonly alias?: unknown;
  readonly kind?: unknown;
}
export interface ResolvedRecipient {
  readonly sub: string;
  readonly kind: RecipientKind;
}

export interface ExpandRecipientsResult {
  /** Deduped recipient rows to snapshot (author excluded). 'to' wins over 'cc' on a conflict. */
  readonly recipients: readonly ResolvedRecipient[];
  /** True when, after expansion + author-exclusion, no recipient remains (self-only send). */
  readonly selfOnly: boolean;
  /** True when at least one resolved recipient is kind 'to' (≥1 'to' required). */
  readonly hasTo: boolean;
}

/**
 * Expand a mixed list of explicit subs + role aliases into a deduped, author-excluded recipient
 * set. The author is ALWAYS an implicit participant and is never an unread-recipient of their own
 * message, so they are filtered out of the explicit recipient set here. 'to' beats 'cc' if the
 * same sub appears as both.
 *
 * `aliasExpander` is supplied by the caller (closes over the active-member pool) so this stays pure
 * and synchronous; pass `(alias) => resolveRoleAlias(alias, members)`.
 */
export function expandRecipients(
  raw: readonly RawRecipient[],
  authorSub: string,
  aliasExpander: (alias: RoleAlias) => readonly string[],
): ExpandRecipientsResult {
  const byKind = new Map<string, RecipientKind>();
  const addOne = (sub: string, kind: RecipientKind) => {
    if (sub.length === 0 || sub === authorSub) return; // author is implicit, never a recipient row
    const existing = byKind.get(sub);
    // 'to' is the stronger kind — once 'to', stay 'to'.
    if (existing === 'to') return;
    byKind.set(sub, kind);
  };
  for (const r of raw) {
    const kind: RecipientKind = r.kind === 'cc' ? 'cc' : 'to';
    if (isRoleAlias(r.alias)) {
      for (const sub of aliasExpander(r.alias)) addOne(sub, kind);
    } else if (typeof r.sub === 'string' && r.sub.trim().length > 0) {
      addOne(r.sub.trim(), kind);
    }
  }
  const recipients = [...byKind.entries()].map(([sub, kind]) => ({ sub, kind }));
  return {
    recipients,
    selfOnly: recipients.length === 0,
    hasTo: recipients.some((r) => r.kind === 'to'),
  };
}

// ── Unread predicate ─────────────────────────────────────────────────────────────────────────────
/**
 * Is this thread unread FOR a given user, from their recipient row? A thread counts as unread when
 * the user is a recipient whose readAt is null AND it is not archived-without-a-newer-reply. (The
 * router re-flips readAt=null on reply, including un-archiving via archivedAt handling, so the pure
 * predicate only needs readAt here — archive un-flip is a write-side concern.) A user who is NOT a
 * recipient (case-collaborator on a linked thread) never contributes to THEIR OWN unread badge
 * unless they were explicitly addressed — by design the badge counts addressed-unread only.
 */
export function isThreadUnreadForRecipient(recipientRow: Pick<StaffMessageRecipientRecord, 'readAt'> | null | undefined): boolean {
  if (recipientRow === null || recipientRow === undefined) return false;
  return recipientRow.readAt === null;
}

/**
 * Count distinct unread THREADS for a user given that user's recipient rows (one per thread they
 * are addressed on). The unread badge counts THREADS, not messages — so this is simply the number
 * of recipient rows with readAt === null.
 */
export function countUnreadThreads(myRecipientRows: readonly Pick<StaffMessageRecipientRecord, 'threadId' | 'readAt'>[]): number {
  const unreadThreadIds = new Set<string>();
  for (const row of myRecipientRows) {
    if (row.readAt === null) unreadThreadIds.add(row.threadId);
  }
  return unreadThreadIds.size;
}

// ── Thread access (pure decision over already-fetched facts) ───────────────────────────────────────
export interface ThreadAccessFacts {
  /** Is the thread case-linked? (caseId !== null on its messages) */
  readonly isCaseLinked: boolean;
  /** Did the case-access gate (assertParticipant) pass for this user? Only meaningful when linked. */
  readonly hasCaseAccess: boolean;
  /** Is the user the author of any message in the thread? */
  readonly isAuthor: boolean;
  /** Is the user in the thread's recipient set (to/cc/added)? */
  readonly isRecipient: boolean;
}

/**
 * The access model (spec domain rule 4), as a pure decision:
 *  - CASE-LINKED thread → readable/postable by anyone with case access (assertParticipant), even if
 *    not a named recipient. To/CC governs notify+unread, NOT access.
 *  - UNLINKED thread → recipient-only (author OR in the recipient set).
 * Evaluated LIVE per request (un-assign loses access on linked threads) — the router supplies fresh
 * facts each call.
 */
export function canAccessThread(facts: ThreadAccessFacts): boolean {
  if (facts.isAuthor) return true;
  if (facts.isCaseLinked) return facts.hasCaseAccess || facts.isRecipient;
  return facts.isRecipient;
}
