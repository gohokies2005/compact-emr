/**
 * Washington State bridge imagery for the Aegis login banner (and, later, the nav scenic rail).
 * Files live in `frontend/public/bridge-rotation/<id>.png` and are referenced at runtime by `src`.
 * 12 curated AI-treated WA bridges (from ~25 candidates, deduped + quality-graded). The clean wide-hero
 * shots without baked-in captions lead the list so the login's first impression is crisp. BridgeRotation
 * renders a graceful navy→mist gradient fallback when an image is missing/404s, so the set can grow/shrink
 * without breaking.
 */
export interface BridgeImage {
  readonly id: string;
  readonly name: string;
  readonly location: string;
  readonly src: string;
  /** Loose tonal hint for the caption/overlay treatment. */
  readonly tone: 'misty' | 'dusk' | 'clear' | 'overcast';
}

export const bridgeImages: readonly BridgeImage[] = [
  // Clean wide-hero shots (no baked-in caption) — lead the rotation for the login.
  { id: 'evergreen-point', name: 'Evergreen Point Floating Bridge', location: 'Lake Washington, WA', src: '/bridge-rotation/evergreen-point.png', tone: 'clear' },
  { id: 'west-seattle', name: 'West Seattle Bridge', location: 'Seattle, WA', src: '/bridge-rotation/west-seattle.png', tone: 'overcast' },
  { id: 'homer-hadley', name: 'Homer M. Hadley Memorial Bridge', location: 'Mercer Island, WA', src: '/bridge-rotation/homer-hadley.png', tone: 'clear' },
  { id: 'manette', name: 'Manette Bridge', location: 'Bremerton, WA', src: '/bridge-rotation/manette.png', tone: 'dusk' },
  // Mood pieces.
  { id: 'deception-pass', name: 'Deception Pass Bridge', location: 'Whidbey Island, WA', src: '/bridge-rotation/deception-pass.png', tone: 'misty' },
  { id: 'hood-canal', name: 'Hood Canal Bridge', location: 'Hood Canal, WA', src: '/bridge-rotation/hood-canal.png', tone: 'misty' },
  { id: 'tacoma-narrows', name: 'Tacoma Narrows Bridge', location: 'Tacoma, WA', src: '/bridge-rotation/tacoma-narrows.png', tone: 'overcast' },
  { id: 'island-crest', name: 'Island Crest Way Bridge', location: 'Mercer Island, WA', src: '/bridge-rotation/island-crest.png', tone: 'misty' },
  { id: 'montlake', name: 'Montlake Bridge', location: 'Seattle, WA', src: '/bridge-rotation/montlake.png', tone: 'misty' },
  { id: 'fremont', name: 'Fremont Bridge', location: 'Seattle, WA', src: '/bridge-rotation/fremont.png', tone: 'overcast' },
  { id: 'ballard', name: 'Ballard Bridge', location: 'Seattle, WA', src: '/bridge-rotation/ballard.png', tone: 'dusk' },
  { id: 'skagit-river', name: 'Skagit River Bridge', location: 'Mount Vernon, WA', src: '/bridge-rotation/skagit-river.png', tone: 'misty' }
];
