/**
 * Re-derive the assign-drawer prefill fields (DOB, claim type, state, name, email, phone, condition)
 * from a Jotform submission's stored `rawAnswersJson`.
 *
 * WHY this exists: the jotform-ingest worker is the primary writer of the `submitted*` columns, but
 * (a) the 25+ intakes ingested before the worker started sending `submittedDob` have a NULL DOB even
 * though the answer is sitting in rawAnswersJson, and (b) the worker truncated full state names to two
 * chars ("Texas" -> "TE"). Rather than migrate data or re-run the worker (its PATCH is forward-only),
 * the read endpoints fill any NULL/garbled `submitted*` field from this derivation. Self-healing: works
 * for every existing row and is a no-op once the worker has populated the column correctly.
 *
 * This intentionally mirrors workers/jotform-ingest/handler.py `_parse_submission` / `_normalize_dob`.
 * Keep the two in sync when the heuristics change.
 */

type RawAnswer = { type?: string; name?: string; text?: string; answer?: unknown; prettyFormat?: string };
export type DerivedIntakeFields = {
  name?: string; email?: string; phone?: string; state?: string;
  condition?: string; dob?: string; claimType?: string;
  veteranTheory?: string;       // the veteran's free-text "why I think this is service-connected" narrative
  upstreamCondition?: string;   // the SECONDARY anchor the veteran themselves named ("secondary to PTSD")
  framing?: string;             // 'secondary' | 'aggravation' — derived from the veteran's wording
};

// Veterans ROUTINELY state the secondary link themselves ("secondary to my PTSD", "caused or aggravated by
// my lumbar spine", "2nd to sinusitis"). Dropping it is why every case defaulted to "direct" in Aegis
// (Ryan 2026-06-07, verified against ~30 live Jotform submissions). Parse the upstream anchor + framing
// from their words. Heuristic, first-match-wins; the drafter's framingGate refines it downstream.
// Recognized upstream conditions — the anchor must contain one of these, so we NEVER set a garbage anchor
// ("service I wake up with headaches"). If none matches we leave the case direct; the pathway suggester
// (which scans granted SC conditions for a Board pair) still catches a viable secondary.
const SECONDARY_ANCHOR_KEYWORDS: readonly string[] = [
  'ptsd', 'mental health', 'depression', 'mdd', 'anxiety', 'tinnitus', 'sleep apnea', 'osa', 'gerd',
  'gastritis', 'hypertension', 'lumbar', 'back', 'spine', 'sciatica', 'radiculopathy', 'knee', 'hip',
  'shoulder', 'ankle', 'plantar', 'sinusitis', 'rhinitis', 'asthma', 'migraine', 'diabetes', 'neuropathy',
  'tbi', 'arthritis', 'thyroid', 'parkinson',
];

/** Does a stored upstream value look like a real condition (vs. a garbage phrase from a loose parse)? */
export function isRecognizedSecondaryAnchor(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return SECONDARY_ANCHOR_KEYWORDS.some((k) => v.includes(k));
}

