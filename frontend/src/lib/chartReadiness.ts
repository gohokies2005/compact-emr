// Pure chart-readiness derivations (2026-06-16, Phase 2 of the Overview restructure).
//
// Extracted from SendToDrafterPanel so the readiness query can be owned by a shared hook (the cards
// must keep polling after the panel unmounts when a draft goes in-flight). Pure + unit-pinned so the
// load-bearing logic is locked independent of render — in particular the P0 anti-hollow-letter rule
// (extract_failed disables the button even when ready:true) and the dead-spot rule (the auto-resume
// gate must read the RAW `buildingFromExtraction`, never a UI-flavored stillBuilding that folds in the
// mutation's armed flag — that tautology is the bug this split structurally prevents).

import type { ChartReadinessResult, ChartReadinessBlockingFile } from '../api/chart-readiness';
import type { CompletenessState } from '../components/ViabilityInputSet';

export interface DerivedReadiness {
  /** OCR/file-read readiness (readiness.ready). */
  readonly ready: boolean;
  /** RAW query truth: the full-read extraction is still running. THIS is the auto-resume gate — never
   *  fold the mutation's armed flag into it (that re-creates the dead-spot bug). */
  readonly buildingFromExtraction: boolean;
  /** The extraction RUN failed — the P0 gate: keep the draft button disabled even if `ready` is true. */
  readonly extractFailed: boolean;
  readonly gaps: { readonly truncatedWindows: number; readonly uncoveredPages: number } | null;
  readonly hasGaps: boolean;
  readonly blockingFiles: readonly ChartReadinessBlockingFile[];
  /** Query-only completeness: null while building (the verdict cards stay quiet until it's real). */
  readonly completeness: CompletenessState | null;
}

/** Poll predicate for the readiness query: poll while building, stop once settled. */
export function readinessPollInterval(data: ChartReadinessResult | undefined): number | false {
  const st = data?.extractionState;
  return st === 'extracting' || st === 'ocr_in_progress' ? 8000 : false;
}

/** Derive the readiness booleans + completeness from a readiness payload. Pure; tolerates undefined. */
export function deriveReadiness(data: ChartReadinessResult | undefined): DerivedReadiness {
  const ready = data?.ready === true;
  const buildingFromExtraction = data?.extractionState === 'extracting' || data?.extractionState === 'ocr_in_progress';
  const extractFailed = data?.extractionState === 'extract_failed';
  const gaps = data?.extractionGaps ?? null;
  const hasGaps = gaps != null && (gaps.truncatedWindows > 0 || gaps.uncoveredPages > 0);
  const blockingFiles = data?.blockingFiles ?? data?.blockers ?? [];
  const completeness: CompletenessState | null = buildingFromExtraction
    ? null
    : {
        unreadFileCount: blockingFiles.length,
        uncoveredPages: gaps?.uncoveredPages ?? 0,
        truncatedWindows: gaps?.truncatedWindows ?? 0,
      };
  return { ready, buildingFromExtraction, extractFailed, gaps, hasGaps, blockingFiles, completeness };
}
