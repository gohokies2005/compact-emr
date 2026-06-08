// Loads the vendored sanitizeAnswer() (flatratenexus app/services/advisory/sanitizeAnswer.js) the same
// way realRetrieve loads the vendored retrieve(): the module is CommonJS and is loaded at RUNTIME from the
// copied vendor tree (createRequire with an ABSOLUTE entry — format-agnostic, avoids import.meta.url). The
// sanitizer strips markdown / internal field names / any $50-refund sentence from the model answer before
// it is returned to the EMR (the model still emits these despite the system-prompt rule).
//
// Fail-open: if the vendor module can't be loaded for any reason, we fall back to identity so the answer
// path is NEVER broken by a missing/renamed vendor file. A failed strip is a cosmetic regression, not an
// outage; a thrown loader would be an outage.

import { createRequire } from 'node:module';
import path from 'node:path';

const VENDOR_DIR = process.env.ADVISORY_VENDOR_DIR ?? 'advisory-vendor';

type SanitizeFn = (s: string) => string;

let _sanitize: SanitizeFn | null = null;

function loadVendoredSanitize(): SanitizeFn {
  const req = createRequire(path.join(process.cwd(), '_advisory_require_base.cjs'));
  const entry = path.join(process.cwd(), VENDOR_DIR, 'app', 'services', 'advisory', 'sanitizeAnswer.js');
  const mod = req(entry) as { sanitizeAnswer: SanitizeFn };
  return mod.sanitizeAnswer;
}

// The sanitizer bound for use as an AnswerDeps.sanitize. Lazily loaded on first call (cold-start friendly);
// identity fallback if the vendor module is unavailable.
export const vendoredSanitize: SanitizeFn = (s) => {
  if (_sanitize === null) {
    try {
      _sanitize = loadVendoredSanitize();
    } catch {
      _sanitize = (x) => x; // fail-open: never break the answer on a load error
    }
  }
  return _sanitize(s);
};
