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
  /**
   * Where an overlay text bubble (e.g. the login motto) should sit on THIS image so it lands over
   * a calm/dark area of water or sky rather than over the bridge span or towers. Per-image, since
   * the span sits at a different place in each shot. Consumers (SignInScreen) map this to a
   * horizontal alignment of the bubble. Defaults to 'left' if absent.
   */
  readonly textAnchor?: 'left' | 'right' | 'center';
}

export const bridgeImages: readonly BridgeImage[] = [
  // Span crosses full-width through the middle with two towers center-L/center-R; cleanest dark
  // calm zone is the lower water on the RIGHT, away from the towers.
  { id: 'murray-morgan', name: 'Murray Morgan Bridge', location: 'Tacoma, WA', src: '/bridge-rotation/murray-morgan.png', tone: 'dusk', textAnchor: 'right' },
  // Low arch sits HIGH in the frame; a wide calm expanse of dark water fills the lower-center.
  { id: 'manette', name: 'Manette Bridge', location: 'Bremerton, WA', src: '/bridge-rotation/manette.png', tone: 'misty', textAnchor: 'center' },
  // Two towers center, tall fir on the right edge; the LEFT side (dark hillside town + water) is clear.
  { id: 'hood-canal', name: 'Hood Canal Bridge', location: 'Hood Canal, WA', src: '/bridge-rotation/hood-canal.png', tone: 'overcast', textAnchor: 'left' },
  // Heavy steel arch loads the left + center; open calm water on the RIGHT is the clear zone.
  { id: 'aurora', name: 'Aurora Bridge', location: 'Seattle, WA', src: '/bridge-rotation/aurora.png', tone: 'misty', textAnchor: 'right' },
  // Long pier-line bridge weighted center-right; dark sky/hill + foreground firs make the LEFT calm.
  { id: 'evergreen-point', name: 'Evergreen Point Floating Bridge', location: 'Lake Washington, WA', src: '/bridge-rotation/evergreen-point.png', tone: 'overcast', textAnchor: 'left' }
];
