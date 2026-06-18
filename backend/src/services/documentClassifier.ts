/**
 * Deterministic document classifier (Ryan 2026-06-18: "it should NOT be hard to see a file named
 * 'VA SC active conditions' or 'VA OSA denial' — Misc 1-12 is worthless").
 *
 * Pure, $0, no LLM: scans a document's extracted text for the structural signatures VA records carry
 * and returns a docType + a human display title. The chart-extract worker already reads every page, so
 * classification rides that free read (no extra model spend). Falls back to the original filename when
 * nothing matches — "Misc" can still happen, but a recognizable doc never stays "Misc".
 *
 * Design notes:
 *  - Signatures are matched against a generous text window (not just page 1) because the IDENTIFYING
 *    text often sits deep — e.g. a VA decision letter opens with a cover page and the "Rating Decision /
 *    Service connection for X is denied" language is pages later (Woodley: cover p.1, decision p.13+).
 *  - VA rating decisions get an OUTCOME (denied/granted) and, when detectable, the CONDITION, so the
 *    title reads "VA Rating Decision — GERD denied" rather than a bare type.
 *  - Order matters: most-specific signatures first; the first confident match wins.
 */

export type DocType =
  | 'va_rating_decision'
  | 'va_benefit_summary'
  | 'dd214'
  | 'blue_button'
  | 'sleep_study'
  | 'dbq'
  | 'cp_exam'
  | 'lay_statement'
  | 'pathology'
  | 'endoscopy'
  | 'operative_note'
  | 'audiology'
  | 'mental_health_note'
  | 'sc_conditions_list'
  | 'imaging'
  | 'lab'
  | 'problem_list'
  | 'medication_list'
  | 'intake_summary'
  | 'other';

export interface DocClassification {
  readonly docType: DocType;
  /** Human display title for the Documents list (null → caller falls back to the filename). */
  readonly title: string | null;
  /** 'high' = a strong structural signature; 'low' = a weak/keyword guess (caller may keep the filename). */
  readonly confidence: 'high' | 'low';
}

// A claimed/condition vocabulary → short label, so a rating-decision title can name the condition.
const CONDITION_LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(gerd|gastroesophageal reflux|gastritis)\b/i, 'GERD'],
  [/\b(obstructive sleep apnea|sleep apnea|\bosa\b)\b/i, 'OSA'],
  [/\b(ptsd|post.?traumatic stress)\b/i, 'PTSD'],
  [/\b(hypertension|high blood pressure)\b/i, 'hypertension'],
  [/\b(diabetes|diabetes mellitus)\b/i, 'diabetes'],
  [/\b(tinnitus)\b/i, 'tinnitus'],
  [/\b(hearing loss)\b/i, 'hearing loss'],
  [/\b(lumbar|low ?back|lumbosacral)\b/i, 'lumbar spine'],
  [/\b(migraine|headache)\b/i, 'migraines'],
  [/\b(radiculopath|sciatica)\b/i, 'radiculopathy'],
  [/\b(depress|anxiety|depressive)\b/i, 'mental health'],
  [/\b(ulcerative colitis|colitis)\b/i, 'colitis'],
];

function detectCondition(text: string): string | null {
  for (const [re, label] of CONDITION_LABELS) if (re.test(text)) return label;
  return null;
}

/** Normalize for matching: collapse whitespace, lower-case. Bounded to a window for speed on huge dumps. */
function windowText(text: string, maxChars = 60_000): string {
  const t = text.length > maxChars ? text.slice(0, maxChars) : text;
  return t.replace(/\s+/g, ' ');
}

/**
 * Classify a document from its filename + extracted text. `text` is the concatenated page text (any
 * length — only a bounded window is scanned). Returns docType + display title + confidence.
 */
