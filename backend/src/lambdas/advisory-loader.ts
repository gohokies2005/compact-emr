// RN Advisory AI — the "cabinet" loader (Approach A).
//
// Idempotently builds the pgvector cabinet AND loads the embedded library. Runs in-VPC as the RDS
// master. The flatratenexus window NEVER touches RDS — it only drops the embedded JSONL in S3; this
// Lambda creates the schema/table/roles (so there's no `CREATE EXTENSION` in the Prisma migrate
// pipeline that could block deploys) and inserts the rows as `advisory_loader` (INSERT-only).
//
// Safe to re-run: all DDL is IF-NOT-EXISTS / idempotent, and the load is INSERT ... ON CONFLICT DO
// NOTHING. Per-row failures surface their reason (FRN rule) rather than dying silently.

import { PrismaClient } from '@prisma/client';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

// The cabinet DDL (read-only-by-architecture roles + the pgvector table). NOLOGIN roles + SET-ROLE at
// query time = no second DB login/secret. advisory_ro is the ask-path role (SELECT-only on ref_chunk);
// advisory_loader is THIS loader's role (INSERT-only). The master user becomes a member of both so it
// can SET ROLE. Kept identical in spirit to the drafted migration that this supersedes.
export const CABINET_DDL = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS advisory;
CREATE TABLE IF NOT EXISTS advisory.ref_chunk (
  id             TEXT PRIMARY KEY,
  text           TEXT NOT NULL,
  source         TEXT,
  condition      TEXT,
  library_path   TEXT,
  title          TEXT,
  citation       TEXT,
  pmid           TEXT,
  citation_type  TEXT,
  letter_citable BOOLEAN NOT NULL DEFAULT true,
  embedding      vector(1024)
);
CREATE INDEX IF NOT EXISTS ref_chunk_library_path_idx ON advisory.ref_chunk (library_path);
CREATE INDEX IF NOT EXISTS ref_chunk_embedding_hnsw   ON advisory.ref_chunk USING hnsw (embedding vector_cosine_ops);
DO $$ BEGIN CREATE ROLE advisory_ro NOLOGIN;     EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE advisory_loader NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT USAGE ON SCHEMA advisory TO advisory_ro;
GRANT SELECT ON advisory.ref_chunk TO advisory_ro;
GRANT USAGE ON SCHEMA advisory TO advisory_loader;
GRANT INSERT ON advisory.ref_chunk TO advisory_loader;
GRANT advisory_ro, advisory_loader TO CURRENT_USER;
`;

export const EMBEDDING_DIM = 1024;

export interface EmbeddedChunk {
  id: string;
  text: string;
  source: string | null;
  condition: string | null;
  library_path: string | null;
  title: string | null;
  citation: string | null;
  pmid: string | null;
  citation_type: string | null;
  letter_citable: boolean;
  embedding: number[];
}

function asStrOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// Parse + validate ONE JSONL line from the flatratenexus drop. Throws (with a precise reason) on a bad
// shape or wrong embedding dimension — a bad row must never be silently inserted as a partial.
export function parseEmbeddedChunk(line: string): EmbeddedChunk {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error('not valid JSON');
  }
  if (typeof obj.id !== 'string' || obj.id.length === 0) throw new Error('missing/empty id');
  if (typeof obj.text !== 'string' || obj.text.length === 0) throw new Error(`chunk ${String(obj.id)}: missing/empty text`);
  const embedding = obj.embedding;
  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIM) {
    throw new Error(`chunk ${obj.id}: embedding must be a ${EMBEDDING_DIM}-length array (got ${Array.isArray(embedding) ? embedding.length : typeof embedding})`);
  }
  for (const n of embedding) {
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`chunk ${obj.id}: embedding has a non-finite value`);
  }
  return {
    id: obj.id,
    text: obj.text,
    source: asStrOrNull(obj.source),
    condition: asStrOrNull(obj.condition),
    library_path: asStrOrNull(obj.library_path),
    title: asStrOrNull(obj.title),
    citation: asStrOrNull(obj.citation),
    pmid: asStrOrNull(obj.pmid),
    citation_type: asStrOrNull(obj.citation_type),
    letter_citable: obj.letter_citable === false ? false : true,
    embedding: embedding as number[],
  };
}

// pgvector literal: '[0.1,0.2,...]'. Caller validated finiteness + dimension in parseEmbeddedChunk.
export function toVectorLiteral(embedding: number[]): string {
  if (embedding.length !== EMBEDDING_DIM) throw new Error(`expected ${EMBEDDING_DIM} dims, got ${embedding.length}`);
  return `[${embedding.join(',')}]`;
}

// Make advisory_ro a LOGIN role with the given password (single-quote-escaped — the generated secret
// excludes punctuation, but escape defensively). This gives the ASK PATH a DEDICATED read-only DB
// identity to connect as, instead of `SET ROLE advisory_ro` on a pooled connection (the loader-pool bug
// + the architect's #1 landmine: SET ROLE bleeds across a connection pool). advisory_ro keeps ONLY its
// SELECT grants — login just lets it authenticate.
export function buildSetRoleLoginSql(password: string): string {
  const esc = password.replace(/'/g, "''");
  return `ALTER ROLE advisory_ro WITH LOGIN PASSWORD '${esc}'`;
}

async function readSecretPassword(secretName: string): Promise<string> {
  const sm = new SecretsManagerClient({});
  // Read by FRIENDLY NAME, never partial ARN (Secrets Manager can't resolve a partial ARN → masked as
  // AccessDenied — the FRN partial-ARN footgun).
  const r = await sm.send(new GetSecretValueCommand({ SecretId: secretName }));
  if (!r.SecretString) throw new Error(`secret ${secretName} has no SecretString`);
  const pw = String((JSON.parse(r.SecretString) as Record<string, unknown>).password ?? '');
  if (!pw) throw new Error(`secret ${secretName} has no password field`);
  return pw;
}

export interface LoadResult {
  setup: 'ok';
  parsed: number;
  inserted: number;
  skippedDuplicate: number;
  deleted: number; // rows pruned because their id is no longer in the dropped file (e.g. stale bva_atlas:*)
  advisoryRoLogin: 'set' | 'skipped'; // did we (re)set advisory_ro's LOGIN password from its secret?
  failed: Array<{ line: number; id?: string; reason: string }>;
}

async function readDropLines(bucket: string, key: string): Promise<string[]> {
  const s3 = new S3Client({});
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await res.Body?.transformToString();
  if (!body) throw new Error(`empty or missing drop object s3://${bucket}/${key}`);
  return body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

