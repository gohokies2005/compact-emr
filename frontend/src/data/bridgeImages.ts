/**
 * Washington State bridge imagery for the Aegis login banner (and, later, the nav scenic rail).
 * Files live in `frontend/public/bridge-rotation/<file>.jpg` and are referenced at runtime by `src`.
 * The owner will supply ~25 WA bridge photos later; this is the seed set (~6). BridgeRotation renders
 * a graceful navy→mist gradient fallback when an image is missing/404s, so a sparse folder never breaks.
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
  {
    id: 'deception-pass',
    name: 'Deception Pass Bridge',
    location: 'Whidbey Island, WA',
    src: '/bridge-rotation/deception-pass.jpg',
    tone: 'misty'
  },
  {
    id: 'tacoma-narrows',
    name: 'Tacoma Narrows Bridge',
    location: 'Tacoma, WA',
    src: '/bridge-rotation/tacoma-narrows.jpg',
    tone: 'overcast'
  },
  {
    id: 'hood-canal',
    name: 'Hood Canal Bridge',
    location: 'Kitsap Peninsula, WA',
    src: '/bridge-rotation/hood-canal.jpg',
    tone: 'misty'
  },
  {
    id: 'evergreen-point',
    name: 'Evergreen Point Floating Bridge',
    location: 'Lake Washington, WA',
    src: '/bridge-rotation/evergreen-point.jpg',
    tone: 'clear'
  },
  {
    id: 'fremont',
    name: 'Fremont Bridge',
    location: 'Seattle, WA',
    src: '/bridge-rotation/fremont.jpg',
    tone: 'dusk'
  },
  {
    id: 'skagit-river',
    name: 'Skagit River Bridge',
    location: 'Mount Vernon, WA',
    src: '/bridge-rotation/skagit-river.jpg',
    tone: 'overcast'
  }
];