export function classifyDocument(input: { filename?: string | null; text?: string | null }): DocClassification {
  const raw = input.text ?? '';
  const w = windowText(raw);
  const lc = w.toLowerCase();
  const fname = (input.filename ?? '').toLowerCase();

  // Intake summary (our own generated cover) — identify so it reads clearly, not "Misc".
  if (/intake summary/i.test(w) || /intake_summary/.test(fname)) {
    return { docType: 'intake_summary', title: 'Intake Summary', confidence: 'high' };
  }

  // VA Rating Decision — the codesheet / decision letter. Strong, specific phrases.
  if (/rating decision|we made a decision on your va benefits|reasons for decision|favorable findings/i.test(w)) {
    const cond = detectCondition(w);
    const denied = /\b(is denied|denial of service connection|previous denial[^.]*confirmed)/i.test(w);
    const granted = /\b(service connection[^.]*is granted|is granted|evaluation of \d{1,3} percent)/i.test(w);
    const outcome = denied ? 'denied' : granted ? 'granted' : null;
    const parts = ['VA Rating Decision'];
    if (cond) parts.push(`— ${cond}${outcome ? ` ${outcome}` : ''}`);
    else if (outcome) parts.push(`— ${outcome}`);
    return { docType: 'va_rating_decision', title: parts.join(' '), confidence: 'high' };
  }

  // VA benefit summary letter (combined rating / entitlement) — distinct from a decision.
  if (/combined (service.connected )?evaluation|benefit summary|summary of benefits|your combined/i.test(w)) {
    return { docType: 'va_benefit_summary', title: 'VA Benefit Summary', confidence: 'high' };
  }

  // VA service-connected conditions / rated-disabilities list (the codesheet-style enumeration) — the
  // authoritative-anchor doc the SC list should come from. Named so the RN can find it at a glance.
  if (/service.connected (conditions|disabilities)\b|list of (your )?service.connected|rated disabilities|your service.connected disabilities/i.test(w)) {
    return { docType: 'sc_conditions_list', title: 'VA service-connected conditions', confidence: 'high' };
  }

  // DD-214 — service / discharge.
  if (/dd form 214|certificate of release or discharge|character of service/i.test(w) || /dd.?214/.test(fname)) {
    return { docType: 'dd214', title: 'DD-214 (service record)', confidence: 'high' };
  }

  // My HealtheVet / Blue Button export — the big self-report dump.
  if (/my ?healthe ?vet|blue button|report generated by my healthevet|va\.gov on /i.test(w)) {
    return { docType: 'blue_button', title: 'VA Blue Button (health record export)', confidence: 'high' };
  }

  // Sleep study / polysomnography.
  if (/polysomnogra|sleep study|apnea.hypopnea index|\bahi\b|titration study|cpap titration/i.test(w)) {
    return { docType: 'sleep_study', title: 'Sleep study', confidence: 'high' };
  }

  // DBQ (Disability Benefits Questionnaire).
  if (/disability benefits questionnaire|\bdbq\b/i.test(w)) {
    const cond = detectCondition(w);
    return { docType: 'dbq', title: cond ? `DBQ — ${cond}` : 'DBQ (Disability Benefits Questionnaire)', confidence: 'high' };
  }

  // C&P examination.
  if (/compensation and pension|\bc&p exam|c & p exam/i.test(w)) {
    const cond = detectCondition(w);
    return { docType: 'cp_exam', title: cond ? `C&P exam — ${cond}` : 'C&P exam', confidence: 'high' };
  }

  // Lay / buddy / personal statement.
  if (/lay statement|buddy statement|statement in support of claim|\bva form 21-4138\b/i.test(w)) {
    return { docType: 'lay_statement', title: 'Lay / buddy statement', confidence: 'high' };
  }

  // Pathology.
  if (/pathology report|surgical pathology|specimen.*(microscopic|gross description)|histolog/i.test(w)) {
    return { docType: 'pathology', title: 'Pathology report', confidence: 'high' };
  }

  // Endoscopy / EGD / colonoscopy (Ryan called out "EGD report" specifically).
  if (/esophagogastroduodenoscopy|upper endoscopy|\begd\b|gastroscopy|colonoscopy/i.test(w)) {
    const cond = detectCondition(w);
    return { docType: 'endoscopy', title: cond ? `Endoscopy report — ${cond}` : 'Endoscopy report', confidence: 'high' };
  }

  // Operative / procedure note.
  if (/operative report|operative note|postoperative diagnosis|procedure performed:|pre-?operative diagnosis/i.test(w)) {
    return { docType: 'operative_note', title: 'Operative / procedure note', confidence: 'high' };
  }

  // Audiology / hearing test.
  if (/audiogram|audiometry|pure ?tone average|speech recognition (threshold|score)|\bpta\b.*\bdb\b/i.test(w)) {
    return { docType: 'audiology', title: 'Audiology / hearing test', confidence: 'high' };
  }

  // Mental-health / psychiatric note.
  if (/psychiatr(y|ic)|psychotherapy|mental health (note|assessment|evaluation)|psychological evaluation|\bphq-9\b|\bpcl-5\b/i.test(w)) {
    return { docType: 'mental_health_note', title: 'Mental health note', confidence: 'low' };
  }

  // Imaging / radiology.
  if (/impression:.*(ct |mri|x-ray|radiograph)|radiology report|findings:.*(ct |mri|contrast)/i.test(w)) {
    return { docType: 'imaging', title: 'Imaging / radiology', confidence: 'low' };
  }

  // Standalone problem list / medication list (when not part of a Blue Button).
  if (/active problem list|problem list\b/i.test(w) && !/medication/i.test(lc.slice(0, 200))) {
    return { docType: 'problem_list', title: 'Active Problem List', confidence: 'low' };
  }
  if (/active medications|medication list|outpatient medications/i.test(w)) {
    return { docType: 'medication_list', title: 'Medication list', confidence: 'low' };
  }

  return { docType: 'other', title: null, confidence: 'low' };
}
