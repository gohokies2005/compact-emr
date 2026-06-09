# Aegis login bridge rotation

Drop Washington State bridge photos here as `<id>.jpg` (cover-cropped, ~1600px wide, serene/misty tone preferred).

The login banner (`src/components/BridgeRotation.tsx`) rotates through the entries listed in
`src/data/bridgeImages.ts` every 5 minutes. Each entry's `src` points at `/bridge-rotation/<id>.jpg`.

Seed entries expect these files:
- `deception-pass.jpg` — Deception Pass Bridge, Whidbey Island
- `tacoma-narrows.jpg` — Tacoma Narrows Bridge, Tacoma
- `hood-canal.jpg` — Hood Canal Bridge, Kitsap Peninsula
- `evergreen-point.jpg` — Evergreen Point Floating Bridge, Lake Washington
- `fremont.jpg` — Fremont Bridge, Seattle
- `skagit-river.jpg` — Skagit River Bridge, Mount Vernon

Missing files degrade gracefully to a calm navy→mist gradient — nothing breaks if a photo is absent.
Add more entries to `bridgeImages.ts` (owner plans ~25 total) and the rotation picks them up automatically.
