/**
 * Golden-pack fixture (assessment 2026-06-12 §1): a 4-page private-practice progress-notes
 * document for the anxiety case. Page 2 carries the diagnosis (the page the PCP "refuses to
 * sign without"). Page 4 is the most recent encounter (medication refill, no anxiety mention)
 * — it rides in on the most-recent-encounter rule.
 */
export const PROGRESS_NOTES_PAGES: readonly string[] = [
  // p1 — intake visit, mentions anxiety.
  `Office visit 01/10/2025. Chief complaint: anxiety, poor sleep, irritability.
History of present illness: patient reports persistent worry and panic
symptoms for several years, worsening over the past six months. PHQ-9 and
GAD-7 administered today.`,

  // p2 — THE diagnosis page.
  `Office visit 02/14/2025. Assessment: Generalized anxiety disorder, moderate,
with panic features. Plan: continue escitalopram 10 mg daily, increase to
20 mg if tolerated; weekly cognitive behavioral therapy; follow up in 8 weeks.
Patient verbalized understanding and agreement with the plan.`,

  // p3 — follow-up, mentions anxiety.
  `Office visit 04/11/2025. Anxiety improving on escitalopram 20 mg daily;
patient reports fewer panic episodes and improved sleep continuity. Continue
current regimen. Therapy attendance consistent.`,

  // p4 — most recent encounter, NO anxiety mention (recent-encounter rule must catch it).
  `Office visit 05/30/2025. Medication refill visit. Blood pressure 124/78,
heart rate 72. No acute complaints today. Refills sent to pharmacy on file.
Return to clinic in three months or sooner as needed.`,
];
