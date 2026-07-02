/**
 * Backfill AI document titles for existing Documents (Haiku 4.5).
 *
 * Iterates Documents that already have OCR page text and, unless --force, are not yet titled
 * (auto_title IS NULL). For each, calls the same `generateAndPersistDocumentTitle` orchestrator the
 * OCR-completion hook uses: reads the pages, applies the granted-condition backstop for rating
 * decisions, derives a clean filename, and UPDATEs auto_title / doc_type / title_model / filename.
 *
 * Idempotent (skips already-titled docs unless --force), batched, logs every rename. DO NOT run this
 * blind — start with a dry run:
 *
 *   # DRY RUN (no writes) — REQUIRED FIRST PASS
 *   ANTHROPIC_API_KEY=... DATABASE_URL=... npx tsx scripts/backfill-document-titles.ts --dry-run
 *
 *   # Real run (or a bounded slice while you sanity-check output)
 *   ANTHROPIC_API_KEY=... DATABASE_URL=... npx tsx scripts/backfill-document-titles.ts --limit=50
 *   ANTHROPIC_API_KEY=... DATABASE_URL=... npx tsx scripts/backfill-document-titles.ts
 *
 * Flags:  --dry-run (or DRY_RUN=1)   compute + log, never write
 *         --force                     re-title docs that already have a title
 *         --limit=N                   cap the number of documents processed
 *         --batch=N                   parallelism per batch (default 5)
 *         --case=<caseId>             restrict to one case (spot-check)
 */
import { PrismaClient } from '@prisma/client';
import { generateAndPersistDocumentTitle } from '../src/services/aiDocumentTitle.js';
import type { AppDb } from '../src/services/db-types.js';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : undefined;
}

async function main(): Promise<void> {
  const dryRun = flag('dry-run') || process.env.DRY_RUN === '1';
  const force = flag('force');
  const limit = opt('limit') ? Math.max(0, parseInt(opt('limit')!, 10) || 0) : undefined;
  const batchSize = Math.max(1, parseInt(opt('batch') ?? '5', 10) || 5);
  const caseId = opt('case');

  const prisma = new PrismaClient({ log: ['error'] });
  const db = prisma as unknown as AppDb;

  console.log(JSON.stringify({ msg: 'backfill_start', dryRun, force, limit: limit ?? null, batchSize, caseId: caseId ?? null }));

  // Documents that have OCR page text; untitled unless --force.
  const where: Record<string, unknown> = { pages: { some: {} } };
  if (!force) where.autoTitle = null;
  if (caseId) where.caseId = caseId;

  const docs = await prisma.document.findMany({
    where,
    orderBy: { uploadedAt: 'asc' },
    select: { id: true, filename: true },
    ...(limit ? { take: limit } : {}),
  });
  console.log(JSON.stringify({ msg: 'backfill_candidates', count: docs.length }));

  const counts = { updated: 0, dryRun: 0, skipped: 0, model_null: 0, no_text: 0, error: 0 };

  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (d) => {
        try {
          const r = await generateAndPersistDocumentTitle(db, d.id, { force, dryRun });
          if (r.skipped) {
            counts.skipped++;
            if (r.skipped === 'model_null') counts.model_null++;
            if (r.skipped === 'no_text') counts.no_text++;
            console.log(JSON.stringify({ msg: 'backfill_skip', documentId: d.id, reason: r.skipped, filename: d.filename }));
            return;
          }
          if (r.dryRun) counts.dryRun++;
          else counts.updated++;
          console.log(JSON.stringify({
            msg: dryRun ? 'backfill_would_rename' : 'backfill_renamed',
            documentId: d.id,
            oldFilename: r.oldFilename,
            newFilename: r.newFilename,
            autoTitle: r.autoTitle,
            docType: r.docType,
          }));
        } catch (err) {
          counts.error++;
          console.error(JSON.stringify({ msg: 'backfill_error', documentId: d.id, error: err instanceof Error ? err.message : String(err) }));
        }
      }),
    );
    console.log(JSON.stringify({ msg: 'backfill_progress', done: Math.min(i + batchSize, docs.length), total: docs.length }));
  }

  console.log(JSON.stringify({ msg: 'backfill_done', ...counts }));
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(JSON.stringify({ msg: 'backfill_fatal', error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
