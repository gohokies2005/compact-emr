// Canonical condition catalog — the single source of truth for the condition dropdown the
// RNs use when entering a veteran's SC condition or a case's claimed condition.
//
// The list is sourced DIRECTLY from the BVA pair atlas (src/data/bva_secondary_pairs.json) —
// the exact same dataset the CDS engine (services/cdsEngine.ts) looks conditions up in. By
// offering RNs only these canonical labels, a dropdown selection always normalizes to a key
// the CDS engine can match (cdsEngine.matchKey), so we stop generating "No BVA pair data"
// because of free-text spelling drift.
//
// The atlas is a flat upstream->claimed map with no body-system grouping, so we apply a static
// body-system map below keyed off the canonical labels. Any catalog label not explicitly mapped
// falls into "Other" (a unit test asserts every label is mapped so this never silently happens).

import bvaData from '../data/bva_secondary_pairs.json' with { type: 'json' };

export interface ConditionOption {
  readonly value: string;
  readonly label: string;
  // True for SUPPLEMENTAL conditions that are NOT in the BVA atlas — the CDS engine has no pair
  // odds for them so it returns caution/no-odds (correct + acceptable). The frontend may show a
  // "no BVA data" hint. Omitted (undefined) for atlas-backed conditions.
  readonly noBvaData?: boolean;
}

export interface ConditionGroup {
  readonly system: string;
  readonly conditions: readonly ConditionOption[];
}

export interface ConditionsCatalog {
  readonly groups: readonly ConditionGroup[];
}

interface PairStats {
  readonly n: number;
}
const PAIRS = (bvaData as unknown as { pairs: Record<string, Record<string, PairStats>> }).pairs;

