// Consistent chart filenames for files assigned from a Jotform intake (Ryan 2026-06-04):
// `Lastname_Condition_DocType.ext`, e.g. "Frank_OSA_BlueButton.pdf". DocType is guessed from the
// ORIGINAL filename; a combined / unclassifiable file becomes "Misc" (Ryan's preference). Callers
// number collisions (assignChartFilenames below). Pure + deterministic.

const DOCTYPE_KEYWORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/dd[ _-]?214/i, 'DD214'],
  [/blue ?button|bluebutton/i, 'BlueButton'],
  [/sleep ?study|polysom|\bpsg\b/i, 'SleepStudy'],
  [/denial|denied/i, 'Denial'],
  [/decision|rating|rated/i, 'Decision'],
  [/buddy|lay statement|lay stmt/i, 'Statement'],
  [/service treatment|treatment record|\bstr\b/i, 'STR'],
  [/\bdbq\b/i, 'DBQ'],
  [/c&p|c and p|comp.*pension/i, 'CandP'],
  [/nexus|\bimo\b/i, 'Nexus'],
  [/audiogram|audiology/i, 'Audiogram'],
  [/imaging|x-?ray|\bmri\b|\bct\b/i, 'Imaging'],
];

const CONDITION_ABBR: ReadonlyArray<readonly [RegExp, string]> = [
  [/obstructive sleep apnea|sleep apnea|\bosa\b/i, 'OSA'],
  [/post[\s-]?traumatic stress|\bptsd\b/i, 'PTSD'],
  [/gastroesophageal reflux|\bgerd\b/i, 'GERD'],
  [/traumatic brain injury|\btbi\b/i, 'TBI'],
  [/\bcopd\b|chronic obstructive/i, 'COPD'],
  [/lumbar|lumbosacral|low back/i, 'Lumbar'],
  [/cervical|neck/i, 'Cervical'],
  [/tinnitus/i, 'Tinnitus'],
  [/migraine|headache/i, 'Migraine'],
];

function clean(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '').slice(0, 24);
}

export function abbreviateConditionForFile(condition: string | null | undefined): string {
  const raw = (condition ?? '').trim();
  if (raw.length === 0) return 'Claim';
  for (const [re, abbr] of CONDITION_ABBR) if (re.test(raw)) return abbr;
  // Acronym from significant words, else the cleaned single word.
  const words = raw.split(/[^a-zA-Z0-9]+/).filter((w) => w.length > 1);
  if (words.length >= 2) return words.map((w) => w[0]!.toUpperCase()).join('').slice(0, 6);
  return clean(words[0] ?? raw).replace(/^./, (c) => c.toUpperCase()) || 'Claim';
}

export function guessDocType(originalName: string | null | undefined): string {
  const name = originalName ?? '';
  for (const [re, label] of DOCTYPE_KEYWORDS) if (re.test(name)) return label;
  return 'Misc'; // combined / unclassifiable
}

function extOf(name: string): string {
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(name ?? '');
  return m ? `.${m[1]!.toLowerCase()}` : '';
}

/**
 * Build collision-free chart filenames for a batch of files being assigned to one case.
 * Returns the new name per input, in order. Numbers duplicates: Frank_OSA_BlueButton.pdf,
 * Frank_OSA_BlueButton_2.pdf, …
 */
export function assignChartFilenames(
  lastName: string | null | undefined,
  condition: string | null | undefined,
  originalNames: readonly string[],
): string[] {
  const last = clean(lastName) || 'Veteran';
  const cond = abbreviateConditionForFile(condition);
  const used = new Map<string, number>();
  return originalNames.map((orig) => {
    const base = `${last}_${cond}_${guessDocType(orig)}`;
    const ext = extOf(orig);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? `${base}${ext}` : `${base}_${n}${ext}`;
  });
}
