import { useEffect, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { bridgeImages } from '../data/bridgeImages';

const ROTATE_MS = 5 * 60 * 1000; // rotate every 5 minutes

/**
 * Serene rotating banner of Washington State bridges for the Aegis login splash
 * (and, later, a nav scenic rail). Rotation is driven by a useState index advanced
 * on a useEffect interval — never an inline Date.now() read. Renders the photo as a
 * cover image with a calm lower-corner caption; if the image is missing/404s it falls
 * back to a quiet navy→mist gradient so the layout never breaks.
 *
 * Visual-only: no data, no navigation, no side effects beyond the rotation timer.
 */
export function BridgeRotation({
  children,
  className,
  caption = true
}: {
  readonly children?: ReactNode;
  readonly className?: string;
  readonly caption?: boolean;
}) {
  // Start on a random bridge each mount so every visit shows a different one (a login is seen far
  // shorter than the 5-min interval, so a fixed start would only ever show the first image).
  const [index, setIndex] = useState(() =>
    bridgeImages.length > 0 ? Math.floor(Math.random() * bridgeImages.length) : 0
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (bridgeImages.length <= 1) return;
    const timer = setInterval(() => {
      setFailed(false);
      setIndex((current) => (current + 1) % bridgeImages.length);
    }, ROTATE_MS);
    return () => clearInterval(timer);
  }, []);

  const bridge = bridgeImages[index];
  const showImage = bridge && !failed;

  return (
    <div className={clsx('relative h-full w-full overflow-hidden bg-navyDeep', className)}>
      {/* Graceful fallback gradient — always present, sits behind the photo. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-b from-navyDeep via-navy to-mist"
      />
      {showImage ? (
        <img
          src={bridge.src}
          alt={`${bridge.name}, ${bridge.location}`}
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : null}

      {/* Soft bottom scrim — eases caption legibility + calms any text baked into the source art. */}
      <div
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/45 to-transparent"
      />

      {/* Overlay content (e.g. the login tagline) rendered above the imagery. */}
      {children ? <div className="relative h-full w-full">{children}</div> : null}

      {/* Calm caption: bridge name + location, lower-left. Suppressed on ambient surfaces (caption={false}). */}
      {caption && bridge ? (
        <div className="absolute bottom-5 left-5 z-10 rounded-xl bg-slate-950/35 px-4 py-2.5 backdrop-blur-md">
          <div className="text-sm font-medium tracking-wide text-white/95">{bridge.name}</div>
          <div className="text-xs text-white/70">{bridge.location}</div>
        </div>
      ) : null}
    </div>
  );
}
