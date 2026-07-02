/**
 * AI document titling (Haiku 4.5).
 *
 * Replaces the brittle deterministic filename/title scheme (chart-filename.ts `..._Misc_N` +
 * documentClassifier.ts regex) with a small model that READS each document's OCR text and names it
 * accurately — rating decisions with per-condition outcomes, private records, sleep-medicine notes,
 * lay statements, screenshots, etc. A trial proved Haiku 4.5 reads the actual text and names all doc
 * types correctly at ~0.7¢/doc at the 15k-char context cap (the ~0.2¢/doc figure only holds for 1-2
 * page docs; a full-context read of a large multi-condition decision costs more, which is fine — cost
 * is not the constraint, an accurate read is).
 *
 * Design:
 *  - `titleDocument({ filename, pages })` → the pure LLM read: feed the first ~10 pages OR ~15,000
 *    chars (whichever is smaller), Haiku 4.5, temperature 0, max_tokens 800. Returns a strict
 *    DocTitleResult, or `null` on any API/parse failure (caller falls back to the regex classifier).
 *  - JSON is HARDENED: the assistant turn is prefilled with `{`, and we parse the FIRST balanced JSON
 *    object out of the completion (Haiku sometimes appends prose after the closing brace, and long
 *    multi-condition outputs can truncate). Truncation / prose / non-JSON → null.
 *  - `mergeGrantedConditionBackstop` (rating decisions only): the extracted `sc_conditions` rows for a
 *    doc are already correct + grounded; if one names a GRANTED condition the model didn't list, we
 *    append it so a deep-buried grant can't be dropped from the title. Tiebreaker, not a replacement.
 *  - `generateAndPersistDocumentTitle` wires it to a Document: read pages, gather granted SC rows,
 *    title, derive a clean filename, and persist autoTitle/docType/titleModel/filename. Non-throwing.
 *
 * Client + key: reuses the canonical `resolveAnthropicApiKey()` (env ANTHROPIC_API_KEY, else Secrets
 * Manager via API_ANTHROPIC_KEY_SECRET_ARN) — no key is ever hardcoded. Mirrors citation-enricher.ts.
 */
import Anthropic from '@anthropic-ai/sdk';
import { resolveAnthropicApiKey } from './letter-surgical-propose.js';
import type { AppDb } from './db-types.js';

// ── Model + tunables ────────────────────────────────────────────────────────────────────────────
// The trial validated `claude-haiku-4-5-20251001`. Overridable via env for a fast kill/upgrade path.
export function resolveDocTitleModel(): string {
  const m = process.env.AI_DOC_TITLE_MODEL;
  return m && m.trim().length > 0 ? m.trim() : 'claude-haiku-4-5-20251001';
}
const MAX_TOKENS = 800; // the trial's 300 truncated long multi-condition decisions.
const MAX_PAGES = 10; // MORE than 2 pages, to clear blank/cover pages + capture a full condition list.
const MAX_CHARS = 15_000;

// SYSTEM PROMPT — VERBATIM (validated in the trial). Do not paraphrase.
export const DOC_TITLE_SYSTEM_PROMPT =
  'You name VA disability claim documents for a medical-records system. You are given the raw ' +
  'extracted text (OCR, may be messy) of ONE document. Identify what it is and produce a short, ' +
  'accurate title a nurse could scan at a glance. Rules: (1) Use the VA/DoD form identifier if ' +
  "present (e.g. 'VA Form 21-526EZ', 'DD Form 214'). (2) Name the document TYPE precisely (Rating " +
  'Decision, C&P exam / DBQ, sleep study, private treatment records + facility if named, VA ' +
  'health-record export, lay/buddy statement, nexus letter, intake summary, etc.). (3) For a Rating ' +
  'Decision, list each condition WITH its outcome and percentage — a single decision often has MIXED ' +
  'outcomes (some granted at X%, some denied, some deferred); report the ones you see and NEVER glue ' +
  'one condition to a document-wide outcome. (4) Never invent an outcome or condition not in the ' +
  'text; if the text is too sparse to tell, say so with low confidence. Output ONLY strict JSON: ' +
  '{"title": "...", "doc_type": "...", "form_id": "..."|null, "conditions": [{"name":"...","outcome":"granted|denied|deferred","percent": <int|null>}], "confidence": "high|medium|low"}';