// Union of every condition that appears in the atlas as either an upstream OR a claimed condition.
function canonicalConditions(): string[] {
  const set = new Set<string>();
  for (const upstream of Object.keys(PAIRS)) {
    set.add(upstream);
    for (const claimed of Object.keys(PAIRS[upstream])) set.add(claimed);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

// Display order of body systems (groups with no members are dropped before serving).
export const SYSTEM_ORDER: readonly string[] = [
  'Musculoskeletal',
  'Respiratory / Sleep',
  'Mental health',
  'Cardiovascular',
  'Endocrine',
  'Neurological',
  'GI',
  'GU',
  'Skin',
  'Auditory',
  'Other',
] as const;

// Static body-system assignment for each canonical label. Keys MUST exactly match the atlas
// labels (a test asserts every canonical condition has an entry here so none fall to "Other"
// by accident).
const SYSTEM_BY_CONDITION: Record<string, string> = {
  // Musculoskeletal
  'Ankle': 'Musculoskeletal',
  'Cervical / neck': 'Musculoskeletal',
  'Chronic pain syndrome': 'Musculoskeletal',
  'Fibromyalgia': 'Musculoskeletal',
  'Hip': 'Musculoskeletal',
  'Knee': 'Musculoskeletal',
  'Lumbar / back': 'Musculoskeletal',
  'Plantar fasciitis / foot': 'Musculoskeletal',
  'Radiculopathy': 'Musculoskeletal',
  'Shoulder': 'Musculoskeletal',
  'TMJ': 'Musculoskeletal',
  'Wrist': 'Musculoskeletal',
  'Carpal tunnel': 'Musculoskeletal',
  // Respiratory / Sleep
  'Asthma': 'Respiratory / Sleep',
  'COPD': 'Respiratory / Sleep',
  'Obstructive sleep apnea': 'Respiratory / Sleep',
  'Sinusitis / rhinitis': 'Respiratory / Sleep',
  'Insomnia': 'Respiratory / Sleep',
  // Mental health
  'Acquired psychiatric (unspecified)': 'Mental health',
  'Alcohol use disorder': 'Mental health',
  'Anxiety / GAD': 'Mental health',
  'MDD / Depression': 'Mental health',
  'PTSD': 'Mental health',
  // Cardiovascular
  'Atrial fibrillation': 'Cardiovascular',
  'Hypertension': 'Cardiovascular',
  'Ischemic heart disease': 'Cardiovascular',
  'Stroke / CVA': 'Cardiovascular',
  // Endocrine
  'Diabetes type 2': 'Endocrine',
  'Hypothyroidism': 'Endocrine',
  'Obesity': 'Endocrine',
  // Neurological
  'Migraines / headaches': 'Neurological',
  'Peripheral neuropathy': 'Neurological',
  'TBI': 'Neurological',
  'Vertigo / Meniere': 'Neurological',
  // GI
  'GERD': 'GI',
  'Gastritis / ulcer': 'GI',
  'IBS': 'GI',
  // GU
  'Erectile dysfunction': 'GU',
  // Skin
  'Skin (eczema/psoriasis/dermatitis)': 'Skin',
  // Auditory
  'Hearing loss': 'Auditory',
  'Tinnitus': 'Auditory',
};

// SUPPLEMENTAL canonical conditions that are NOT in the BVA atlas. RNs need to claim these even
// though the CDS engine has no pair odds for them (it returns caution/no-odds, which is correct).
// Each carries its body system. The "Unspecified <system> condition" entries are catch-alls pinned
// LAST within their group (an RN should reach for a specific condition first). One per system that
// has real atlas members.
interface SupplementalCondition {
  readonly label: string;
  readonly system: string;
  // true => render as the pinned-last "Unspecified …" catch-all within its group.
  readonly unspecified?: boolean;
}

const SUPPLEMENTAL_CONDITIONS: readonly SupplementalCondition[] = [
  { label: 'CHF / congestive heart failure', system: 'Cardiovascular' },
  { label: 'Unspecified musculoskeletal condition', system: 'Musculoskeletal', unspecified: true },
  { label: 'Unspecified respiratory / sleep condition', system: 'Respiratory / Sleep', unspecified: true },
  { label: 'Unspecified mental health condition', system: 'Mental health', unspecified: true },
  { label: 'Unspecified cardiovascular condition', system: 'Cardiovascular', unspecified: true },
  { label: 'Unspecified endocrine condition', system: 'Endocrine', unspecified: true },
  { label: 'Unspecified neurological condition', system: 'Neurological', unspecified: true },
  { label: 'Unspecified GI condition', system: 'GI', unspecified: true },
  { label: 'Unspecified GU condition', system: 'GU', unspecified: true },
  { label: 'Unspecified skin condition', system: 'Skin', unspecified: true },
  { label: 'Unspecified auditory condition', system: 'Auditory', unspecified: true },
];

const SUPPLEMENTAL_BY_LABEL: Record<string, SupplementalCondition> = Object.fromEntries(
  SUPPLEMENTAL_CONDITIONS.map((s) => [s.label, s]),
);

function systemFor(condition: string): string {
  return SYSTEM_BY_CONDITION[condition] ?? 'Other';
}

// The body system for a catalog label (atlas OR supplemental), or null for unknown/free-text. The
// case-create same-system guard and the CDS multi-eval both use this to classify a claimed
// condition. Returns null (not 'Other') for labels we can't classify so callers can treat unknown
// free-text as exempt from the same-system check.
export function systemForCondition(label: string): string | null {
  const trimmed = label.trim();
  if (trimmed.length === 0) return null;
  if (trimmed in SYSTEM_BY_CONDITION) return SYSTEM_BY_CONDITION[trimmed] ?? null;
  const supplemental = SUPPLEMENTAL_BY_LABEL[trimmed];
  if (supplemental) return supplemental.system;
  return null;
}

// The list of canonical labels (sorted), exposed for tests/diagnostics. Includes supplementals.
export function canonicalConditionLabels(): readonly string[] {
  return [...canonicalConditions(), ...SUPPLEMENTAL_CONDITIONS.map((s) => s.label)].sort((a, b) =>
    a.localeCompare(b),
  );
}

// Build the grouped catalog: conditions sorted alphabetically within each system, systems in the
// SYSTEM_ORDER above, empty systems omitted.
interface CatalogEntry {
  readonly option: ConditionOption;
  readonly unspecified: boolean;
}

export function buildConditionsCatalog(): ConditionsCatalog {
  const bySystem = new Map<string, CatalogEntry[]>();
  const push = (system: string, entry: CatalogEntry): void => {
    const list = bySystem.get(system);
    if (list) list.push(entry);
    else bySystem.set(system, [entry]);
  };

  for (const condition of canonicalConditions()) {
    push(systemFor(condition), { option: { value: condition, label: condition }, unspecified: false });
  }
  for (const s of SUPPLEMENTAL_CONDITIONS) {
    push(s.system, { option: { value: s.label, label: s.label, noBvaData: true }, unspecified: s.unspecified === true });
  }

  const groups: ConditionGroup[] = [];
  for (const system of SYSTEM_ORDER) {
    const entries = bySystem.get(system);
    if (entries && entries.length > 0) {
      // Specific conditions alphabetically first; "Unspecified …" catch-alls pinned LAST.
      entries.sort((a, b) => {
        if (a.unspecified !== b.unspecified) return a.unspecified ? 1 : -1;
        return a.option.label.localeCompare(b.option.label);
      });
      groups.push({ system, conditions: entries.map((e) => e.option) });
    }
  }
  return { groups };
}
