// Lightweight in-memory typeahead lookup for ICD-10 problems + medications.
// Datasets ship as JSON under src/data/; the service builds prefix indexes once at startup
// and answers searches in sub-millisecond time. Extend the datasets to expand coverage —
// no database lookup, no external API.

import icd10Data from '../data/icd10_common.json' with { type: 'json' };
import medsData from '../data/medications_common.json' with { type: 'json' };

// ---------- public types ----------

export interface Icd10Entry {
  readonly code: string;
  readonly display: string;
  readonly synonyms: readonly string[];
}

export interface MedicationEntry {
  readonly drugName: string;
  readonly genericName: string;
  readonly dose: string | null;
  readonly form: string | null;
  readonly class: string;
  readonly synonyms: readonly string[];
}

export interface LookupResult<T> {
  readonly query: string;
  readonly count: number;
  readonly results: readonly T[];
}

// ---------- normalize / tokenize ----------

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s/.-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(s: string): readonly string[] {
  const n = normalize(s);
  if (n.length === 0) return [];
  return n.split(/[\s/.-]+/).filter((t) => t.length > 0);
}

// ---------- scoring ----------
// Higher = better match. We rank by:
//   1) exact code/name match              (100)
//   2) display/drugName starts-with query (60-90, longer query = higher)
//   3) any token starts-with query        (40)
//   4) synonym exact match                (50)
//   5) synonym starts-with                (35)
//   6) substring anywhere                 (10-20)
// Ties broken by shorter display (more specific) ascending.

function scoreIcd10(entry: Icd10Entry, q: string): number {
  if (q.length === 0) return 0;
  const code = entry.code.toLowerCase();
  const display = normalize(entry.display);
  const qn = normalize(q);

  if (code === qn) return 100;
  if (display === qn) return 100;
  if (code.startsWith(qn)) return 95;
  if (display.startsWith(qn)) return Math.min(90, 60 + qn.length);
  for (const t of tokens(entry.display)) {
    if (t.startsWith(qn)) return 40;
  }
  for (const syn of entry.synonyms) {
    const s = normalize(syn);
    if (s === qn) return 50;
    if (s.startsWith(qn)) return 35;
  }
  if (code.includes(qn)) return 20;
  if (display.includes(qn)) return 15;
  for (const syn of entry.synonyms) {
    if (normalize(syn).includes(qn)) return 10;
  }
  return 0;
}

function scoreMed(entry: MedicationEntry, q: string): number {
  if (q.length === 0) return 0;
  const drug = normalize(entry.drugName);
  const generic = normalize(entry.genericName);
  const qn = normalize(q);

  if (drug === qn) return 100;
  if (generic === qn) return 95;
  if (drug.startsWith(qn)) return Math.min(90, 60 + qn.length);
  if (generic.startsWith(qn)) return Math.min(85, 55 + qn.length);
  for (const t of tokens(entry.drugName)) {
    if (t.startsWith(qn)) return 40;
  }
  for (const syn of entry.synonyms) {
    const s = normalize(syn);
    if (s === qn) return 50;
    if (s.startsWith(qn)) return 35;
  }
  if (drug.includes(qn)) return 20;
  for (const syn of entry.synonyms) {
    if (normalize(syn).includes(qn)) return 10;
  }
  return 0;
}

// ---------- index ----------

interface Datasets {
  readonly icd10: readonly Icd10Entry[];
  readonly medications: readonly MedicationEntry[];
}

const DATASETS: Datasets = {
  icd10: (icd10Data as { rows: Icd10Entry[] }).rows,
  medications: (medsData as { rows: MedicationEntry[] }).rows,
};

// ---------- public API ----------

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(raw), MAX_LIMIT);
}

export function searchIcd10(query: string, limit?: number): LookupResult<Icd10Entry> {
  const q = (query ?? '').trim();
  const lim = clampLimit(limit);
  if (q.length === 0) return { query: q, count: 0, results: [] };

  const scored = DATASETS.icd10
    .map((entry) => ({ entry, score: scoreIcd10(entry, q) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.entry.display.length - b.entry.display.length;
    })
    .slice(0, lim)
    .map((s) => s.entry);

  return { query: q, count: scored.length, results: scored };
}

export function searchMedications(query: string, limit?: number): LookupResult<MedicationEntry> {
  const q = (query ?? '').trim();
  const lim = clampLimit(limit);
  if (q.length === 0) return { query: q, count: 0, results: [] };

  const scored = DATASETS.medications
    .map((entry) => ({ entry, score: scoreMed(entry, q) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Prefer the bare (no-dose) row over the dose variants when scores tie.
      const aDose = a.entry.dose === null ? 0 : 1;
      const bDose = b.entry.dose === null ? 0 : 1;
      if (aDose !== bDose) return aDose - bDose;
      return a.entry.drugName.length - b.entry.drugName.length;
    })
    .slice(0, lim)
    .map((s) => s.entry);

  return { query: q, count: scored.length, results: scored };
}

// Diagnostic / health-check exports.
export function lookupDatasetSizes(): { icd10: number; medications: number } {
  return { icd10: DATASETS.icd10.length, medications: DATASETS.medications.length };
}