// ── Result shape (mirrors the model's JSON contract exactly) ──────────────────────────────────────
export type ConditionOutcome = 'granted' | 'denied' | 'deferred';
export interface TitledCondition {
  readonly name: string;
  readonly outcome: ConditionOutcome;
  readonly percent: number | null;
}
export interface DocTitleResult {
  readonly title: string;
  readonly doc_type: string;
  readonly form_id: string | null;
  readonly conditions: readonly TitledCondition[];
  readonly confidence: 'high' | 'medium' | 'low';
}

export interface TitleInput {
  readonly filename?: string | null;
  readonly pages: readonly string[];
}
export type DocumentTitler = (input: TitleInput) => Promise<DocTitleResult | null>;

// ── JSON hardening ────────────────────────────────────────────────────────────────────────────────
/**
 * Return the first BALANCED JSON object in `text` (from its first `{` to the matching `}`), or null.
 * String-aware (braces inside "..." don't count) and escape-aware. Trailing prose after the object is
 * ignored; an unterminated object (truncated output) returns null.
 */
export function extractFirstBalancedJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function coerceOutcome(v: unknown): ConditionOutcome | null {
  if (v === 'granted' || v === 'denied' || v === 'deferred') return v;
  return null;
}
function coercePercent(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string') {
    const n = parseInt(v.replace(/[^0-9]/g, ''), 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
function coerceConditions(v: unknown): TitledCondition[] {
  if (!Array.isArray(v)) return [];
  const out: TitledCondition[] = [];
  for (const raw of v) {
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (name.length === 0) continue;
    const outcome = coerceOutcome(r.outcome);
    if (outcome === null) continue; // drop malformed rows rather than inventing an outcome
    out.push({ name, outcome, percent: coercePercent(r.percent) });
  }
  return out;
}
function coerceConfidence(v: unknown): 'high' | 'medium' | 'low' {
  return v === 'high' || v === 'medium' || v === 'low' ? v : 'low';
}

/**
 * Parse a (possibly prefill-reconstructed, possibly prose-suffixed) model response into a
 * DocTitleResult, or null. Never throws. A missing/blank title → null (caller falls back).
 */
export function parseDocTitleResponse(rawText: string): DocTitleResult | null {
  const json = extractFirstBalancedJson(rawText);
  if (json === null) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  if (title.length === 0) return null;
  return {
    title,
    doc_type: typeof o.doc_type === 'string' ? o.doc_type.trim() : '',
    form_id: typeof o.form_id === 'string' && o.form_id.trim().length > 0 ? o.form_id.trim() : null,
    conditions: coerceConditions(o.conditions),
    confidence: coerceConfidence(o.confidence),
  };
}

// ── The Haiku read ────────────────────────────────────────────────────────────────────────────────
function buildContext(pages: readonly string[]): string {
  return pages
    .slice(0, MAX_PAGES)
    .map((p) => (typeof p === 'string' ? p : ''))
    .join('\n\n')
    .slice(0, MAX_CHARS);
}

/**
 * A 4.5-tier (or older) model that accepts an assistant `{` PREFILL and an explicit `temperature`.
 * The 4.6+/5 family (Opus 4.6/4.7/4.8, Sonnet 4.6/5, Fable/Mythos 5) REJECTS both with an HTTP 400 —
 * which the titler swallows to null → every doc silently falls back to the regex classifier. So when
 * `AI_DOC_TITLE_MODEL` is overridden to a 4.6+ model we must OMIT the prefill + temperature and lean
 * on the balanced-JSON parse of the normal response, so titling still works instead of silently dying.
 */
export function modelAcceptsPrefill(model: string): boolean {
  return /(?:^|-)(?:haiku|sonnet|opus)-4-5(?:-|$)|(?:^|-)3-5(?:-|$)/i.test(model);
}

/** Build a Haiku-backed document titler from an API key. Injected for test stubbing. */
export function makeDocumentTitler(apiKey: string, model: string = resolveDocTitleModel()): DocumentTitler {
  // Off the API 29s request path (runs in the async self-invoke titling handler). Bounded so a hung
  // provider can't wedge the caller; failures fall back to the regex classifier.
  const anthropic = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 2 });
  const prefill = modelAcceptsPrefill(model); // 4.6+ models 400 on prefill + temperature — omit both there.
  return async (input: TitleInput): Promise<DocTitleResult | null> => {
    const context = buildContext(input.pages);
    if (context.trim().length === 0) return null;
    const filename = (input.filename ?? '').trim() || '(no filename)';
    let text: string;
    try {
      const messages: Anthropic.MessageParam[] = [
        { role: 'user', content: `FILENAME: ${filename}\n\nDOCUMENT TEXT (OCR, may be messy):\n${context}` },
      ];
      // Prefill the JSON open-brace so the model cannot preface with prose (4.5-tier only — see
      // modelAcceptsPrefill). On a 4.6+ override the response is parsed via extractFirstBalancedJson.
      if (prefill) messages.push({ role: 'assistant', content: '{' });
      const req: Anthropic.MessageCreateParamsNonStreaming = { model, max_tokens: MAX_TOKENS, system: DOC_TITLE_SYSTEM_PROMPT, messages };
      if (prefill) req.temperature = 0;
      const resp = await anthropic.messages.create(req);
      if (resp.stop_reason === 'refusal') return null;
      text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
    } catch (err) {
      console.error(JSON.stringify({ msg: 'ai_document_title_api_error', model, error: err instanceof Error ? err.message : String(err) }));
      return null;
    }
    // Re-attach the prefilled '{' before parsing the balanced object (only when we prefilled it).
    return parseDocTitleResponse(prefill ? '{' + text : text);
  };
}

