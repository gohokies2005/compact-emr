/**
 * Chart-extraction A/B smoke (PR-3, Ryan 2026-06-13). Runs the SAME full-read chunker over a real
 * case's documents across several models and diffs what each catches, plus the current windowed
 * baseline. Read-only: pulls documents live, never writes chart rows, never persists PHI to disk —
 * prints structured findings (names + status, NOT verbatim record narrative) to stdout for review.
 *
 * Usage (from backend/):
 *   CASE_ID=<id> COMPACT_EMR_API_URL=<url> INTERNAL_WORKER_TOKEN=<tok> ANTHROPIC_API_KEY=<key> \
 *     [SMOKE_MODELS=claude-sonnet-4-6,claude-opus-4-8,claude-haiku-4-5-20251001] \
 *     npx tsx scripts/chart-extract-smoke.ts
 */
import Anthropic from '@anthropic-ai/sdk';
import { extractFullRead, makeChartExtractor, type ExtractionResult } from '../src/services/chart-extract-llm.js';
import { normalizeName, type BundleDocument } from '../src/services/chart-extractor.js';

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) { console.error(`Missing required env ${name}`); process.exit(2); }
  return v.trim();
}

async function fetchDocuments(apiBase: string, token: string, caseId: string): Promise<BundleDocument[]> {
  const res = await fetch(`${apiBase.replace(/\/$/, '')}/api/v1/internal/cases/${caseId}/extract-documents`, {
    headers: { 'X-Internal-Worker-Token': token },
  });
  if (!res.ok) throw new Error(`extract-documents GET failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: { documents: BundleDocument[] } };
  return json.data.documents;
}

function key(category: string, name: string): string { return `${category}::${normalizeName(name)}`; }

function indexItems(r: ExtractionResult): Map<string, { category: string; name: string; status?: string; ratingPct?: number }> {
  const m = new Map<string, { category: string; name: string; status?: string; ratingPct?: number }>();
  for (const it of r.items) m.set(key(it.category, it.name), { category: it.category, name: it.name, status: it.status, ratingPct: it.ratingPct });
  return m;
}

async function main(): Promise<void> {
  const caseId = reqEnv('CASE_ID');
  const apiBase = reqEnv('COMPACT_EMR_API_URL');
  const token = reqEnv('INTERNAL_WORKER_TOKEN');
  const apiKey = reqEnv('ANTHROPIC_API_KEY');
  const models = (process.env.SMOKE_MODELS ?? 'claude-sonnet-4-6,claude-opus-4-8,claude-haiku-4-5-20251001').split(',').map((s) => s.trim()).filter(Boolean);

  console.log(`\n=== CHART-EXTRACT A/B SMOKE — case ${caseId} ===`);
  const t0 = Date.now();
  const documents = await fetchDocuments(apiBase, token, caseId);
  const totalPages = documents.reduce((s, d) => s + (d.pages?.length ?? 0), 0);
  const totalChars = documents.reduce((s, d) => s + (d.pages ?? []).reduce((a, p) => a + p.text.length, 0), 0);
  console.log(`Documents: ${documents.length} · pages: ${totalPages} · chars: ${totalChars.toLocaleString()} · fetch ${(Date.now() - t0)}ms\n`);

  const variants: { label: string; result: ExtractionResult; ms: number }[] = [];

  // Baseline: the CURRENT windowed path (gate off).
  process.env.CHART_EXTRACT_FULLREAD = 'off';
  const bw = Date.now();
  const windowed = await makeChartExtractor(apiKey).extract(documents);
  variants.push({ label: 'WINDOWED (current)', result: windowed, ms: Date.now() - bw });

  // Full read, one variant per model.
  for (const model of models) {
    const t = Date.now();
    try {
      const r = await extractFullRead(new Anthropic({ apiKey }), documents, model);
      variants.push({ label: `FULLREAD ${model}`, result: r, ms: Date.now() - t });
    } catch (e) {
      console.error(`FULLREAD ${model} FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Per-variant summary.
  console.log('VARIANT'.padEnd(42), 'SC', 'PROB', 'MED', 'SCRN', 'chunks', 'uncov', 'trunc', 'cost$', 'sec');
  const counts = (r: ExtractionResult, cat: string) => r.items.filter((i) => i.category === cat).length;
  for (const v of variants) {
    const r = v.result;
    console.log(
      v.label.padEnd(42),
      String(counts(r, 'sc_condition')).padStart(2),
      String(counts(r, 'active_problem')).padStart(4),
      String(counts(r, 'active_medication')).padStart(3),
      String(r.screenings?.length ?? 0).padStart(4),
      String(r.chunksProcessed ?? '-').padStart(6),
      String(r.uncoveredPages ?? '-').padStart(5),
      String(r.truncatedWindows).padStart(5),
      r.costUsd.toFixed(3).padStart(6),
      (v.ms / 1000).toFixed(1).padStart(4),
    );
  }

  // SC-condition recall diff — the row that matters most. Union of every SC condition any variant found.
  const scUnion = new Map<string, string>();
  const perVariantSc = variants.map((v) => ({ label: v.label, idx: indexItems(v.result) }));
  for (const v of perVariantSc) for (const [k, it] of v.idx) if (it.category === 'sc_condition') scUnion.set(k, it.name);
  console.log('\n=== SERVICE-CONNECTED CONDITIONS — recall by variant (the buried-grant check) ===');
  console.log('CONDITION'.padEnd(46), variants.map((v) => v.label.slice(0, 14).padEnd(15)).join(''));
  for (const [k, name] of [...scUnion.entries()].sort()) {
    const cells = perVariantSc.map((v) => {
      const hit = v.idx.get(k);
      return (hit ? `✓${hit.ratingPct != null ? ` ${hit.ratingPct}%` : ''}${hit.status ? ` ${hit.status[0]}` : ''}` : '—').padEnd(15);
    });
    console.log(name.slice(0, 45).padEnd(46), cells.join(''));
  }

  // Screenings captured (full-read variants only).
  for (const v of variants) {
    if (!v.result.screenings?.length) continue;
    console.log(`\n=== SCREENINGS — ${v.label} ===`);
    for (const s of v.result.screenings) console.log(`  ${s.instrument} = ${s.score}${s.date ? ` (${s.date})` : ''} [p.${s.sourcePage}]`);
  }

  const totalCost = variants.reduce((s, v) => s + v.result.costUsd, 0);
  console.log(`\n=== TOTAL SMOKE COST: $${totalCost.toFixed(3)} across ${variants.length} runs ===\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
