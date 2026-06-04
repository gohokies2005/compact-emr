// Canonical letter filename / title: `Lastname_Firstname_COND_vN` (e.g. "Kasky_Ryan_OSA_v3").
// Used for the editor title, the case "Edit the letter" card, and downloaded artifacts so the
// physician/RN always sees WHICH letter+version they're on, not a generic "Letter editor".
// (Ryan 2026-06-04.)

// Common VA conditions → the abbreviation a clinician expects. Checked (case-insensitive,
// punctuation-insensitive) before the generic acronym fallback. Extend freely.
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
  // Keep letters/numbers only, collapse the rest — safe for a filename and a title.
  return (value ?? '').normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '').trim();
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

// Abbreviate a condition string: known map first, then an acronym from the significant words
// (drops filler like "of/the/and"), capped at 8 chars; falls back to a capitalized single word.
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
  const acronym = words.map((w) => w[0]!.toUpperCase()).join('').slice(0, 8);
  return acronym || 'Claim';
}

// Build the canonical name. `version` may be undefined (no version known yet) → omits the _vN.
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