/**
 * Lazily-resolved titler for production — the Anthropic key is fetched on first use and cached
 * (mirrors makeTermsExtractorFromEnv). A failed resolve is NOT cached, so filling the secret needs
 * no redeploy.
 */
export function makeDocumentTitlerFromEnv(): DocumentTitler {
  let delegate: DocumentTitler | null = null;
  let resolving: Promise<DocumentTitler> | null = null;
  async function ensure(): Promise<DocumentTitler> {
    if (delegate) return delegate;
    if (!resolving) {
      resolving = resolveAnthropicApiKey()
        .then((key) => {
          delegate = makeDocumentTitler(key);
          return delegate;
        })
        .catch((e: unknown) => {
          resolving = null;
          throw e;
        });
    }
    return resolving;
  }
  return async (input: TitleInput): Promise<DocTitleResult | null> => {
    try {
      return await (await ensure())(input);
    } catch (err) {
      console.error(JSON.stringify({ msg: 'ai_document_title_resolve_error', error: err instanceof Error ? err.message : String(err) }));
      return null;
    }
  };
}

let envTitler: DocumentTitler | null = null;
/** Env-backed convenience titler (the public entry point). Returns null on any failure. */
export function titleDocument(input: TitleInput): Promise<DocTitleResult | null> {
  if (!envTitler) envTitler = makeDocumentTitlerFromEnv();
  return envTitler(input);
}

// ── Granted-condition backstop (rating decisions only) ────────────────────────────────────────────
function normalizeConditionName(s: string): string {
  // Tokenize → SORT → join so word-order variants collapse ("Obstructive Sleep Apnea" ===
  // "Sleep Apnea, Obstructive"); otherwise the backstop can double-append the same grant.
  return s.toLowerCase().normalize('NFKD').split(/[^a-z0-9]+/).filter((t) => t.length > 0).sort().join('');
}
/** True when the model classified this as a VA rating decision (the only doc type the backstop touches). */
export function isRatingDecision(result: DocTitleResult): boolean {
  return /rating decision/i.test(result.doc_type);
}
/**
 * Merge grounded, already-extracted GRANTED sc_conditions the model omitted into the title/conditions.
 * A deep-buried grant (e.g. OSA granted at 50% on page 40 of a mixed decision) can't be silently
 * dropped. No-op when there is nothing missing. The extracted rows are the tiebreaker, not a
 * replacement — Haiku's read of the other conditions stands.
 */
