// Recommended-plan — BACK-COMPAT SHIM (2026-06-18). The plan selector now lives in the ONE-BRAIN
// caseReadinessVerdict module (which also produces the reconciled top-line verdict). This re-exports
// the same `recommendedPlan()` function + types so existing consumers (RecommendedPlanCard, its tests)
// are unchanged and there is exactly ONE implementation of the plan logic — no second brain to drift.
export {
  recommendedPlan,
  type RecommendationKind,
  type RecommendedPlan,
  type RecommendedPlanInputs,
} from './caseReadinessVerdict';
