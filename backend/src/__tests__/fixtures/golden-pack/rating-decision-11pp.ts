/**
 * Golden-pack fixture (assessment 2026-06-12 §1): a VA rating decision replicating the LIVE
 * failure shape. Pages 1-2 are the real payload (decision table + REASONS FOR DECISION).
 * Pages 3-11 are the VA enclosure boilerplate that "sailed in" on the first live pack because
 * every enclosure page says "service-connected" and "granted" — exactly like the real letters
 * do. Synthetic text, no PHI.
 *
 * ROUND 2 (backlog §Doctor-pack round 2 B, PCP re-review 2026-06-12): pages 12-16 are the
 * notification-letter species that SURVIVED the first kill-list in the live pack — VALife,
 * VSignals survey, the VA Form 20-0998 "how do I disagree" QR page, the monthly-entitlement
 * payment table, and the commissary/travel/state-benefits enclosure. (Filename says 11pp for
 * historical reasons; the fixture is now 16 pages.)
 */
export const RATING_DECISION_PAGES: readonly string[] = [
  // p1 — the decision table page (STRONG anchors: entitlement-to-X-is, with an evaluation of).
  `DEPARTMENT OF VETERANS AFFAIRS
Regional Office

Rating Decision

DECISION

1. Entitlement to service connection for lumbar strain is granted with an
   evaluation of 40 percent effective March 1, 2025.
2. Entitlement to service connection for tinnitus is granted with an
   evaluation of 10 percent effective March 1, 2025.

EVIDENCE
VA examination dated January 12, 2025; service treatment records; VA treatment
records from the Phoenix VA Medical Center received February 3, 2025.`,

  // p2 — REASONS FOR DECISION narrative. Carries ONE boilerplate phrase in passing
  // ("enclosure") to prove the >=2-distinct-hits density rule keeps real decision pages.
  `REASONS FOR DECISION

Service connection for lumbar strain has been established as directly related
to military service. The VA examination of January 12, 2025 documented forward
flexion of the thoracolumbar spine limited to 25 degrees with objective
evidence of painful motion. An evaluation of 40 percent is assigned because
the evidence shows forward flexion of the thoracolumbar spine 30 degrees or
less. A higher evaluation of 50 percent is not warranted unless the evidence
shows unfavorable ankylosis of the entire thoracolumbar spine. See the
enclosure for more information.`,

  // p3 — "Additional Benefits" enclosure (boilerplate; still says service-connected + granted).
  `What You Should Know About Additional Benefits                    Enclosure 2

Because you are a service-connected veteran whose claim has been granted, you
may be eligible for additional VA benefits. Vocational Rehabilitation and
Employment services may help you train for and obtain suitable employment.
Dependents of veterans rated permanently and totally disabled may be eligible
for Dependents' Educational Assistance.`,

  // p4 — Mental Health Counseling enclosure.
  `Mental Health Counseling

As a veteran who has been granted service-connected compensation, you and your
family members may be eligible for mental health counseling and readjustment
services at no cost. Contact your nearest Vet Center to learn more about
mental health counseling, or ask your local facility about VA medical care
options available to you.`,

  // p5 — VA Medical Care / enrollment enclosure.
  `VA Medical Care

You are eligible to apply for VA health care enrollment. Veterans who have
been granted service-connected status are assigned to a priority group when
they enroll. Your priority group determines how soon you can be scheduled and
whether copayments apply to your care.`,

  // p6 — home loan guaranty enclosure.
  `VA Home Loan Guaranty

As a granted service-connected veteran you may qualify for a VA home loan
guaranty with no down payment. For questions about how to contact a loan
specialist in your area, call our toll-free number during regular business
hours.`,

  // p7 — Government life insurance / S-DVI enclosure.
  `Government Life Insurance

Veterans who have been granted service-connected disabilities may be eligible
for Service-Disabled Veterans Insurance (S-DVI), a government life insurance
program. You must apply within two years from the date you are notified that
your disability is service-connected.`,

  // p8 — Veterans Crisis Line page.
  `Veterans Crisis Line

If you are a veteran in crisis — even if you are not yet service-connected or
have not been granted benefits — free, confidential support is available 24/7.
Dial 988 then Press 1, call 1-800-273-8255, or text 838255 to connect with a
caring, qualified responder.`,

  // p9 — fraud-warning box page.
  `What You Should Know About Reporting Fraud

Anyone who knowingly makes a false or fraudulent claim is subject to criminal
penalty, including veterans already granted service-connected compensation. To
report suspected fraud, call our toll-free hotline. For where to send written
information, see the address listed below.`,

  // p10 — how-to-appeal / VA Form 9 page.
  `How To Appeal Our Decision

If you disagree with this decision you may file a Notice of Disagreement or
complete VA Form 9 to request appellate review by the Board of Veterans'
Appeals. Your appeal rights are described in the enclosure. These rights apply
even for service-connected conditions already granted.`,

  // p11 — combined-rating math table page.
  `How VA Combines Ratings — Combined Ratings Table                  Enclosure 3

When a veteran is service-connected for more than one granted disability, VA
does not add the ratings together. Using the combined ratings table, 40
combined with 10 is 46 percent, which rounds to a combined evaluation of 50
percent.`,

  // p12 — VALife insurance enclosure (Round 2 B: survived the first live pack).
  `VALife — Veterans Affairs Life Insurance

Because your claim has been granted and you are now a service-connected
veteran, you may be eligible for VALife, a guaranteed acceptance whole life
insurance program. There are no medical requirements to enroll.`,

  // p13 — VSignals survey page.
  `We Want to Hear From You — VSignals

You may receive a VSignals customer experience survey about this claim. Please
tell us about your experience; your responses help VA improve services for
service-connected veterans whose claims have been granted.`,

  // p14 — VA Form 20-0998 / "how do I disagree" QR appeal page.
  `What Should You Do If You Disagree With Our Decision?

How do I disagree? You may request a decision review. See VA Form 20-0998,
Your Right to Seek a Decision Review, for your decision review options under
the Appeals Modernization Act, or scan this QR code to review the options for
your granted or denied conditions online.`,

  // p15 — monthly-entitlement payment table page.
  `Payment Information

Your monthly entitlement amount is shown below.
Monthly entitlement amount: $1,361.88    Payment start date: April 1, 2025
Reason for change: service connection granted.`,

  // p16 — commissary / beneficiary-travel / state-benefits enclosure.
  `Other Benefits You May Be Eligible For

Veterans granted a service-connected rating may qualify for commissary and
exchange privileges, beneficiary travel reimbursement for VA medical
appointments, and additional state veterans benefits through your state
veterans affairs office.`,
];