// Insert one chunk as advisory_loader. ON CONFLICT DO NOTHING makes re-runs idempotent and lets us
// distinguish a genuine insert from a skip (rowCount 0). The embedding goes in as a ::vector cast param.
async function insertChunk(prisma: PrismaClient, c: EmbeddedChunk): Promise<'inserted' | 'skipped'> {
  const rows = await prisma.$executeRawUnsafe(
    `INSERT INTO advisory.ref_chunk
       (id, text, source, condition, library_path, title, citation, pmid, citation_type, letter_citable, embedding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector)
     ON CONFLICT (id) DO NOTHING`,
    c.id, c.text, c.source, c.condition, c.library_path, c.title, c.citation, c.pmid, c.citation_type, c.letter_citable, toVectorLiteral(c.embedding),
  );
  return rows > 0 ? 'inserted' : 'skipped';
}

let cachedPrisma: PrismaClient | null = null;
function prismaClient(): PrismaClient {
  if (cachedPrisma === null) cachedPrisma = new PrismaClient();
  return cachedPrisma;
}

export async function handler(): Promise<LoadResult> {
  const bucket = process.env.ADVISORY_DROP_BUCKET;
  const key = process.env.ADVISORY_DROP_KEY ?? 'advisory/advisory_chunks_embedded.jsonl';
  if (!bucket) throw new Error('ADVISORY_DROP_BUCKET env not set');
  const prisma = prismaClient();

  // 1) Idempotent cabinet setup (runs as master). One statement at a time — Prisma's raw exec is single-
  //    statement, so split on top-level semicolons that end a statement (the DO $$...$$ blocks contain
  //    none at top level here).
  for (const stmt of CABINET_DDL.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s.length > 0)) {
    await prisma.$executeRawUnsafe(stmt.endsWith(';') ? stmt : `${stmt};`);
  }
  const result: LoadResult = { setup: 'ok', parsed: 0, inserted: 0, skippedDuplicate: 0, deleted: 0, advisoryRoLogin: 'skipped', failed: [] };

  // 1b) Give advisory_ro a LOGIN password from its secret so the ASK PATH connects AS advisory_ro (a
  //     dedicated read-only identity) instead of SET ROLE on a pooled connection. Skipped (logged) if the
  //     secret env isn't wired yet — the cabinet + load still work.
  const roSecret = process.env.ADVISORY_RO_SECRET_NAME;
  if (roSecret) {
    await prisma.$executeRawUnsafe(buildSetRoleLoginSql(await readSecretPassword(roSecret)));
    result.advisoryRoLogin = 'set';
  }

  // 2) Load the drop as the MASTER user (full access). We deliberately do NOT `SET ROLE advisory_loader`
  //    here: Prisma POOLS connections, so a session-level SET ROLE sticks on only one connection while the
  //    row-by-row inserts spread across the pool — that caused a partial 611/1244 load with "permission
  //    denied for table ref_chunk" on 2026-06-07. The loader is a trusted, in-VPC, one-shot setup op, so
  //    inserting as master is correct; the enforced read-only boundary is advisory_ro (SELECT-only) on the
  //    ASK path, not this loader. (advisory_loader still exists in the cabinet for the design/future.)
  //    Per-row failures still surface their reason (never a silent partial).
  const lines = await readDropLines(bucket, key);
  const fileIds: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let chunk: EmbeddedChunk;
    try {
      chunk = parseEmbeddedChunk(lines[i]);
      result.parsed++;
      fileIds.push(chunk.id);
    } catch (e) {
      result.failed.push({ line: i + 1, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    try {
      const outcome = await insertChunk(prisma, chunk);
      if (outcome === 'inserted') result.inserted++;
      else result.skippedDuplicate++;
    } catch (e) {
      result.failed.push({ line: i + 1, id: chunk.id, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  // 3) Reconcile: delete rows whose id is NOT in the dropped file, so the table EXACTLY matches the file.
  //    Handles REMOVALS (e.g. the stale `bva_atlas:*` chunks the flatratenexus window pruned 2026-06-07 —
  //    the insert-only load would otherwise leave them behind to surface inflated BVA numbers). GUARDED on
  //    a non-empty, fully-parsed file so a bad/empty/partially-failed drop can NEVER wipe the cabinet.
  if (fileIds.length > 0 && result.failed.length === 0) {
    const placeholders = fileIds.map((_, i) => `$${i + 1}`).join(',');
    result.deleted = await prisma.$executeRawUnsafe(
      `DELETE FROM advisory.ref_chunk WHERE id NOT IN (${placeholders})`,
      ...fileIds,
    );
  }

  // eslint-disable-next-line no-console
  console.log('[advisory-loader]', JSON.stringify({ ...result, failed: result.failed.length }));
  return result;
}