export function parseSecondaryFraming(text: string): { upstream: string; framing: string } | undefined {
  const m = text.match(/\b(?:secondary to|2nd to|caused by|aggravated by|exacerbated by|due to)\s+(?:(?:a|an|the|my)\s+)?(?:service[- ]connected\s+)?([A-Za-z][A-Za-z0-9 /'’()-]{2,50}?)(?=\s+(?:and|or|because|which|that|due|rated|condition)\b|[.,;]|\s*$)/i);
  if (!m) return undefined;
  const raw = m[1].trim().toLowerCase();
  // Conservative: only accept when the captured phrase contains a recognized condition; normalize TO that
  // keyword (clean), never the raw phrase. Avoids "service I wake up with headaches" / "a service-connected".
  const hit = SECONDARY_ANCHOR_KEYWORDS.find((k) => raw.includes(k));
  if (hit === undefined) return undefined;
  return { upstream: hit, framing: /aggravat|exacerbat|worsen/i.test(text) ? 'aggravation' : 'secondary' };
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const STATE_ABBR: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

export function toStateAbbr(s: string | null | undefined): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = s.trim();
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
  return STATE_ABBR[t.toLowerCase()];
}

function isoDate(year: unknown, month: unknown, day: unknown): string | undefined {
  const y = Number.parseInt(String(year).trim(), 10);
  const d = Number.parseInt(String(day).trim(), 10);
  const ms = String(month).trim().toLowerCase();
  const mm = /^\d+$/.test(ms) ? Number.parseInt(ms, 10) : (MONTHS[ms] ?? (MONTHS[Object.keys(MONTHS).find((k) => k.startsWith(ms.slice(0, 3))) ?? ''] ?? 0));
  if (!Number.isFinite(y) || !Number.isFinite(d) || mm < 1 || mm > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return undefined;
  return `${String(y).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function normalizeDob(answer: unknown, pretty?: unknown): string | undefined {
  if (answer && typeof answer === 'object') {
    const o = answer as Record<string, unknown>;
    const iso = isoDate(o['year'], o['month'], o['day']);
    if (iso) return iso;
  }
  for (const raw of [typeof answer === 'string' ? answer : undefined, typeof pretty === 'string' ? pretty : undefined]) {
    if (!raw) continue;
    const s = raw.trim();
    let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s); // ISO-ish
    if (m) { const iso = isoDate(m[1], m[2], m[3]); if (iso) return iso; }
    m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s); // US MM/DD/YYYY
    if (m) { const iso = isoDate(m[3], m[1], m[2]); if (iso) return iso; }
    m = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s); // Month DD, YYYY
    if (m) { const iso = isoDate(m[3], m[1], m[2]); if (iso) return iso; }
  }
  return undefined;
}

function normalizeClaimType(s: unknown): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = s.trim().toLowerCase();
  if (!t) return undefined;
  if (t.includes('supplement')) return 'supplemental';
  if (t.includes('higher') || t === 'hlr') return 'hlr';
  if (t.includes('appeal') || t.includes('disagree') || t === 'nod' || t.includes('board')) return 'appeal_bva'; // canonical ClaimType enum value (NOT 'appeal' — would break assign) (architect QA 2026-06-07)
  if (t.includes('initial') || t.includes('original') || t.includes('new') || t.includes('first')) return 'initial';
  return undefined;
}

export function deriveIntakeFields(rawAnswers: unknown): DerivedIntakeFields {
  const out: DerivedIntakeFields = {};
  if (!rawAnswers || typeof rawAnswers !== 'object') return out;
  let priorDenial = false;
  for (const a of Object.values(rawAnswers as Record<string, RawAnswer>)) {
    if (!a || typeof a !== 'object') continue;
    const type = (a.type ?? '').toLowerCase();
    const name = (a.name ?? '').toLowerCase();
    const text = (a.text ?? '').toLowerCase();
    const label = `${name} ${text}`;
    const ans = a.answer;
    const ansStr = typeof ans === 'string' ? ans : '';

    if (type === 'control_fileupload' || type.includes('upload')) continue;
    if (type === 'control_fullname' && ans && typeof ans === 'object') {
      const o = ans as Record<string, unknown>;
      const full = [o['first'], o['last']].filter(Boolean).join(' ').trim();
      if (full) out.name ??= full;
      continue;
    }
    if (type === 'control_email' && ansStr) { out.email ??= ansStr; continue; }
    if (type === 'control_phone') {
      out.phone ??= (a.prettyFormat || (typeof ans === 'string' ? ans : undefined)) ?? undefined;
      continue;
    }
    if (type === 'control_datetime' || type === 'control_birthdate' || name.includes('dob') || /birth/.test(label)) {
      out.dob ??= normalizeDob(ans, a.prettyFormat);
      continue;
    }
    // prior-denial signal → supplemental (overrides any framing-style "claim type" field)
    if (/denial|denied|va decided|prior decision/.test(label) && /yes|denied/.test(ansStr.toLowerCase())) priorDenial = true;
    if (out.name === undefined && /name/.test(label) && ansStr) out.name = ansStr;
    if (/\bstate\b/.test(label) && ansStr) out.state ??= toStateAbbr(ansStr) ?? ansStr.slice(0, 2).toUpperCase();
    if (/condition/.test(label) && ansStr) out.condition ??= ansStr;
    // The "why do you think this is service-connected" narrative — the case in one sentence; surfaced
    // pre-draft so the RN/physician sees the veteran's own theory. A real narrative, not a yes/no.
    if (out.veteranTheory === undefined && /why|connect|believe|caused|relate|in[- ]service|theory|happened|explain|describe/.test(label) && ansStr.trim().length > 25) {
      out.veteranTheory = ansStr.trim().slice(0, 2000);
    }
    // The veteran's own secondary framing ("secondary to PTSD", "caused by my lumbar spine") — captured
    // from ANY answer so the case isn't defaulted to "direct" when they explicitly stated the link.
    if (out.upstreamCondition === undefined && ansStr.trim().length > 8) {
      const sec = parseSecondaryFraming(ansStr);
      if (sec) { out.upstreamCondition = sec.upstream; out.framing = sec.framing; }
    }
    if (out.claimType === undefined && /claim/.test(label) && /type/.test(label)) out.claimType = normalizeClaimType(ansStr);
    if (out.email === undefined && ansStr.includes('@') && ansStr.includes('.')) out.email = ansStr;
  }
  if (priorDenial) out.claimType = 'supplemental';
  return out;
}

/** Return a copy of an intake row with any NULL/garbled submitted* field filled from rawAnswersJson. */
export function fillIntakeDerived<T extends Record<string, unknown>>(row: T): T {
  const d = deriveIntakeFields((row as { rawAnswersJson?: unknown }).rawAnswersJson);
  const r = { ...row } as Record<string, unknown>;
  const blank = (v: unknown): boolean => v === null || v === undefined || v === '';
  if (blank(r['submittedDob']) && d.dob) r['submittedDob'] = d.dob;
  if (blank(r['submittedClaimType']) && d.claimType) r['submittedClaimType'] = d.claimType;
  if (blank(r['submittedName']) && d.name) r['submittedName'] = d.name;
  if (blank(r['submittedEmail']) && d.email) r['submittedEmail'] = d.email;
  if (blank(r['submittedPhone']) && d.phone) r['submittedPhone'] = d.phone;
  if (blank(r['submittedCondition']) && d.condition) r['submittedCondition'] = d.condition;
  // State: also FIX a 2-char truncation of a full name (Texas -> "TE") when we can recover the abbr.
  const stateAbbr = d.state && /^[A-Z]{2}$/.test(d.state) ? d.state : undefined;
  if (stateAbbr && (blank(r['submittedState']) || r['submittedState'] !== stateAbbr)) r['submittedState'] = stateAbbr;
  return r as T;
}
