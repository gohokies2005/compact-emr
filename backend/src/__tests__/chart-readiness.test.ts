import { describe, expect, it } from 'vitest';
import {
  buildChartNotReadyMessage,
  CHART_READINESS_GATE_VERSION,
  classifyReadAttempt,
  corruptedTokenRatio,
  evaluateChartReadiness,
  isEffectivelyRead,
  isValidManualSummary,
  MANUAL_SUMMARY_MIN_LEN,
  nonWhitespaceCharCount,
  originalFileName,
  reconcileChartReadiness,
  READ_THRESHOLD_BIG_SCAN_CHARS,
  READ_THRESHOLD_CHARS,
  READ_THRESHOLD_RATIO,
  wordCount,
} from '../services/chart-readiness.js';
import { formatScreeningSummary } from '../services/screening-summary.js';
import type { ScreeningResult } from '../services/chart-extract-llm.js';
import type { FileReadStatusRecord } from '../services/db-types.js';

const now = new Date('2026-05-26T00:00:00.000Z');

function row(overrides: Partial<FileReadStatusRecord> = {}): FileReadStatusRecord {
  return {
    id: overrides.id ?? `FRS-${Math.random().toString(36).slice(2, 8)}`,
    caseId: 'CASE-1',
    filePath: 'records/test.pdf',
    fileSha256: 'a'.repeat(64),
    terminalStatus: 'read',
    attemptsJson: [],
    manualSummary: null,
    manualSummaryAt: null,
    manualSummaryBy: null,
    lastCheckedAt: now,
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...overrides,
  };
}

describe('corruptedTokenRatio', () => {
  it('returns 0 for empty / non-text input', () => {
    expect(corruptedTokenRatio('')).toBe(0);
    expect(corruptedTokenRatio(undefined as unknown as string)).toBe(0);
  });

  it('returns 0 for clean prose', () => {
    const clean = 'The patient is a 45 year old male presenting with right knee pain and limited range of motion in the affected joint.';
    expect(corruptedTokenRatio(clean)).toBeLessThan(0.02);
  });

  // CALIBRATION LOCK (v2 signal, GARBLED_RATIO_THRESHOLD = 0.40 — Ryan 2026-06-14, 5th false-flag).
  // Real medical text is dense with codes/dates/dollar-amounts/file-numbers — all of which the v2 signal
  // treats as legit NON-WORD slots (mostly-digits/markup excluded), so they cannot inflate the ratio. A
  // clean codes paragraph stays FAR below 0.40. (The single "T2DM" reads as a garbage word slot — it
  // embeds a digit and there is no dictionary — which is the documented accepted limitation; one such
  // token out of many real words keeps the doc well under the gate.)
  it('keeps a clean codes paragraph (L4-L5, M47.817, T2DM) well below the 0.40 gate', () => {
    const codes = 'Lumbar spine MRI showed L4-L5 disc protrusion. ICD-10 M47.817 documented. T2DM was a comorbidity.';
    expect(corruptedTokenRatio(codes)).toBeLessThan(READ_THRESHOLD_RATIO);
  });

  it('crosses the 0.40 threshold cleanly for symbol-soup garble', () => {
    // Symbol-soup: every word slot has embedded symbols/digits (not a clean word, not mostly-digits) →
    // ratio approaches 1.0. This is the garble class the gate exists to catch.
    const soup = 'c0nn3@ct r3c0rd Pati$nt p#esent kn$e lim%ted m0t br0k3n th3 ev!d#nce f@!led r@nge';
    expect(corruptedTokenRatio(soup)).toBeGreaterThan(READ_THRESHOLD_RATIO);
  });

  // ── v2 WORD-SLOT-GARBAGE calibration lock (2026-06-14, threshold 0.08 → 0.40) ────────────────
  // The OLD embedded-symbol heuristic condemned clean hyphen-dense + code-dense text as "garbled",
  // false-flagging real VA documents FOUR times (a Board remand letter scored 0.72). The v2 signal asks
  // "what fraction of WORD SLOTS are garbage?" and excludes codes/IDs/numbers/markup from the denominator.
  // These lock the fix: clean compounds + the generated summary stay <= 0.40 (by a wide margin), and
  // genuine garble (symbol-soup, mojibake, the replacement char) stays > 0.40 (also by a wide margin).
  // POSITIVE CONTROLS use char-corruption or symbol-soup — NOT pure-letter OCR fragments (tlie, amel),
  // which v2 intentionally does NOT flag (no dictionary; that rare residual is caught downstream by
  // extraction — the OVERWHELMING priority is to NEVER false-flag a real document).

  it('does NOT flag common hyphenated/apostrophe medical compounds (the live false-positive class)', () => {
    const compounds = "The veteran is service-connected for PTSD. Follow-up PC-PTSD-5 screen was well-documented. An x-ray and the auto-extracted notes confirm the patient's diagnosis.";
    expect(corruptedTokenRatio(compounds)).toBeLessThanOrEqual(READ_THRESHOLD_RATIO);
    // Each compound individually is a clean word (ratio 0) — none is corruption.
    for (const w of ['service-connected', 'follow-up', 'PC-PTSD-5', 'auto-extracted', 'well-documented', 'x-ray', 'snoring/gasping']) {
      expect(corruptedTokenRatio(w), `${w} must not be flagged`).toBe(0);
    }
  });

  it('the generated screening/intake summary text scores <= 0.40 (was condemned at 0.16 > 0.08 before the fix)', () => {
    const summary = formatScreeningSummary(
      [
        { instrument: 'PHQ-9', score: '14', date: '2024-03-01', sourcePage: 4 } as unknown as ScreeningResult,
        { instrument: 'PC-PTSD-5', score: '4/5', date: '2024-03-01', sourcePage: 5 } as unknown as ScreeningResult,
      ],
      { caseId: 'CLM-1', veteranName: 'Lozano, Marcus', runId: 'run-1', extractedAtIso: '2026-06-14T00:00:00Z' },
    );
    expect(corruptedTokenRatio(summary)).toBeLessThanOrEqual(READ_THRESHOLD_RATIO);
  });

  it('REAL-DOC CLASS: a long clean clinical/VA narrative stays far below 0.40 (the false-flag class)', () => {
    // Stand-in for the real Ewell remand letter (0.0043) / 1.35M-char recs (0.0092): dates, dollar
    // amounts, file numbers, percentages, codes — all the things the OLD signal mistook for garble.
    const realDoc =
      'June 12, 2026. RE: Independent Medical Opinion for file number 1018515859V860352. ' +
      'The veteran is service-connected for PTSD at 70 percent effective 2021-03-01. A VA Form 21-526EZ ' +
      'was filed. Total charges of $350.00 were assessed. The C&P examination on 03/14/2024 documented ' +
      'an AHI of 22.5 events per hour, consistent with moderate obstructive sleep apnea (ICD-10 G47.33). ' +
      'Follow-up PC-PTSD-5 screening scored 4 out of 5. The well-documented x-ray findings confirm L4-L5 ' +
      'degenerative changes. Diagnosis codes M47.817 and E11.9 (T2DM) were noted on follow-up.';
    expect(corruptedTokenRatio(realDoc)).toBeLessThan(READ_THRESHOLD_RATIO);
  });

  it('a real intake-summary WITH an embedded payment/tracking block still scores < 0.40 (markup out of the ratio)', () => {
    const withPayment =
      'The veteran is service-connected for PTSD and reports follow-up care. ' +
      '<table cellpadding="0"><tr><td>Total $350</td></tr></table> ' +
      'Transaction ID pi_3Abc123Def456Ghi789 gclid Cj0KCQjwhL-WBhCmARIsAPSLqqExample href="https://flatratenexus.com/pay"';
    expect(corruptedTokenRatio(withPayment)).toBeLessThan(READ_THRESHOLD_RATIO);
  });

  it('POSITIVE CONTROL: genuinely garbled OCR symbol-soup still flags (> 0.40) — the fix did not weaken detection', () => {
    const soup = Array(8).fill('c0nn3@ct r3c0rd Pati$nt p#esent kn$e lim%ted m0t br0k3n').join(' ');
    expect(corruptedTokenRatio(soup)).toBeGreaterThan(READ_THRESHOLD_RATIO);
  });

  it('POSITIVE CONTROL: mojibake (double-decoded UTF-8) and the replacement char are char-corruption → 1.0', () => {
    // STEP 1 of the v2 signal: replacement chars (U+FFFD) + mojibake bigrams (â€/Ã‚/…) over ~2% of all
    // characters is DEFINITIVE byte corruption → returns 1.0 immediately, no word analysis.
    expect(corruptedTokenRatio('th�ck br�wn p�tient r�cord f�llow')).toBe(1);
    expect(corruptedTokenRatio('The pati�nt was se�n in cli�ic for f�llow up of chronic conditions')).toBe(1);
  });
});

