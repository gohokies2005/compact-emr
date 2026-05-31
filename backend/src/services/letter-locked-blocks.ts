// Single source of truth for the letter's locked fragments — the sentences that must survive an
// edit verbatim. Consumed by letter-sanity (warn/lock + locked-range computation) and
// letter-edit-apply (refuse edits that delete a locked block). Previously duplicated in three
// places (letter-sanity, letter-edit-apply, and the surgical-AI prompt), which drifts.
//
// D2 NOTE: the Section I credential fragment is currently the hardcoded "Ryan J. Kasky, DO"
// sentence. Per-signer credentials (D2) will replace it with a [[SIGNER_CREDENTIALS]] sentinel;
// keeping ONE definition makes that a single edit instead of three.
export interface LockedFragment {
  readonly frag: string;
  readonly label: string;
}

export const LOCKED_FRAGMENTS: readonly LockedFragment[] = [
  { frag: 'I, Ryan J. Kasky, DO, am board-certified', label: 'Section I — physician credentials' },
  { frag: 'Nieves-Rodriguez v. Peake', label: 'Section II — Nieves-Rodriguez methodology' },
  { frag: 'I have no treatment relationship with this veteran', label: 'Section I — no treatment relationship' },
];

export const LOCKED_FRAGMENT_STRINGS: readonly string[] = LOCKED_FRAGMENTS.map((f) => f.frag);
