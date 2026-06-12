/**
 * Golden-pack fixture (assessment 2026-06-12 §1): a 3-page VA denial letter. Pages 1-2 are
 * the denial narrative Ryan explicitly wants IN the pack ("not just SC conditions but denials
 * with explanations"); page 3 is appeal boilerplate. Page 2 deliberately carries ONLY weak
 * tokens ("is denied") — it must ride in on the strong anchors that fired on page 1.
 */
export const DENIAL_LETTER_PAGES: readonly string[] = [
  // p1 — denial decision + REASONS FOR DECISION header (STRONG anchors).
  `DEPARTMENT OF VETERANS AFFAIRS
Regional Office

Dear Veteran:

We made a decision on your claim for service connection for anxiety received
on October 2, 2024. We denied service connection for anxiety.

REASONS FOR DECISION

Service connection for anxiety is denied because the evidence does not show a
link between your current anxiety and your military service, nor a diagnosis
in service.`,

  // p2 — narrative continuation (weak-token-only page; no strong anchor on this page).
  `The VA examiner reviewed your claims file and opined that your anxiety was
less likely than not incurred in or caused by your active duty service. Your
private treatment records show treatment for anxiety beginning in 2019, more
than ten years after your separation from service. Because the evidence does
not establish a nexus to service, the claimed condition of generalized
anxiety disorder is denied.`,

  // p3 — appeal boilerplate.
  `Your Rights to Appeal Our Decision

If you disagree with our decision, you may file a Notice of Disagreement and
request review. You may also complete VA Form 9 to request appellate review by
the Board of Veterans' Appeals. Your appeal rights are explained in the
enclosed pamphlet.`,
];
