/**
 * Washington State bridge imagery for the Aegis login splash + the dashboard ambient band.
 * Files live in `frontend/public/bridge-rotation/<id>.png`, referenced at runtime by `src`.
 * 5 curated caption-free 16:9 misty Puget Sound shots (purpose-fit — no baked-in text, so the app's own
 * caption is the only label). BridgeRotation starts on a random image each mount + falls back to a
 * navy→mist gradient if a file is missing, so the set can grow/shrink without breaking.
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
  { id: 'murray-morgan', name: 'Murray Morgan Bridge', location: 'Tacoma, WA', src: '/bridge-rotation/murray-morgan.png', tone: 'dusk' },
  { id: 'manette', name: 'Manette Bridge', location: 'Bremerton, WA', src: '/bridge-rotation/manette.png', tone: 'misty' },
  { id: 'hood-canal', name: 'Hood Canal Bridge', location: 'Hood Canal, WA', src: '/bridge-rotation/hood-canal.png', tone: 'overcast' },
  { id: 'aurora', name: 'Aurora Bridge', location: 'Seattle, WA', src: '/bridge-rotation/aurora.png', tone: 'misty' },
  { id: 'evergreen-point', name: 'Evergreen Point Floating Bridge', location: 'Lake Washington, WA', src: '/bridge-rotation/evergreen-point.png', tone: 'overcast' }
];
