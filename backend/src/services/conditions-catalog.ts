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

function systemFor(condition: string): string {
  return SYSTEM_BY_CONDITION[condition] ?? 'Other';
}

// The list of canonical labels (sorted), exposed for tests/diagnostics.
export function canonicalConditionLabels(): readonly string[] {
  return canonicalConditions();
}

// Build the grouped catalog: conditions sorted alphabetically within each system, systems in the
// SYSTEM_ORDER above, empty systems omitted.
export function buildConditionsCatalog(): ConditionsCatalog {
  const bySystem = new Map<string, ConditionOption[]>();
  for (const condition of canonicalConditions()) {
    const system = systemFor(condition);
    const option: ConditionOption = { value: condition, label: condition };
    const list = bySystem.get(system);
    if (list) list.push(option);
    else bySystem.set(system, [option]);
  }

  const groups: ConditionGroup[] = [];
  for (const system of SYSTEM_ORDER) {
    const conditions = bySystem.get(system);
    if (conditions && conditions.length > 0) {
      conditions.sort((a, b) => a.label.localeCompare(b.label));
      groups.push({ system, conditions });
    }
  }
  return { groups };
}
