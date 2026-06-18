// Canonical letter download filename: `Lastname_Firstname_COND_vN` (e.g. "Ewell_S_OSA_v7").
// Mirrors frontend/src/lib/letterFilename.ts (kept in sync by hand — small + stable). Used to name the
// downloaded/served PDF + DOCX via the S3 ResponseContentDisposition header, so a saved letter is
// "Ewell_S_OSA_v7.pdf", not a bare "letter.pdf". (Ryan 2026-06-18, "asked 2×".)

const CONDITION_ABBREVIATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/obstructive sleep apnea|sleep apnea|\bosa\b/i, 'OSA'],
  [/post[\s-]?traumatic stress|\bptsd\b/i, 'PTSD'],
  [/gastroesophageal reflux|\bgerd\b/i, 'GERD'],
  [/traumatic brain injury|\btbi\b/i, 'TBI'],
  [/major depressive|depression|\bmdd\b/i, 'MDD'],
  [/generalized anxiety|anxiety|\bgad\b/i, 'GAD'],
  [/chronic obstructive pulmonary|\bcopd\b/i, 'COPD'],
  [/coronary artery disease|\bcad\b/i, 'CAD'],
  [/degenerative disc|\bddd\b/i, 'DDD'],
  [/lumbosacral|lumbar|low back|\blss\b/i, 'Lumbar'],
  [/cervical|neck/i, 'Cervical'],
  [/tinnitus/i, 'Tinnitus'],
  [/hearing loss/i, 'HearingLoss'],
  [/hypertension|\bhtn\b/i, 'HTN'],
  [/diabetes|\bdm\b/i, 'Diabetes'],
  [/erectile dysfunction|\bed\b/i, 'ED'],
  [/peripheral neuropathy|neuropathy/i, 'Neuropathy'],
  [/radiculopathy/i, 'Radiculopathy'],
  [/migraine|headache/i, 'Migraine'],
  [/rhinitis|sinusitis/i, 'Sinus'],
  [/asthma/i, 'Asthma'],
  [/hypothyroid|thyroid/i, 'Thyroid'],
];

function cleanToken(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '').trim();
}
function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

/** Abbreviate a condition: known map first, then an acronym of the significant words (drops filler),
 *  capped at 8 chars; falls back to a capitalized single word, then 'Claim'. */
export function abbreviateCondition(condition: string | null | undefined): string {
  const raw = (condition ?? '').trim();
  if (raw.length === 0) return 'Claim';
  for (const [pattern, abbr] of CONDITION_ABBREVIATIONS) {
    if (pattern.test(raw)) return abbr;
  }
  const stop = new Set(['of', 'the', 'and', 'with', 'to', 'in', 'a', 'an', 'for', 'on']);
  const words = raw.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0 && !stop.has(w.toLowerCase()));
  if (words.length === 0) return 'Claim';
  if (words.length === 1) return capitalize(cleanToken(words[0]!)).slice(0, 12) || 'Claim';
  return words.map((w) => w[0]!.toUpperCase()).join('').slice(0, 8) || 'Claim';
}

/** Canonical base name (no extension). `version` undefined/≤0 omits the _vN. Safe for a filename. */
export function letterFilename(
  lastName: string | null | undefined,
  firstName: string | null | undefined,
  condition: string | null | undefined,
  version?: number | null,
): string {
  const last = cleanToken(lastName) || 'Veteran';
  const first = cleanToken(firstName);
  const cond = abbreviateCondition(condition);
  const v = typeof version === 'number' && Number.isFinite(version) && version > 0 ? `_v${version}` : '';
  const parts = [last, first, cond].filter((p) => p.length > 0);
  return `${parts.join('_')}${v}`;
}