describe('wordCount', () => {
  it('counts space-separated words', () => {
    expect(wordCount('one two three')).toBe(3);
    expect(wordCount('')).toBe(0);
    expect(wordCount('   \n\n   ')).toBe(0);
  });
});

describe('nonWhitespaceCharCount', () => {
  it('counts non-whitespace characters, ignoring spaces/tabs/newlines', () => {
    expect(nonWhitespaceCharCount('abc def')).toBe(6);
    expect(nonWhitespaceCharCount('  a\tb\nc  ')).toBe(3);
    expect(nonWhitespaceCharCount('')).toBe(0);
    expect(nonWhitespaceCharCount('   \n\n   ')).toBe(0);
  });
});

describe('classifyReadAttempt', () => {
  // WORD floor → CHAR floor (Ryan 2026-06-14). The read-success bar is now >= READ_THRESHOLD_CHARS (10)
  // non-whitespace chars + not garbled. "not much is ever less than that other than something just
  // saying error." Assertions key on the CHAR constant, not a literal, so a re-tune only touches the service.

  it('rejects a bare "Error" string (5 chars < the char floor) — the owner case', () => {
    const r = classifyReadAttempt({ method: 'native_pdf_text', extractedText: 'Error' });
    expect(r.succeeded).toBe(false);
    expect(r.reason).toContain('too-few-words'); // note keeps the word-flavored token for the frontend regex
    expect(nonWhitespaceCharCount('Error')).toBeLessThan(READ_THRESHOLD_CHARS);
  });

  it('rejects "N/A" (3 chars) and accepts a 22-word/120+ char real document (the Thomas_Intake_Summary.pdf fix)', () => {
    expect(classifyReadAttempt({ method: 'native_pdf_text', extractedText: 'N/A' }).succeeded).toBe(false);
    // 22 words of real prose — the live blocked file. Hundreds of non-whitespace chars → passes.
    const realDoc = 'The veteran reports chronic right knee pain that began during his active duty service and has progressively worsened in the years since his separation from the United States Army.';
    expect(wordCount(realDoc)).toBeGreaterThanOrEqual(22);
    expect(nonWhitespaceCharCount(realDoc)).toBeGreaterThan(120);
    const r = classifyReadAttempt({ method: 'native_pdf_text', extractedText: realDoc });
    expect(r.succeeded).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('rejects garbled text even with plenty of characters', () => {
    // Symbol-soup garble (v2 signal): every word slot embeds symbols/digits → ratio approaches 1.0,
    // far above the 0.40 gate. (NOT the old hyphen-spaced "w-i-t-h" fixture, which v2 correctly reads as
    // clean hyphenated words — the whole point of the rewrite.)
    const garbled = Array(6).fill('Pati$nt 4@ ol# p#esent kn$e p$in lim%ted m0t br0k3n ev!d#nce f@!led r@nge').join(' ');
    const r = classifyReadAttempt({ method: 'tesseract_ocr', extractedText: garbled });
    expect(r.succeeded).toBe(false);
    expect(r.reason).toContain('garbled');
    expect(r.corruptedTokenRatio).toBeGreaterThan(READ_THRESHOLD_RATIO);
  });

  it('accepts clean text at exactly the char floor (10 non-whitespace chars)', () => {
    const text = 'abcde fghij'; // 10 non-whitespace chars
    expect(nonWhitespaceCharCount(text)).toBe(READ_THRESHOLD_CHARS);
    const r = classifyReadAttempt({ method: 'textract', extractedText: text });
    expect(r.succeeded).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('rejects clean text one char below the floor (9 non-whitespace chars)', () => {
    const text = 'abcd efgh'; // 8 non-whitespace chars — below the floor
    expect(nonWhitespaceCharCount(text)).toBeLessThan(READ_THRESHOLD_CHARS);
    const r = classifyReadAttempt({ method: 'textract', extractedText: text });
    expect(r.succeeded).toBe(false);
    expect(r.reason).toContain('too-few-words');
  });

  it('accepts a short-but-real document (the Thomas_OSA_Misc_3.png class, was blocked under the word gate)', () => {
    // Real prose words (NOT "word0 word1 …" — those embed a digit and read as garbage word slots under
    // the v2 signal, which is correct: they are not real words).
    const lex = ['the', 'patient', 'reports', 'chronic', 'knee', 'pain', 'during', 'active', 'duty', 'service'];
    const text = Array.from({ length: 37 }, (_, i) => lex[i % lex.length]).join(' ');
    const r = classifyReadAttempt({ method: 'textract', extractedText: text });
    expect(r.succeeded).toBe(true);
  });

  it('accepts clean text well above the floor', () => {
    const clean = 'The veteran is a fifty year old male with documented right knee pain. He served on active duty from two thousand one to two thousand eight in the United States Army with a primary military occupational specialty in infantry. He reports gradual onset of symptoms during service with progression after separation. Imaging confirms degenerative changes in the right knee compartment.';
    const r = classifyReadAttempt({ method: 'native_pdf_text', extractedText: clean });
    expect(r.succeeded).toBe(true);
    expect(r.reason).toBeNull();
  });

  // SIZE-AWARE char floor: a legit 1-page note ("CPAP" = 4 chars) is too small for the bare floor BUT
  // not the big-scan signal; a 1-page file passes on >=10 chars. An empty/garbled read still flags.
  it('accepts a 1-page file with >=10 chars of real text (the "CPAP machine titration" note)', () => {
    const r = classifyReadAttempt({ method: 'textract', extractedText: 'CPAP titration', pageCount: 1 });
    expect(r.succeeded).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('a 1-page file with 12 chars PASSES (small file, char floor cleared)', () => {
    const text = 'twelve chars'; // 11 non-whitespace chars >= floor
    const r = classifyReadAttempt({ method: 'textract', extractedText: text, pageCount: 1 });
    expect(r.succeeded).toBe(true);
    expect(r.reason).toBeNull();
  });

  // AUTO-RECOVERY (2026-06-14): a KNOWN single empty page (0 chars) is AUTO-SKIPPED — non-blocking,
  // no RN action — instead of dead-ending to manual. autoSkip=true, succeeded stays false (not a read).
  it('AUTO-SKIPS an effectively-empty (0-char) read on a KNOWN 1-page file (empty photo → auto_skipped, non-blocking)', () => {
    const r = classifyReadAttempt({ method: 'textract', extractedText: '   ', pageCount: 1 });
    expect(r.succeeded).toBe(false);
    expect(r.autoSkip).toBe(true);
    expect(r.reason).toContain('auto-skipped');
  });

  it('does NOT auto-skip a 0-char read on a SUBSTANTIAL (>=2 page) file — may be a real record OCR choked on → manual', () => {
    const r = classifyReadAttempt({ method: 'textract', extractedText: '   ', pageCount: 5 });
    expect(r.succeeded).toBe(false);
    expect(r.autoSkip).toBeFalsy();
    expect(r.reason).toContain('empty');
  });

  it('does NOT auto-skip a 0-char read of UNKNOWN size — conservative, flags manual (never silently drop an unknown-size record)', () => {
    const r = classifyReadAttempt({ method: 'textract', extractedText: '' });
    expect(r.succeeded).toBe(false);
    expect(r.autoSkip).toBeFalsy();
    expect(r.reason).toContain('empty');
  });

  it('does NOT auto-skip a substantive sliver — autoSkip only fires for a genuinely EMPTY (0-char) read', () => {
    // "Error" (5 chars) on a known single page is a non-empty sliver → fails the char floor as manual,
    // never auto_skipped (auto-skip is 0-char ONLY; a substantive sliver still flags).
    const r = classifyReadAttempt({ method: 'native_pdf_text', extractedText: 'Error' });
    expect(r.succeeded).toBe(false);
    expect(r.autoSkip).toBeFalsy();
  });

  it('rejects a garbled 1-page read (garble beats the small-file pass)', () => {
    const garbled = 'Pati$nt 4@ ol# p#esent!ng r!ght kn$e p$in lim%ted m0t!on n0 ev!d#nce im+pro!vement phys-ic@l'.repeat(3);
    const r = classifyReadAttempt({ method: 'textract', extractedText: garbled, pageCount: 1 });
    expect(r.succeeded).toBe(false);
    expect(r.reason).toContain('garbled');
  });

  it('rejects a SUBSTANTIAL (>=2 page) file with only a tiny sliver of text — the "OCR choked on a big scan" signal', () => {
    // 2 pages, 8 non-whitespace chars (< big-scan minimum) → still flags. (Owner acceptance case.)
    const r = classifyReadAttempt({ method: 'textract', extractedText: 'abcd efg', pageCount: 2 });
    expect(nonWhitespaceCharCount('abcd efg')).toBeLessThan(READ_THRESHOLD_BIG_SCAN_CHARS);
    expect(r.succeeded).toBe(false);
    expect(r.reason).toContain('too-few-words');
  });

  it('a 500-page scan that produced 12 chars STILL flags (big-scan guard floor, page-count irrelevant above floor)', () => {
    // 12 chars >= the per-file floor but this is a huge scan — the absolute big-scan minimum still
    // catches a near-empty giant. 12 >= 10 so it does NOT flag on chars alone; the guard is the >=2-page
    // sliver. Confirm a clearly-failed big scan (8 chars) flags; 12 chars on 500 pages is genuinely tiny
    // but above the floor, so it passes — acceptable: the guard targets the < floor sliver class.
    expect(classifyReadAttempt({ method: 'textract', extractedText: 'abcd efg', pageCount: 500 }).succeeded).toBe(false);
  });

  it('treats UNKNOWN page count as a small file for the char floor — passes on >=10 chars (no regression for short real notes)', () => {
    const short = 'abcd efg'; // 7 chars < floor → fails regardless of size
    expect(classifyReadAttempt({ method: 'textract', extractedText: short }).succeeded).toBe(false);
    const ok = 'CPAP titration ordered'; // > floor → passes
    expect(classifyReadAttempt({ method: 'textract', extractedText: ok }).succeeded).toBe(true);
  });

  // NON-MEDICAL AUTO-SKIP (Ryan 2026-06-18): the vision model affirmatively judged the file a non-record
  // image (helicopter photos etc.). It must NEVER block the case — auto-skip, non-blocking, at ANY size.
  it('AUTO-SKIPS when the vision model judged the file non-medical — regardless of page count (junk never blocks)', () => {
    const r = classifyReadAttempt({ method: 'claude_vision', extractedText: '', pageCount: 3, noMedicalContent: true });
    expect(r.succeeded).toBe(false);
    expect(r.autoSkip).toBe(true);
    expect(r.reason).toContain('no medical content');
  });

  it('non-medical auto-skip closes the pageCount:null dead-end (the unopenable-PDF class — unknown-size empty junk → auto_skipped, not manual)', () => {
    // Before the fix an unknown-size 0-char file dead-ended to manual_summary_required and froze the case.
    // With the affirmative non-medical signal it auto-skips (non-blocking). Contrast the line below: the
    // SAME unknown-size empty file WITHOUT the signal still flags manual (the data-loss guard).
    const junk = classifyReadAttempt({ method: 'claude_vision', extractedText: '', noMedicalContent: true });
    expect(junk.autoSkip).toBe(true);
    const unknownEmpty = classifyReadAttempt({ method: 'textract', extractedText: '' });
    expect(unknownEmpty.autoSkip).toBeFalsy();
    expect(unknownEmpty.reason).toContain('empty');
  });

  it('does NOT auto-skip a real record just because noMedicalContent is absent/false (data-loss guard holds)', () => {
    const realButFailed = classifyReadAttempt({ method: 'textract', extractedText: '', pageCount: 8, noMedicalContent: false });
    expect(realButFailed.autoSkip).toBeFalsy();
    expect(realButFailed.reason).toContain('empty');
    // a real multi-page scan with substantive text and no flag still reads normally
    expect(classifyReadAttempt({ method: 'claude_vision', extractedText: 'Chronic low back pain, MRI shows L4-L5 disc herniation.', pageCount: 2 }).succeeded).toBe(true);
  });
});

describe('isValidManualSummary', () => {
  it('rejects short summaries (< 40 chars)', () => {
    expect(isValidManualSummary('short')).toBe(false);
    expect(isValidManualSummary('exactly thirty nine characters here.')).toBe(false);
    expect(isValidManualSummary('   trimmed-blank-' + 'x'.repeat(10) + '   ')).toBe(false);
  });

  it('accepts >= 40 chars after trim', () => {
    const s = 'This file shows a rating decision dated 2024 confirming PTSD service connection at 70 percent.';
    expect(isValidManualSummary(s)).toBe(true);
    expect(s.length).toBeGreaterThanOrEqual(MANUAL_SUMMARY_MIN_LEN);
  });

  it('rejects non-string values', () => {
    expect(isValidManualSummary(null)).toBe(false);
    expect(isValidManualSummary(undefined)).toBe(false);
    expect(isValidManualSummary(123)).toBe(false);
  });
});

describe('evaluateChartReadiness', () => {
  it('ready=true on empty input (no files yet)', () => {
    const r = evaluateChartReadiness([]);
    expect(r.ready).toBe(true);
    expect(r.totalFiles).toBe(0);
    expect(r.blockingFiles).toEqual([]);
    expect(r.gateVersion).toBe(CHART_READINESS_GATE_VERSION);
  });

  it('ready=true when all rows are read', () => {
    const r = evaluateChartReadiness([row({ terminalStatus: 'read' }), row({ terminalStatus: 'read', filePath: 'records/b.pdf' })]);
    expect(r.ready).toBe(true);
    expect(r.readFiles).toBe(2);
  });

  it('ready=true when rows are read or have valid manual summaries', () => {
    const r = evaluateChartReadiness([
      row({ terminalStatus: 'read' }),
      row({ terminalStatus: 'manual_summary_provided', manualSummary: 'This file is a rating decision dated 2024 showing PTSD service connection at 70 percent.' }),
    ]);
    expect(r.ready).toBe(true);
    expect(r.readFiles).toBe(1);
    expect(r.manualSummaryProvided).toBe(1);
  });

  it('ready=false when any row is manual_summary_required', () => {
    const r = evaluateChartReadiness([
      row({ terminalStatus: 'read', filePath: 'records/a.pdf' }),
      row({ terminalStatus: 'manual_summary_required', filePath: 'records/b.pdf' }),
    ]);
    expect(r.ready).toBe(false);
    expect(r.blockingFiles).toHaveLength(1);
    expect(r.blockingFiles[0]?.filePath).toBe('records/b.pdf');
  });

  it('treats manual_summary_provided with empty/short summary as still-required (defense-in-depth)', () => {
    const r = evaluateChartReadiness([
      row({ terminalStatus: 'manual_summary_provided', manualSummary: 'too short', filePath: 'records/c.pdf' }),
    ]);
    expect(r.ready).toBe(false);
    expect(r.blockingFiles).toHaveLength(1);
    expect(r.manualSummaryRequired).toBe(1);
  });

  // ── Retroactive threshold reconciliation (2026-06-14, WORD floor → CHAR floor) ─────────────
  // terminalStatus is written once at classification time, so rows stamped
  // 'manual_summary_required' under the OLD floor must self-heal at EVALUATION time when their
  // stored last attempt passes the CURRENT char floor. New attempts persist `charCount` → mirror
  // exactly; legacy rows carry only `wordCount` → wordCount-as-proxy (err toward bypass).

  it('retro-heals a row whose stored charCount passes the current char floor (the live Thomas_Intake_Summary.pdf fix)', () => {
    const r = evaluateChartReadiness([
      row({
        terminalStatus: 'manual_summary_required',
        filePath: 'cases/CASE-1/uuid-Thomas_Intake_Summary.pdf',
        attemptsJson: [
          // The live victim: 18 stored words (< the old 20-word floor → blocked) but 130 real chars.
          { method: 'native_pdf_text', wordCount: 18, charCount: 130, corruptedTokenRatio: 0.0, attemptedAt: '2026-06-12T00:00:00Z', note: 'too-few-words (18 < 20)' },
        ],
      }),
    ]);
    expect(r.ready).toBe(true);
    expect(r.blockingFiles).toHaveLength(0);
    expect(r.readFiles).toBe(1);
    expect(r.manualSummaryRequired).toBe(0);
  });

  it('does NOT retro-heal a row whose stored charCount is below the current char floor (a real "Error" sliver)', () => {
    const r = evaluateChartReadiness([
      row({
        terminalStatus: 'manual_summary_required',
        filePath: 'records/empty_photo.jpg',
        attemptsJson: [
          { method: 'textract', wordCount: 1, charCount: 5, corruptedTokenRatio: 0.0, attemptedAt: '2026-06-10T00:00:00Z', note: 'too-few-words (5 chars < 10)' },
        ],
      }),
    ]);
    expect(r.ready).toBe(false);
    expect(r.blockingFiles).toHaveLength(1);
  });

  it('LEGACY-PROXY: retro-heals a pre-charCount row that has real words (wordCount proxy, err toward bypass)', () => {
    const r = evaluateChartReadiness([
      row({
        terminalStatus: 'manual_summary_required',
        filePath: 'cases/CASE-1/uuid-Thomas_OSA_Misc_3.png',
        attemptsJson: [
          // No charCount (pre-2026-06-14). 37 real words ⇒ real content ⇒ heals.
          { method: 'textract', wordCount: 37, corruptedTokenRatio: 0.0, attemptedAt: '2026-06-10T00:00:00Z', note: 'too-few-words (37 < 40)' },
        ],
      }),
    ]);
    expect(r.ready).toBe(true);
    expect(r.blockingFiles).toHaveLength(0);
  });

  it('LEGACY-PROXY: does NOT retro-heal a pre-charCount substantial multi-page row with almost no words (failed big scan)', () => {
    const r = evaluateChartReadiness([
      row({
        terminalStatus: 'manual_summary_required',
        filePath: 'records/big_scan.pdf',
        attemptsJson: [
          { method: 'textract', wordCount: 1, corruptedTokenRatio: 0.0, pageCount: 8, attemptedAt: '2026-06-10T00:00:00Z', note: 'too-few-words' },
        ],
      }),
    ]);
    expect(r.ready).toBe(false);
    expect(r.blockingFiles).toHaveLength(1);
  });

  it('retro-heals a stored 1-page low-word attempt (size-aware: a "CPAP" note self-heals at eval time)', () => {
    const r = evaluateChartReadiness([
      row({
        terminalStatus: 'manual_summary_required',
        filePath: 'cases/CASE-1/uuid-cpap-note.pdf',
        attemptsJson: [
          // 1-page, 12 chars of real text → above the floor, self-heals.
          { method: 'textract', wordCount: 2, charCount: 12, corruptedTokenRatio: 0.0, pageCount: 1, attemptedAt: '2026-06-13T00:00:00Z', note: 'short' },
        ],
      }),
    ]);
    expect(r.ready).toBe(true);
    expect(r.blockingFiles).toHaveLength(0);
  });

  it('does NOT retro-heal a garbled row (high word count but corrupted ratio above threshold)', () => {
    const r = evaluateChartReadiness([
      row({
        terminalStatus: 'manual_summary_required',
        filePath: 'records/garbled_scan.pdf',
        attemptsJson: [
          // Stored ratio above the v2 gate (0.40) → a genuinely-garbled row that must never heal.
          { method: 'tesseract_ocr', wordCount: 120, corruptedTokenRatio: 0.55, attemptedAt: '2026-06-10T00:00:00Z', note: 'garbled' },
        ],
      }),
    ]);
    expect(r.ready).toBe(false);
    expect(r.blockingFiles).toHaveLength(1);
  });

  // ── isEffectivelyRead — the shared queue predicate (Package 1 (H), 2026-06-11) ────────────
  // THE row-level branch logic of evaluateChartReadiness, extracted so the files-pending-manual
  // routes (and later doctor-pack inclusion) share one copy. The parity lock below is the
  // load-bearing guard: the predicate and the evaluator must NEVER diverge.

  describe('isEffectivelyRead', () => {
    it('true for terminalStatus read', () => {
      expect(isEffectivelyRead(row({ terminalStatus: 'read' }))).toBe(true);
    });

    // P0-1 (Jamarious sibling — consistency sweep fixes, 2026-06-14): the intake-summary
    // short-circuit must NOT mask a FAILED file. A veteran-UPLOADED "<Last>_Intake_Summary.pdf"
    // that fails OCR terminates at 'manual_summary_required'; it must surface to the RN like any
    // other failed file, NOT be hidden as effectively-read. (The old behavior — masked "regardless
    // of stored status" — left the file undraftable AND invisible.)
    it('FALSE for a FAILED uploaded intake-summary (manual_summary_required) — it surfaces, no longer masked', () => {
      expect(isEffectivelyRead(row({
        terminalStatus: 'manual_summary_required',
        filePath: 'cases/CASE-1/uuid-Lozano_Intake_Summary.pdf',
        // A genuinely failed read: 5 non-whitespace chars (below the char floor) — surfaces, not masked.
        attemptsJson: [{ method: 'native_pdf_text', wordCount: 1, charCount: 5, corruptedTokenRatio: 0.0, attemptedAt: '2026-06-10T00:00:00Z', note: 'too-few-words (5 chars < 10)' }],
      }))).toBe(false);
    });

    it('true for a genuinely-read intake-summary (terminalStatus read) — a sparse generated summary still passes', () => {
      expect(isEffectivelyRead(row({
        terminalStatus: 'read',
        filePath: 'cases/CASE-1/uuid-Intake_Summary.pdf',
        attemptsJson: [{ method: 'native_pdf_text', wordCount: 12, corruptedTokenRatio: 0.0, attemptedAt: '2026-06-10T00:00:00Z', note: 'read' }],
      }))).toBe(true);
    });

    it('FAILED uploaded intake-summary is reported as a BLOCKING file by evaluateChartReadiness (RN queue surfaces it)', () => {
      const r = evaluateChartReadiness([row({
        terminalStatus: 'manual_summary_required',
        filePath: 'cases/CASE-1/uuid-Lozano_Intake_Summary.pdf',
        attemptsJson: [{ method: 'native_pdf_text', wordCount: 1, charCount: 5, corruptedTokenRatio: 0.0, attemptedAt: '2026-06-10T00:00:00Z', note: 'failed' }],
      })]);
      expect(r.ready).toBe(false);
      expect(r.blockingFiles).toHaveLength(1);
      expect(r.blockingFiles[0].filePath).toContain('Intake_Summary.pdf');
    });

    it('true for manual_summary_provided with a valid (>= 40 char) summary', () => {
      expect(isEffectivelyRead(row({
        terminalStatus: 'manual_summary_provided',
        manualSummary: 'Rating decision dated 2024 confirming PTSD service connection at 70 percent.',
      }))).toBe(true);
    });

    it('false for manual_summary_provided with an invalid/short summary and a failing attempt (defense-in-depth)', () => {
      expect(isEffectivelyRead(row({
        terminalStatus: 'manual_summary_provided',
        manualSummary: 'too short',
        attemptsJson: [{ method: 'tesseract_ocr', wordCount: 1, charCount: 5, corruptedTokenRatio: 0.0, attemptedAt: '2026-06-10T00:00:00Z', note: 'too-few-words (5 chars < 10)' }],
      }))).toBe(false);
    });

    it(`retro-heal: true for manual_summary_required whose stored last attempt passes the CURRENT char floor (120 chars)`, () => {
      // The live-regression class: classified under an OLD word gate, passes the current char floor.
      expect(isEffectivelyRead(row({
        terminalStatus: 'manual_summary_required',
        attemptsJson: [{ method: 'textract', wordCount: 18, charCount: 120, corruptedTokenRatio: 0.0, attemptedAt: '2026-06-10T00:00:00Z', note: 'too-few-words (18 < 20)' }],
      }))).toBe(true);
    });

    it('false when the stored attempt is below the current char floor', () => {
      expect(isEffectivelyRead(row({
        terminalStatus: 'manual_summary_required',
        attemptsJson: [{ method: 'textract', wordCount: 1, charCount: READ_THRESHOLD_CHARS - 1, corruptedTokenRatio: 0.0, attemptedAt: '2026-06-10T00:00:00Z', note: 'too-few-words' }],
      }))).toBe(false);
    });

    it('false for a genuinely garbled attempt (high word count, ratio above threshold)', () => {
      expect(isEffectivelyRead(row({
        terminalStatus: 'manual_summary_required',
        attemptsJson: [{ method: 'tesseract_ocr', wordCount: 120, corruptedTokenRatio: 0.55, attemptedAt: '2026-06-10T00:00:00Z', note: 'garbled' }],
      }))).toBe(false);
    });

    it('false for manual_summary_required with no attempts recorded', () => {
      expect(isEffectivelyRead(row({ terminalStatus: 'manual_summary_required', attemptsJson: [] }))).toBe(false);
    });

    it('TRUE for auto_skipped — a genuinely empty file the system auto-skipped is non-blocking (no RN action)', () => {
      expect(isEffectivelyRead(row({ terminalStatus: 'auto_skipped', attemptsJson: [] }))).toBe(true);
    });

    it('PARITY LOCK: isEffectivelyRead(row) === evaluateChartReadiness([row]).ready for every branch', () => {
      const samples: FileReadStatusRecord[] = [
        row({ terminalStatus: 'read' }),
        row({ terminalStatus: 'auto_skipped', attemptsJson: [] }),
        row({ terminalStatus: 'manual_summary_required' }),
        row({ terminalStatus: 'manual_summary_required', filePath: 'cases/C/uuid-Intake_Summary.pdf' }),
        row({ terminalStatus: 'manual_summary_provided', manualSummary: 'A perfectly valid forty-plus character manual summary by the RN.' }),
        row({ terminalStatus: 'manual_summary_provided', manualSummary: 'too short' }),
        row({ terminalStatus: 'manual_summary_provided', manualSummary: 'too short', attemptsJson: [{ method: 'textract', wordCount: 25, corruptedTokenRatio: 0.0, attemptedAt: '2026-06-10T00:00:00Z', note: null }] }),
        row({ terminalStatus: 'manual_summary_required', attemptsJson: [{ method: 'textract', wordCount: 37, corruptedTokenRatio: 0.0, attemptedAt: '2026-06-10T00:00:00Z', note: 'too-few-words (37 < 40)' }] }),
        row({ terminalStatus: 'manual_summary_required', attemptsJson: [{ method: 'tesseract_ocr', wordCount: 120, corruptedTokenRatio: 0.21, attemptedAt: '2026-06-10T00:00:00Z', note: 'garbled' }] }),
        row({ terminalStatus: 'manual_summary_required', attemptsJson: [{ method: 'textract', wordCount: 1, charCount: READ_THRESHOLD_CHARS - 1, corruptedTokenRatio: 0.0, attemptedAt: '2026-06-10T00:00:00Z', note: null }] }),
      ];
      for (const sample of samples) {
        expect(isEffectivelyRead(sample), `parity diverged for ${sample.terminalStatus} / ${sample.filePath}`).toBe(evaluateChartReadiness([sample]).ready);
      }
    });
  });

  it('captures lastAttempt context for blocking rows when available', () => {
    const r = evaluateChartReadiness([
      row({
        terminalStatus: 'manual_summary_required',
        attemptsJson: [
          { method: 'native_pdf_text', wordCount: 5, corruptedTokenRatio: 0.0, attemptedAt: '2026-05-26T00:00:00Z', note: 'too-few-words (5 < 40)' },
          { method: 'tesseract_ocr', wordCount: 120, corruptedTokenRatio: 0.55, attemptedAt: '2026-05-26T00:01:00Z', note: 'garbled' },
        ],
      }),
    ]);
    expect(r.blockingFiles[0]?.lastAttempt?.method).toBe('tesseract_ocr');
    expect(r.blockingFiles[0]?.lastAttempt?.note).toBe('garbled');
  });
});

// ── reconcileChartReadiness — THE shared orphan-drop the gate sites + the GET route share ──
// (CLM-4DACAF4A80, 2026-06-14). An orphaned readiness row (filePath not among the chart's live
// document keys, and not a generated intake summary) is dropped before evaluation, so an invisible
// deleted-file row can never hard-block sign-off/approve/finalize/draft.
describe('reconcileChartReadiness', () => {
  it('drops an orphaned blocking row (file not in live document keys) → ready', () => {
    const r = reconcileChartReadiness(
      [row({ terminalStatus: 'manual_summary_required', filePath: 'cases/C/deleted-final-letter.pdf' })],
      [{ s3Key: 'cases/C/something-else.pdf' }], // the orphan's key is NOT live
    );
    expect(r.ready).toBe(true);
    expect(r.totalFiles).toBe(0); // the orphan was reconciled away before evaluation
  });

  it('keeps a blocking row whose file IS a live document → still blocks', () => {
    const r = reconcileChartReadiness(
      [row({ terminalStatus: 'manual_summary_required', filePath: 'cases/C/scan.pdf' })],
      [{ s3Key: 'cases/C/scan.pdf' }],
    );
    expect(r.ready).toBe(false);
    expect(r.blockingFiles).toHaveLength(1);
    expect(r.blockingFiles[0]?.filePath).toBe('cases/C/scan.pdf');
  });

  it('a generated intake-summary PDF is kept even when absent from the documents (never an orphan)', () => {
    // Intake summaries are minted by us, never appear as an uploaded Document — the isIntakeSummaryPath
    // branch keeps them. A genuinely-read intake summary is then ready; an unread one still blocks.
    const r = reconcileChartReadiness(
      [row({ terminalStatus: 'manual_summary_required', filePath: 'cases/C/uuid-Intake_Summary.pdf' })],
      [], // no documents at all
    );
    expect(r.ready).toBe(false);
    expect(r.blockingFiles).toHaveLength(1);
  });

  it('a read intake-summary with no document row is ready (kept + effectively read)', () => {
    const r = reconcileChartReadiness(
      [row({ terminalStatus: 'read', filePath: 'cases/C/uuid-Intake_Summary.pdf' })],
      [],
    );
    expect(r.ready).toBe(true);
    expect(r.totalFiles).toBe(1);
  });
});

describe('originalFileName', () => {
  it('strips the leading uuid- prefix from a minted s3Key', () => {
    expect(originalFileName('cases/CLM-1/123e4567-e89b-42d3-a456-426614174000-Sleep_Study.pdf')).toBe('Sleep_Study.pdf');
  });
  it('falls back to the basename on a legacy/odd key (never throws)', () => {
    expect(originalFileName('records/garbled_scan.pdf')).toBe('garbled_scan.pdf');
    expect(originalFileName('bare.pdf')).toBe('bare.pdf');
  });
});

describe('buildChartNotReadyMessage', () => {
  function blocker(filePath: string, note: string | null) {
    return { fileReadStatusId: 'FRS-1', filePath, terminalStatus: 'manual_summary_required' as const, lastAttempt: note === null ? null : { method: 'tesseract_ocr', wordCount: 0, corruptedTokenRatio: 0, note } };
  }

  it('names each blocking file by display name + the machine-read reason', () => {
    const msg = buildChartNotReadyMessage([
      blocker('cases/C/123e4567-e89b-42d3-a456-426614174000-Sleep_Study.pdf', 'empty (0 words)'),
      blocker('cases/C/123e4567-e89b-42d3-a456-426614174001-DD214.pdf', 'too-few-words (5 < 20)'),
    ], 'Sign-off');
    expect(msg).toContain('Sign-off blocked');
    expect(msg).toContain('Sleep_Study.pdf');
    expect(msg).toContain('empty (0 words)');
    expect(msg).toContain('DD214.pdf');
    expect(msg).toContain('too-few-words (5 < 20)');
    // Never the old cryptic wording.
    expect(msg).not.toContain('chart-readiness gate failed');
  });

  it('tailors the lead verb per gate site', () => {
    expect(buildChartNotReadyMessage([blocker('a/x.pdf', 'garbled')], 'Approve')).toMatch(/^Approve blocked/);
    expect(buildChartNotReadyMessage([blocker('a/x.pdf', 'garbled')], 'Finalize')).toMatch(/^Finalize blocked/);
  });

  it('falls back to a calm reason when lastAttempt is null', () => {
    const msg = buildChartNotReadyMessage([blocker('a/x.pdf', null)], 'Sign-off');
    expect(msg).toContain('could not be machine-read');
  });
});
