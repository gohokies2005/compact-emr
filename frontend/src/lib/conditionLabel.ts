// Clean, consistent display for condition labels coming from Jotform slugs, the library, and RN
// free-text — so "osa" / "Sleep Apnea" / "Sleep Apnea (OSA)" / "unspecified_genitourinary" all
// render one clean way. Display-level normalization (also used to clean a new-claim condition before
// it's stored, so the source gets tidier over time).

// Tokens that should stay UPPERCASE (medical acronyms).
const ACRONYMS = new Set(['osa', 'ptsd', 'gerd', 'tbi', 'copd', 'ibs', 'gi', 'ed', 'dvt', 'htn', 'dm', 'adhd', 'ocd', 'tmj', 'va', 'dc', 'imo', 'sc', 'cad', 'afib', 'mst', 'aud', 'mdd', 'ckd', 'hld', 'dm2', 'sud', 'als', 'oa', 'djd']);

// Spinal-level designations (l5-s1 → L5-S1, c5-c6 → C5-C6, t12-l1 → T12-L1): uppercase BOTH vertebra
// letters. Matched per token BEFORE the generic title-casing, which would otherwise lower-case the
// second segment ("L5-s1"). Covers C#-T#, T#-L#, L#-S#, L#-L#, etc.
const SPINAL_LEVEL = /^([clts])(\d{1,2})-([clts])(\d{1,2})$/i;

// Canonical labels for the common conditions (key = punctuation-stripped lowercase). Syncs the
// OSA / "sleep apnea" variants to ONE label.
const CANON: Record<string, string> = {
  osa: 'Obstructive Sleep Apnea (OSA)',
  'sleep apnea': 'Obstructive Sleep Apnea (OSA)',
  'sleep apnea osa': 'Obstructive Sleep Apnea (OSA)',
  'obstructive sleep apnea': 'Obstructive Sleep Apnea (OSA)',
  'obstructive sleep apnea osa': 'Obstructive Sleep Apnea (OSA)',
  ptsd: 'PTSD',
  'posttraumatic stress disorder': 'PTSD',
  'post traumatic stress disorder': 'PTSD',
  gerd: 'GERD',
  'gerd gastritis': 'GERD / Gastritis',
  'gastroesophageal reflux disease': 'GERD',
  tbi: 'Traumatic Brain Injury (TBI)',
  'traumatic brain injury': 'Traumatic Brain Injury (TBI)',
  htn: 'Hypertension',
  hypertension: 'Hypertension',
  ed: 'Erectile Dysfunction',
  'erectile dysfunction': 'Erectile Dysfunction',
  'migraines chronic headaches': 'Migraines / Chronic Headaches',
  migraines: 'Migraines',
};

function titleCaseWord(w: string): string {
  const spinal = SPINAL_LEVEL.exec(w);
  if (spinal !== null) {
    return `${spinal[1]!.toUpperCase()}${spinal[2]}-${spinal[3]!.toUpperCase()}${spinal[4]}`;
  }
  const bare = w.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (ACRONYMS.has(bare)) return w.toUpperCase();
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

export function formatConditionLabel(raw?: string | null): string {
  const s = (raw ?? '').trim();
  if (s.length === 0) return '';
  const norm = s.toLowerCase().replace(/[_/()]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (CANON[norm] !== undefined) return CANON[norm]!;
  // Generic: underscores/slashes → spaces, title-case each word, keep acronyms uppercase.
  return s.replace(/_/g, ' ').replace(/\s*\/\s*/g, ' / ').replace(/\s+/g, ' ').trim()
    .split(' ')
    .map((w) => (w === '/' ? '/' : titleCaseWord(w)))
    .join(' ');
}