export function mergeGrantedConditionBackstop(result: DocTitleResult, grantedNames: readonly string[]): DocTitleResult {
  if (grantedNames.length === 0) return result;
  const have = new Set(result.conditions.map((c) => normalizeConditionName(c.name)));
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const raw of grantedNames) {
    const name = (raw ?? '').trim();
    if (name.length === 0) continue;
    const key = normalizeConditionName(name);
    if (key.length === 0 || have.has(key) || seen.has(key)) continue;
    seen.add(key);
    missing.push(name);
  }
  if (missing.length === 0) return result;
  const appended: TitledCondition[] = missing.map((name) => ({ name, outcome: 'granted', percent: null }));
  const suffix = missing.map((n) => `${n} granted`).join('; ');
  const title = result.title.includes(suffix) ? result.title : `${result.title} — ${suffix}`;
  return { ...result, title, conditions: [...result.conditions, ...appended] };
}

// ── Filename derivation ───────────────────────────────────────────────────────────────────────────
const KNOWN_EXTS = new Set(['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx', 'txt', 'html', 'htm']);
function extOf(name: string | null | undefined): string {
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(name ?? '');
  const e = m ? m[1]!.toLowerCase() : '';
  // Preserve a real document extension (a .docx renamed to .pdf would corrupt the download name);
  // default to pdf for unknown/absent extensions (the overwhelming majority of VA records).
  return KNOWN_EXTS.has(e) ? e : 'pdf';
}
function cleanLastName(last: string | null | undefined): string {
  const c = (last ?? '').normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '').slice(0, 24);
  return c.length > 0 ? c : 'Veteran';
}
/** Slug of a title: lowercase, punctuation/space → hyphen, dashes normalized, length-capped. */
export function slugifyTitle(title: string, maxLen = 60): string {
  const s = title
    .normalize('NFKD')
    .replace(/[‐-―]/g, '-') // hyphen/dash variants → '-'
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const clipped = s.slice(0, maxLen).replace(/-+$/g, '');
  return clipped.length > 0 ? clipped : 'document';
}
/** `<LastName>_<slug(title)>.<ext>` (ext preserved from the original filename, else `pdf`). */
export function deriveFilenameFromTitle(lastName: string | null | undefined, title: string, originalFilename?: string | null): string {
  return `${cleanLastName(lastName)}_${slugifyTitle(title)}.${extOf(originalFilename)}`;
}
/** Insert `_2`, `_3`, … before the extension until the name doesn't collide with `existing`. */
export function withCollisionSuffix(filename: string, existing: ReadonlySet<string>): string {
  if (!existing.has(filename)) return filename;
  const m = /^(.*?)(\.[a-zA-Z0-9]{1,8})$/.exec(filename);
  const base = m ? m[1]! : filename;
  const ext = m ? m[2]! : '';
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}_${n}${ext}`;
    if (!existing.has(candidate)) return candidate;
  }
  return filename;
}

// ── Persist orchestrator (used by the OCR-completion hook + the backfill script) ──────────────────
export interface TitlePersistResult {
  readonly documentId: string;
  readonly updated: boolean;
  readonly skipped?: 'not_found' | 'already_titled' | 'no_text' | 'model_null' | 'error';
  readonly autoTitle?: string;
  readonly docType?: string;
  readonly oldFilename?: string;
  readonly newFilename?: string;
  readonly dryRun?: boolean;
}

// Narrow, cast-based view of the loose AppDb facade (DocumentDelegate only exposes findMany). Mirrors
// the existing cast pattern in document-pages-writer.ts.
interface DocLoad {
  id: string;
  filename: string;
  s3Key: string;
  autoTitle: string | null;
  caseId: string;
  case: { veteran: { lastName: string | null } | null } | null;
}
interface DocWriteDelegate {
  findUnique(args: { where: { id: string }; select: Record<string, unknown> }): Promise<DocLoad | null>;
  findMany(args: { where: Record<string, unknown>; select: { id: true; filename: true } }): Promise<Array<{ id: string; filename: string }>>;
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
}

/**
 * Title one Document and persist autoTitle/docType/titleModel + a derived filename. Never throws —
 * returns a result the caller can log. Idempotent: skips a doc that already has a title unless
 * `force`. `dryRun` computes without writing (backfill preview).
 */
export async function generateAndPersistDocumentTitle(
  db: AppDb,
  documentId: string,
  opts: { titler?: DocumentTitler; force?: boolean; dryRun?: boolean } = {},
): Promise<TitlePersistResult> {
  // NEVER THROWS — every DB call below is inside this guard. A transient DB error must not reject the
  // caller's promise (the async self-invoke handler + the OCR writer + the backfill all rely on
  // fail-open). On any error: log + return skipped:'error'; the doc stays untitled → regex fallback.
  try {
  const docDelegate = db.document as unknown as DocWriteDelegate;
  const doc = await docDelegate.findUnique({
    where: { id: documentId },
    select: { id: true, filename: true, s3Key: true, autoTitle: true, caseId: true, case: { select: { veteran: { select: { lastName: true } } } } },
  });
  if (doc === null) return { documentId, updated: false, skipped: 'not_found' };
  if (typeof doc.autoTitle === 'string' && doc.autoTitle.trim().length > 0 && opts.force !== true) {
    return { documentId, updated: false, skipped: 'already_titled' };
  }

  const pageRows = await db.documentPage.findMany({
    where: { documentId },
    orderBy: { pageNumber: 'asc' },
    take: MAX_PAGES + 2,
    select: { text: true },
  });
  const pages = pageRows.map((p) => p.text);
  if (buildContext(pages).trim().length === 0) return { documentId, updated: false, skipped: 'no_text' };

  const titler = opts.titler ?? titleDocument;
  const result = await titler({ filename: doc.filename, pages });
  if (result === null) return { documentId, updated: false, skipped: 'model_null' };

  // Granted-condition backstop (rating decisions only): grounded sc_conditions the model missed.
  let finalResult = result;
  if (isRatingDecision(result)) {
    const scRows = await db.scCondition.findMany({
      where: { sourceDocumentId: documentId, status: 'service_connected' },
      select: { condition: true },
    });
    const grantedNames = scRows.map((r) => (r as { condition: string }).condition);
    finalResult = mergeGrantedConditionBackstop(result, grantedNames);
  }

  const lastName = doc.case?.veteran?.lastName ?? null;
  const desired = deriveFilenameFromTitle(lastName, finalResult.title, doc.filename);
  const siblings = await docDelegate.findMany({ where: { caseId: doc.caseId, id: { not: documentId } }, select: { id: true, filename: true } });
  const existing = new Set(siblings.map((s) => s.filename));
  const newFilename = desired === doc.filename ? doc.filename : withCollisionSuffix(desired, existing);

  const base: TitlePersistResult = {
    documentId,
    updated: !opts.dryRun,
    autoTitle: finalResult.title,
    docType: finalResult.doc_type,
    oldFilename: doc.filename,
    newFilename,
    ...(opts.dryRun ? { dryRun: true } : {}),
  };
  if (opts.dryRun) return base;

  await docDelegate.update({
    where: { id: documentId },
    data: { autoTitle: finalResult.title, docType: finalResult.doc_type, titleModel: resolveDocTitleModel(), filename: newFilename },
  });
  return base;
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'generateAndPersistDocumentTitle failed open', documentId, error: err instanceof Error ? err.message : String(err) }));
    return { documentId, updated: false, skipped: 'error' };
  }
}
